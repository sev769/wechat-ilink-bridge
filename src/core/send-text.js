import { WxbError } from "./errors.js";
import { generateClientId, IlinkClient, maybeCaptureRawSendResponse, pickServerMessageId } from "./ilink-client.js";
import { chunkText } from "./chunk-text.js";
import { listAccounts } from "../state/account-store.js";
import { resolveAlias } from "../state/alias-store.js";
import {
  describeContextToken,
  getTokenSendCount,
  recordTokenSend,
  resolveContextToken,
  resolveContextTokenSendQuota
} from "../state/context-token-store.js";
import { appendMessageHistory } from "../state/message-history.js";
import { cacheQuoteSummaries, summarizeForQuoteCache } from "../state/quote-cache-store.js";
import { withAccountLock } from "../state/lock.js";
import { queueTextDelivery } from "./delivery-queue.js";
import { withOptionalTyping } from "./typing.js";

export async function resolveSendAccount(stateDir, accountId) {
  const accounts = await listAccounts(stateDir, { includeSecrets: true });

  if (accountId) {
    const account = accounts.find((entry) => entry.accountId === accountId);
    if (!account) {
      throw new WxbError("ACCOUNT_NOT_FOUND", `Account not found: ${accountId}`, {
        retryable: false,
        details: { accountId }
      });
    }
    return account;
  }

  if (accounts.length === 0) {
    throw new WxbError("NO_ACCOUNT", "No iLink account is saved; run wxb login first.", {
      retryable: false
    });
  }

  if (accounts.length > 1) {
    throw new WxbError("ACCOUNT_REQUIRED", "Multiple iLink accounts are saved; pass --account <id>.", {
      retryable: false,
      details: { accountIds: accounts.map((account) => account.accountId) }
    });
  }

  return accounts[0];
}

export function resolveTargetUser(userId) {
  if (!userId || typeof userId !== "string") {
    throw new WxbError("TARGET_USER_REQUIRED", "A target user ID is required.", {
      retryable: false
    });
  }

  return userId;
}

export async function resolveTargetUserOrAlias(stateDir, options = {}) {
  if (options.alias) {
    const matches = await resolveAlias(stateDir, String(options.alias));

    if (!matches?.length) {
      throw new WxbError("ALIAS_NOT_FOUND", `Alias not found: ${options.alias}`, {
        retryable: false,
        details: { alias: options.alias }
      });
    }

    if (matches.length > 1) {
      throw new WxbError("ALIAS_AMBIGUOUS", `Alias resolves to multiple users: ${options.alias}`, {
        retryable: false,
        details: { alias: options.alias, userIds: matches }
      });
    }

    return matches[0];
  }

  return resolveTargetUser(options.userId);
}

// Attach token provenance (source + age in seconds, when the bridge has a
// record of the token) to context-token errors so the operator can tell at
// a glance whether to wait for a fresh inbound message or re-login.
export async function annotateContextTokenError(error, { stateDir, accountId, userId, tokenValue }) {
  if (!(error instanceof WxbError)) {
    return error;
  }
  if (error.code !== "INVALID_CONTEXT_TOKEN" && error.code !== "NO_CONTEXT_TOKEN") {
    return error;
  }

  const info = await describeContextToken(stateDir, accountId, userId, tokenValue).catch(() => undefined);
  return new WxbError(error.code, error.message, {
    retryable: error.retryable,
    status: error.status,
    details: {
      ...(error.details ?? {}),
      tokenSource: info?.source ?? (tokenValue ? "explicit" : "none"),
      ...(info?.ageSeconds !== undefined ? { tokenAgeSeconds: info.ageSeconds } : {})
    }
  });
}

export async function sendText(options = {}) {
  const {
    stateDir,
    accountId,
    userId,
    text,
    config = {},
    client: providedClient,
    timeoutMs = config.fetchTimeoutMs,
    chunkOptions = {},
    queueOnInvalidContext = true,
    queueOnNoContext = false,
    typing = false
  } = options;

  if (!stateDir) {
    throw new TypeError("stateDir is required");
  }

  const targetUserId = await resolveTargetUserOrAlias(stateDir, {
    userId,
    alias: options.alias
  });
  const account = await resolveSendAccount(stateDir, accountId);
  const chunks = chunkText(text, {
    minChunkChars: config.minChunkChars,
    maxChunkChars: config.maxChunkChars,
    maxMessages: config.maxDeliveryMessages,
    ...chunkOptions
  });
  const client = providedClient ?? new IlinkClient({
    baseUrl: account.baseUrl ?? config.baseUrl,
    channelVersion: config.channelVersion
  });

  return withAccountLock(stateDir, account.accountId, async () => {
    const contextToken = await resolveContextToken(stateDir, account.accountId, targetUserId);
    if (!contextToken) {
      if (queueOnNoContext) {
        const queued = await queueTextDelivery({
          stateDir,
          accountId: account.accountId,
          userId: targetUserId,
          text,
          source: "no_context",
          maxItems: config.delayedQueueMaxItems,
          lock: false
        });

        return {
          accountId: account.accountId,
          toUserId: targetUserId,
          delivered: false,
          queued: true,
          queue: queued
        };
      }

      throw new WxbError("NO_CONTEXT_TOKEN", "No context token is cached for this user; fetch an inbound message first.", {
        retryable: false,
        details: {
          accountId: account.accountId,
          userId: targetUserId,
          tokenSource: "none"
        }
      });
    }

    return withOptionalTyping({
      enabled: typing,
      client,
      token: account.token,
      stateDir,
      accountId: account.accountId,
      userId: targetUserId,
      contextToken,
      timeoutMs
    }, async (activeContextToken) => {
      const quotaLimit = resolveContextTokenSendQuota(config);
      let quotaUsed = await getTokenSendCount(stateDir, account.accountId, activeContextToken);
      const remainingBefore = Math.max(0, quotaLimit - quotaUsed);
      let sendChunks = chunks;

      if (chunks.length > remainingBefore) {
        // Re-chunk the full text with boundary cuts effectively disabled
        // (minChunkChars == the per-message cap), which yields the minimum
        // possible message count under the cap. If even that does not fit
        // the remaining quota, the whole delivery is queued instead of
        // being sent halfway into the server-side quota wall.
        const maxChunkChars = chunkOptions.maxChunkChars ?? config.maxChunkChars ?? 3800;
        let packed = null;
        if (remainingBefore > 0) {
          try {
            const repacked = chunkText(text, {
              maxChunkChars,
              minChunkChars: maxChunkChars,
              maxMessages: remainingBefore
            });
            if (repacked.length <= remainingBefore) {
              packed = repacked;
            }
          } catch {
            packed = null;
          }
        }

        if (packed) {
          sendChunks = packed;
        } else if (queueOnInvalidContext) {
          const queued = await queueTextDelivery({
            stateDir,
            accountId: account.accountId,
            userId: targetUserId,
            text,
            source: "quota_exhausted",
            maxItems: config.delayedQueueMaxItems,
            lock: false
          });

          return {
            accountId: account.accountId,
            toUserId: targetUserId,
            delivered: false,
            queued: true,
            reason: "quota_exhausted",
            quota: {
              limit: quotaLimit,
              used: quotaUsed,
              remaining: remainingBefore
            },
            queue: queued
          };
        } else {
          throw new WxbError("CONTEXT_TOKEN_QUOTA_EXHAUSTED", "The cached context token has no send quota left for this delivery; ask the user to send a new message to refresh it.", {
            retryable: false,
            details: {
              accountId: account.accountId,
              userId: targetUserId,
              quotaLimit,
              quotaUsed,
              chunks: chunks.length
            }
          });
        }
      }

      const sent = [];
      const startedAt = Math.floor(Date.now() / 1000);

      for (let index = 0; index < sendChunks.length; index += 1) {
        const chunk = sendChunks[index];
        const clientId = generateClientId();
        let sendResponse;

        try {
          sendResponse = await client.sendTextMessage({
            token: account.token,
            toUserId: targetUserId,
            text: chunk,
            contextToken: activeContextToken,
            clientId,
            timeoutMs
          });
        } catch (error) {
          if (!(error instanceof WxbError)) {
            throw error;
          }

          const annotatedError = await annotateContextTokenError(error, {
            stateDir,
            accountId: account.accountId,
            userId: targetUserId,
            tokenValue: activeContextToken
          });

          if (queueOnInvalidContext && annotatedError.code === "INVALID_CONTEXT_TOKEN" && sent.length === 0) {
            const queued = await queueTextDelivery({
              stateDir,
              accountId: account.accountId,
              userId: targetUserId,
              text,
              source: "invalid_context",
              error: annotatedError,
              maxItems: config.delayedQueueMaxItems,
              lock: false
            });

            return {
              accountId: account.accountId,
              toUserId: targetUserId,
              delivered: false,
              queued: true,
              queue: queued
            };
          }

          throw new WxbError(annotatedError.code, annotatedError.message, {
            retryable: annotatedError.retryable,
            status: annotatedError.status,
            details: {
              ...(annotatedError.details ?? {}),
              sentCount: sent.length,
              failedChunkIndex: sent.length + 1,
              totalChunks: sendChunks.length
            }
          });
        }

        // The server accepted this chunk against the active context token;
        // count it even if the local history write below fails.
        quotaUsed = (await recordTokenSend(stateDir, account.accountId, activeContextToken, 1, { lock: false })) ?? (quotaUsed + 1);

        // Record the server-assigned message id (when the send response
        // carries one) in the quote cache so a later ref_msg pointing at
        // this chunk can be resolved back to its text.
        await maybeCaptureRawSendResponse(stateDir, { kind: "sendText", clientId, response: sendResponse });
        const serverMessageId = pickServerMessageId(sendResponse, clientId);
        if (serverMessageId) {
          await cacheQuoteSummaries(stateDir, account.accountId, [summarizeForQuoteCache({
            id: serverMessageId,
            direction: "outgoing",
            fromUserId: account.ownerUserId,
            type: "text",
            text: chunk,
            timestamp: startedAt
          }, "outgoing")], { lock: false });
        }

        const entry = {
          id: clientId,
          ...(serverMessageId ? { serverMessageId } : {}),
          direction: "outgoing",
          fromUserId: account.ownerUserId,
          toUserId: targetUserId,
          timestamp: startedAt,
          type: "text",
          text: chunk,
          contextToken: activeContextToken,
          chunkIndex: index + 1,
          chunkCount: sendChunks.length
        };
        const sentItem = {
          clientId: entry.id,
          ...(serverMessageId ? { serverMessageId } : {}),
          chunkIndex: entry.chunkIndex,
          chars: chunk.length
        };

        try {
          await appendMessageHistory(stateDir, account.accountId, entry);
        } catch (error) {
          throw new WxbError("OUTGOING_HISTORY_WRITE_FAILED", "Message was sent but local outgoing history could not be written.", {
            retryable: false,
            details: {
              delivered: true,
              sentCount: sent.length + 1,
              failedChunkIndex: entry.chunkIndex,
              totalChunks: sendChunks.length,
              clientId: entry.id,
              deliveredClientIds: [...sent.map((item) => item.clientId), entry.id],
              cause: error?.message ?? String(error)
            }
          });
        }

        sent.push(sentItem);
      }

      return {
        accountId: account.accountId,
        toUserId: targetUserId,
        chunkCount: sendChunks.length,
        ...(sendChunks !== chunks ? { packedFromChunks: chunks.length } : {}),
        quota: {
          limit: quotaLimit,
          used: quotaUsed,
          remaining: Math.max(0, quotaLimit - quotaUsed)
        },
        sent
      };
    });
  });
}
