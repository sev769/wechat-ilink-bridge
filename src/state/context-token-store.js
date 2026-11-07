import { accountStatePath, ensureStateDir } from "./state-dir.js";
import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import { withAccountLock } from "./lock.js";

export function contextTokenFilePath(stateDir, accountId) {
  return accountStatePath(stateDir, accountId, ".context-tokens.json");
}

export async function readContextTokens(stateDir, accountId) {
  return readJsonFile(contextTokenFilePath(stateDir, accountId), {});
}

export async function writeContextTokens(stateDir, accountId, tokens) {
  await ensureStateDir(stateDir);
  await writeJsonAtomic(contextTokenFilePath(stateDir, accountId), tokens ?? {});
}

async function rememberContextTokenUnlocked(stateDir, accountId, userId, contextToken) {
  const tokens = await readContextTokens(stateDir, accountId);
  tokens[String(userId)] = String(contextToken);
  await writeContextTokens(stateDir, accountId, tokens);
}

export async function rememberContextToken(stateDir, accountId, userId, contextToken, options = {}) {
  if (!userId || !contextToken) {
    return;
  }

  if (options.lock === false) {
    await rememberContextTokenUnlocked(stateDir, accountId, userId, contextToken);
    return;
  }

  await withAccountLock(stateDir, accountId, () => rememberContextTokenUnlocked(stateDir, accountId, userId, contextToken));
}

export async function resolveContextToken(stateDir, accountId, userId) {
  const tokens = await readContextTokens(stateDir, accountId);
  return tokens[String(userId)];
}

// Per-token successful-send accounting. iLink enforces a per-context-token
// send quota (measured live: 10 successful sends per token, the 11th is
// rejected with INVALID_CONTEXT_TOKEN), so the bridge counts successful
// sends per token value to budget chunked deliveries before hitting the
// server-side wall. Counts live in a sibling file so the token store format
// stays unchanged.
export const DEFAULT_CONTEXT_TOKEN_SEND_QUOTA = 10;

const MAX_TRACKED_TOKENS = 500;

export function contextTokenUsageFilePath(stateDir, accountId) {
  return accountStatePath(stateDir, accountId, ".context-token-usage.json");
}

export async function readTokenUsage(stateDir, accountId) {
  const raw = await readJsonFile(contextTokenUsageFilePath(stateDir, accountId), {});
  const usage = {};
  for (const [token, count] of Object.entries(raw ?? {})) {
    const value = Number(count);
    if (Number.isFinite(value) && value > 0) {
      usage[token] = Math.floor(value);
    }
  }
  return usage;
}

export async function writeTokenUsage(stateDir, accountId, usage) {
  await ensureStateDir(stateDir);
  await writeJsonAtomic(contextTokenUsageFilePath(stateDir, accountId), usage ?? {});
}

export async function getTokenSendCount(stateDir, accountId, contextToken) {
  if (!contextToken) {
    return 0;
  }
  const usage = await readTokenUsage(stateDir, accountId);
  return usage[String(contextToken)] ?? 0;
}

async function recordTokenSendUnlocked(stateDir, accountId, contextToken, increment) {
  const usage = await readTokenUsage(stateDir, accountId);
  const key = String(contextToken);
  usage[key] = (usage[key] ?? 0) + increment;
  const keys = Object.keys(usage);
  if (keys.length > MAX_TRACKED_TOKENS) {
    for (const staleKey of keys.slice(0, keys.length - MAX_TRACKED_TOKENS)) {
      delete usage[staleKey];
    }
  }
  await writeTokenUsage(stateDir, accountId, usage);
  return usage[key];
}

export async function recordTokenSend(stateDir, accountId, contextToken, increment = 1, options = {}) {
  if (!contextToken || !Number.isInteger(increment) || increment < 1) {
    return undefined;
  }

  if (options.lock === false) {
    return recordTokenSendUnlocked(stateDir, accountId, contextToken, increment);
  }

  return withAccountLock(stateDir, accountId, () => recordTokenSendUnlocked(stateDir, accountId, contextToken, increment));
}

export function resolveContextTokenSendQuota(config = {}) {
  const value = Number(config.contextTokenSendQuota);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONTEXT_TOKEN_SEND_QUOTA;
}

export async function getContextTokenQuota(stateDir, accountId, contextToken, config = {}) {
  const limit = resolveContextTokenSendQuota(config);
  const used = await getTokenSendCount(stateDir, accountId, contextToken);
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used)
  };
}
