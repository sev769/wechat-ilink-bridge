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

// The server msg_id handed back in a sendmessage response is NOT the id a
// later ref_msg points at: measured pairs (response id -> ref id) are
// 7524957599004039000 -> 7524957599004038792, 7524958399143069000 ->
// 7524958399143068936, and 7524961003499663000 -> 7524961003499663752. The
// two ids are always numerically close (delta <= ~1000) and the quoted
// message's server create_time_ms is within ~3s of the locally recorded
// timestamp, but the delta's sign and size vary and a pair can straddle any
// fixed block boundary, so no single exact or block rule suffices. The
// canonical ref id never appears anywhere else. Resolution is therefore
// tiered: exact key, then same id block (>> 10) + nearest time, then
// numeric proximity + nearest time with an ambiguity guard. Ids are
// 19-digit strings beyond Number.MAX_SAFE_INTEGER, so all id arithmetic
// must use BigInt, never number arithmetic.
export const QUOTE_BLOCK_TIME_TOLERANCE_MS = 15000;
export const QUOTE_TIME_TOLERANCE_MS = 10000;
export const QUOTE_TIME_MAX_ID_DELTA = 4096n;
export const QUOTE_TIME_AMBIGUITY_MS = 1000;

function summaryExpired(summary, now) {
  const cachedAt = Number(summary?.cachedAt ?? 0);
  return Number.isFinite(cachedAt) && cachedAt > 0 && now - cachedAt > QUOTE_CACHE_RETENTION_MS;
}

function toQuoteResult(messageId, summary, matchType) {
  return {
    messageId,
    direction: summary.direction,
    fromUserId: summary.fromUserId,
    kind: summary.kind,
    ...(summary.text ? { text: summary.text } : {}),
    ...(summary.fileName ? { fileName: summary.fileName } : {}),
    timestamp: summary.timestamp,
    matchType
  };
}

function idBlock(idString) {
  try {
    return BigInt(idString) >> 10n;
  } catch {
    return undefined;
  }
}

// Resolve a quote reference ({ messageId, createTimeMs }) to a cached
// summary. Exact key hit wins; otherwise fall back to same-block + nearest
// timestamp, then to numeric-proximity + nearest timestamp (guarded
// against ambiguity). Returns undefined when nothing qualifies — the
// caller then leaves the message without a quotedMessage.
export async function resolveQuoteSummary(stateDir, accountId, quote) {
  const targetId = quote?.messageId;
  if (!targetId) {
    return undefined;
  }

  const cache = await readQuoteCache(stateDir, accountId);
  const now = Date.now();

  const exact = cache[String(targetId)];
  if (exact && !summaryExpired(exact, now)) {
    return toQuoteResult(String(targetId), exact, "exact");
  }

  const createTimeMs = Number(quote?.createTimeMs);
  if (!Number.isFinite(createTimeMs)) {
    return undefined;
  }

  const candidates = [];
  for (const [id, summary] of Object.entries(cache)) {
    if (!summary || typeof summary !== "object" || summaryExpired(summary, now)) {
      continue;
    }
    const timestampSec = Number(summary.timestamp);
    if (!Number.isFinite(timestampSec)) {
      continue;
    }
    candidates.push({ id, summary, diffMs: Math.abs(timestampSec * 1000 - createTimeMs) });
  }

  // Tier 2: same id block, nearest timestamp within the block tolerance.
  const targetBlock = idBlock(String(targetId));
  if (targetBlock !== undefined) {
    let best;
    for (const candidate of candidates) {
      if (candidate.diffMs > QUOTE_BLOCK_TIME_TOLERANCE_MS) {
        continue;
      }
      const block = idBlock(candidate.id);
      if (block === undefined || block !== targetBlock) {
        continue;
      }
      if (!best || candidate.diffMs < best.diffMs) {
        best = candidate;
      }
    }
    if (best) {
      return toQuoteResult(best.id, best.summary, "block-time");
    }
  }

  // Tier 3: numeric proximity + nearest timestamp. Covers pairs that
  // straddle a block boundary. Refuse to guess when two candidates are
  // nearly equidistant in time.
  let targetValue;
  try {
    targetValue = BigInt(String(targetId));
  } catch {
    return undefined;
  }
  const near = candidates
    .filter((candidate) => candidate.diffMs <= QUOTE_TIME_TOLERANCE_MS)
    .filter((candidate) => {
      try {
        const delta = BigInt(candidate.id) - targetValue;
        return delta <= QUOTE_TIME_MAX_ID_DELTA && delta >= -QUOTE_TIME_MAX_ID_DELTA;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.diffMs - b.diffMs);
  if (near.length === 0) {
    return undefined;
  }
  if (near.length > 1 && near[1].diffMs - near[0].diffMs <= QUOTE_TIME_AMBIGUITY_MS) {
    return undefined;
  }
  return toQuoteResult(near[0].id, near[0].summary, "time");
}
