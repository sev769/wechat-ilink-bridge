import { accountStatePath, ensureStateDir } from "./state-dir.js";
import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import { withAccountLock } from "./lock.js";

// Local cache of message summaries keyed by server message id, used to
// restore quoted (referenced) messages: iLink delivers only the quoted
// message's server msg_id in ref_msg, never its content, so the original
// can only be recovered from messages this bridge has already seen.
// Retention mirrors the official plugin's quote cache: 30 days, at most
// 10000 entries. Only text messages keep their (truncated) text; media
// messages keep just kind/fileName placeholders.
export const QUOTE_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const QUOTE_CACHE_MAX_ENTRIES = 10000;
export const QUOTE_CACHE_TEXT_LIMIT = 500;

export function quoteCacheFilePath(stateDir, accountId) {
  return accountStatePath(stateDir, accountId, ".quote-cache.json");
}

export async function readQuoteCache(stateDir, accountId) {
  const raw = await readJsonFile(quoteCacheFilePath(stateDir, accountId), {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export async function writeQuoteCache(stateDir, accountId, cache) {
  await ensureStateDir(stateDir);
  await writeJsonAtomic(quoteCacheFilePath(stateDir, accountId), cache ?? {});
}

function truncateText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  return text.length > QUOTE_CACHE_TEXT_LIMIT ? text.slice(0, QUOTE_CACHE_TEXT_LIMIT) : text;
}

// Build a cache summary from a normalized inbound message or an outgoing
// send descriptor. Returns undefined when there is no usable server id.
export function summarizeForQuoteCache(message, direction) {
  const id = message?.id ?? message?.serverMessageId;
  if (!id) {
    return undefined;
  }

  const kind = message.type ?? message.kind ?? "unknown";
  const mediaItem = (message.items ?? []).find((item) => item.metadata?.fileName);
  const fileName = message.fileName
    ?? message.attachment?.fileName
    ?? mediaItem?.metadata?.fileName;

  return {
    id: String(id),
    summary: {
      direction: direction ?? message.direction ?? "incoming",
      fromUserId: message.fromUserId,
      kind,
      ...(kind === "text" ? { text: truncateText(message.text) } : {}),
      ...(kind !== "text" && fileName ? { fileName } : {}),
      timestamp: message.timestamp,
      cachedAt: Date.now()
    }
  };
}

function pruneCache(cache, now = Date.now()) {
  const entries = Object.entries(cache ?? {})
    .filter(([, summary]) => summary && typeof summary === "object")
    .filter(([, summary]) => {
      const cachedAt = Number(summary.cachedAt ?? 0);
      return !Number.isFinite(cachedAt) || cachedAt === 0 || now - cachedAt <= QUOTE_CACHE_RETENTION_MS;
    })
    .sort((a, b) => Number(a[1].cachedAt ?? 0) - Number(b[1].cachedAt ?? 0));

  const trimmed = entries.length > QUOTE_CACHE_MAX_ENTRIES
    ? entries.slice(entries.length - QUOTE_CACHE_MAX_ENTRIES)
    : entries;

  return Object.fromEntries(trimmed);
}

async function cacheQuoteSummariesUnlocked(stateDir, accountId, summaries) {
  const cache = await readQuoteCache(stateDir, accountId);
  for (const entry of summaries) {
    if (entry?.id && entry.summary) {
      cache[entry.id] = entry.summary;
    }
  }
  await writeQuoteCache(stateDir, accountId, pruneCache(cache));
}

export async function cacheQuoteSummaries(stateDir, accountId, summaries, options = {}) {
  const list = (summaries ?? []).filter((entry) => entry?.id && entry.summary);
  if (list.length === 0) {
    return;
  }

  if (options.lock === false) {
    await cacheQuoteSummariesUnlocked(stateDir, accountId, list);
    return;
  }

  await withAccountLock(stateDir, accountId, () => cacheQuoteSummariesUnlocked(stateDir, accountId, list));
}

export async function getQuoteSummary(stateDir, accountId, serverMessageId) {
  if (!serverMessageId) {
    return undefined;
  }
  const cache = await readQuoteCache(stateDir, accountId);
  const summary = cache[String(serverMessageId)];
  if (!summary) {
    return undefined;
  }

  const cachedAt = Number(summary.cachedAt ?? 0);
  if (Number.isFinite(cachedAt) && cachedAt > 0 && Date.now() - cachedAt > QUOTE_CACHE_RETENTION_MS) {
    return undefined;
  }

  return {
    messageId: String(serverMessageId),
    direction: summary.direction,
    fromUserId: summary.fromUserId,
    kind: summary.kind,
    ...(summary.text ? { text: summary.text } : {}),
    ...(summary.fileName ? { fileName: summary.fileName } : {}),
    timestamp: summary.timestamp
  };
}
