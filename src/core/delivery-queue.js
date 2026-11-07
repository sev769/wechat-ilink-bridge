import { WxbError } from "./errors.js";
import { chunkText } from "./chunk-text.js";
import { generateClientId, pickServerMessageId } from "./ilink-client.js";
import { appendMessageHistory } from "../state/message-history.js";
import { recordTokenSend, resolveContextToken } from "../state/context-token-store.js";
import { cacheQuoteSummaries, summarizeForQuoteCache } from "../state/quote-cache-store.js";
import {
  enqueueDelivery,
  readDeliveryQueue,
  removeQueuedDelivery,
  updateQueuedDelivery
} from "../state/delivery-queue-store.js";

function publicQueueItem(item, now = Date.now()) {
  const createdAtMs = Date.parse(item.createdAt);
  return {
    id: item.id,
    userId: item.userId,
    chars: item.text.length,
    createdAt: item.createdAt,
    ageSeconds: Number.isFinite(createdAtMs) ? Math.max(0, Math.floor((now - createdAtMs) / 1000)) : undefined,
    attempts: item.attempts,
    source: item.source,
    status: item.blocked ? "blocked" : (item.attempts ?? 0) > 0 ? "retrying" : "pending",
    ...(item.clientId ? { clientId: item.clientId } : {}),
    ...(item.blocked ? { blocked: item.blocked } : {}),
    ...(item.lastAttemptAt ? { lastAttemptAt: item.lastAttemptAt } : {}),
    ...(item.lastError ? { lastError: item.lastError } : {})
  };
}

export async function queueTextDelivery(options = {}) {
  const {
    stateDir,
    accountId,
    userId,
    text,
    source = "send",
    error,
    maxItems,
    lock
  } = options;

  if (!stateDir || !accountId) {
    throw new TypeError("stateDir and accountId are required");
  }

  if (!userId) {
    throw new WxbError("TARGET_USER_REQUIRED", "A target user ID is required.", {
      retryable: false
    });
  }

  const item = await enqueueDelivery(stateDir, accountId, {
    userId,
    text,
    source,
    // A stable client id is assigned at enqueue time so that a later flush
    // or manual retry re-sends with the same idempotency key instead of
    // minting a fresh one per attempt.
    clientId: generateClientId(),
    lastError: error
      ? {
        code: error.code ?? "UNKNOWN_ERROR",
        message: error.message ?? String(error),
        ...(error.details ? { details: error.details } : {})
      }
      : undefined
  }, {
    maxItems,
    lock
  });

  return publicQueueItem(item);
}

export async function listQueuedDeliveries(stateDir, accountId) {
  const items = await readDeliveryQueue(stateDir, accountId);
  return items.map(publicQueueItem);
}

function stripSecretError(error) {
  return {
    code: error.code ?? "UNKNOWN_ERROR",
    message: error.message ?? String(error),
    retryable: Boolean(error.retryable)
  };
}

export async function flushOneQueuedDeliveryForUser(options = {}) {
  const {
    stateDir,
    account,
    userId,
    contextToken,
    client,
    config = {},
    timeoutMs = config.fetchTimeoutMs
  } = options;

  if (!stateDir || !account?.accountId || !client) {
    throw new TypeError("stateDir, account, and client are required");
  }

  const queue = await readDeliveryQueue(stateDir, account.accountId);
  const item = queue.find((entry) => entry.userId === String(userId));

  if (!item) {
    return {
      status: "none",
      userId: String(userId)
    };
  }

  // Items blocked by a dead session are not retried automatically; the
  // block is lifted when a fresh inbound message proves the session is
  // alive again (see clearQueuedDeliveryBlock), or by a forced manual
  // retry after re-login.
  if (item.blocked) {
    return {
      status: "skipped",
      userId: String(userId),
      queueId: item.id,
      reason: item.blocked
    };
  }

  if (!contextToken) {
    return {
      status: "skipped",
      userId: String(userId),
      queueId: item.id,
      reason: "NO_CONTEXT_TOKEN"
    };
  }

  return flushQueuedDeliveryItem({
    stateDir,
    account,
    item,
    contextToken,
    client,
    config,
    timeoutMs
  });
}

export async function flushQueuedDeliveryItem(options = {}) {
  const {
    stateDir,
    account,
    item,
    contextToken,
    client,
    config = {},
    timeoutMs = config.fetchTimeoutMs
  } = options;

  if (!stateDir || !account?.accountId || !item?.id || !client) {
    throw new TypeError("stateDir, account, item, and client are required");
  }

  // Guarantee a stable idempotency key before the first attempt so retries
  // of this item (automatic or manual) reuse the same client ids.
  let baseClientId = item.clientId;
  if (!baseClientId) {
    baseClientId = generateClientId();
    await updateQueuedDelivery(stateDir, account.accountId, item.id, (current) => ({
      ...current,
      clientId: baseClientId
    }), { lock: false });
  }

  const chunks = chunkText(item.text, {
    minChunkChars: config.minChunkChars,
    maxChunkChars: config.maxChunkChars,
    maxMessages: config.maxDeliveryMessages
  });
  const sent = [];
  const startedAt = Math.floor(Date.now() / 1000);

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const text = chunks[index];
      const clientId = index === 0 ? baseClientId : `${baseClientId}-${index + 1}`;
      const sendResponse = await client.sendTextMessage({
        token: account.token,
        toUserId: item.userId,
        text,
        contextToken,
        clientId,
        timeoutMs
      });

      await recordTokenSend(stateDir, account.accountId, contextToken, 1, { lock: false });

      const serverMessageId = pickServerMessageId(sendResponse, clientId);
      if (serverMessageId) {
        await cacheQuoteSummaries(stateDir, account.accountId, [summarizeForQuoteCache({
          id: serverMessageId,
          direction: "outgoing",
          fromUserId: account.ownerUserId,
          type: "text",
          text,
          timestamp: startedAt
        }, "outgoing")], { lock: false });
      }

      await appendMessageHistory(stateDir, account.accountId, {
        id: clientId,
        ...(serverMessageId ? { serverMessageId } : {}),
        direction: "outgoing",
        fromUserId: account.ownerUserId,
        toUserId: item.userId,
        timestamp: startedAt,
        type: "text",
        text,
        contextToken,
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        delayedDeliveryId: item.id
      });

      sent.push({
        clientId,
        ...(serverMessageId ? { serverMessageId } : {}),
        chunkIndex: index + 1,
        chars: text.length
      });
    }

    await removeQueuedDelivery(stateDir, account.accountId, item.id, { lock: false });
    return {
      status: "sent",
      userId: item.userId,
      queueId: item.id,
      chunkCount: chunks.length,
      sent
    };
  } catch (error) {
    const stripped = stripSecretError(error);
    await updateQueuedDelivery(stateDir, account.accountId, item.id, (current) => ({
      ...current,
      attempts: (current.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      lastError: stripped,
      // A SESSION_EXPIRED failure blocks automatic retries of this item
      // until a fresh inbound message (or a forced manual retry) proves
      // the session is alive again.
      ...(stripped.code === "SESSION_EXPIRED" ? { blocked: "SESSION_EXPIRED" } : {})
    }), { lock: false });

    return {
      status: "failed",
      userId: item.userId,
      queueId: item.id,
      error: stripped
    };
  }
}

// Manual, operator-driven retry of one queued item by id. Uses the cached
// context token for the item's user and the item's stable client id, so
// re-sending is idempotent. Items whose session died (SESSION_EXPIRED)
// are refused unless force is set — the expected flow is to re-login
// first, after which the next inbound message lifts the block and the
// automatic flush delivers the item.
export async function retryQueuedDeliveryById(options = {}) {
  const {
    stateDir,
    account,
    queueId,
    client,
    config = {},
    timeoutMs = config.fetchTimeoutMs,
    force = false
  } = options;

  if (!stateDir || !account?.accountId || !client) {
    throw new TypeError("stateDir, account, and client are required");
  }

  const queue = await readDeliveryQueue(stateDir, account.accountId);
  const item = queue.find((entry) => entry.id === String(queueId));

  if (!item) {
    throw new WxbError("QUEUE_ITEM_NOT_FOUND", `No queued delivery with id: ${queueId}`, {
      retryable: false,
      details: { queueId: String(queueId) }
    });
  }

  const sessionBlocked = item.blocked === "SESSION_EXPIRED" || item.lastError?.code === "SESSION_EXPIRED";
  if (sessionBlocked && !force) {
    throw new WxbError("QUEUE_ITEM_SESSION_EXPIRED", "This queued delivery belongs to an expired login session. Re-login first; the next inbound message will then flush it automatically. Use --force to retry anyway.", {
      retryable: false,
      details: { queueId: item.id, userId: item.userId }
    });
  }

  if (item.blocked && force) {
    await updateQueuedDelivery(stateDir, account.accountId, item.id, (current) => {
      const { blocked, ...rest } = current;
      return rest;
    }, { lock: false });
    delete item.blocked;
  }

  const contextToken = await resolveContextToken(stateDir, account.accountId, item.userId);
  if (!contextToken) {
    return {
      status: "skipped",
      userId: item.userId,
      queueId: item.id,
      reason: "NO_CONTEXT_TOKEN"
    };
  }

  return flushQueuedDeliveryItem({
    stateDir,
    account,
    item,
    contextToken,
    client,
    config,
    timeoutMs
  });
}

export async function discardQueuedDelivery(stateDir, accountId, queueId) {
  const queue = await readDeliveryQueue(stateDir, accountId);
  const item = queue.find((entry) => entry.id === String(queueId));

  if (!item) {
    throw new WxbError("QUEUE_ITEM_NOT_FOUND", `No queued delivery with id: ${queueId}`, {
      retryable: false,
      details: { queueId: String(queueId) }
    });
  }

  await removeQueuedDelivery(stateDir, accountId, item.id);
  return publicQueueItem(item);
}
