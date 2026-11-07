import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { listAccounts } from "../state/account-store.js";
import { readContextTokenEntries } from "../state/context-token-store.js";
import { readDeliveryQueue } from "../state/delivery-queue-store.js";
import { quoteCacheFilePath } from "../state/quote-cache-store.js";
import { seenStoreFilePath } from "../state/seen-store.js";
import { syncBufferFilePath } from "../state/sync-buffer-store.js";
import { resolveSilkEncoder } from "./send-media.js";

const execFileAsync = promisify(execFile);

const RECENT_FETCH_THRESHOLD_MS = 10 * 60 * 1000;

async function defaultProbeBinary(name) {
  try {
    await execFileAsync(name, ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function checkStateFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { present: false, readable: true };
    }
    return { present: true, readable: false };
  }
  try {
    JSON.parse(raw);
    return { present: true, readable: true };
  } catch {
    return { present: true, readable: false };
  }
}

function worstStatus(checks) {
  if (checks.some((check) => check.status === "faulty")) {
    return "faulty";
  }
  if (checks.some((check) => check.status === "degraded")) {
    return "degraded";
  }
  return "healthy";
}

// Local health self-check: media toolchain, account/login state, context
// tokens, queue, state-file integrity, and the most recent fetch trace
// (the sync buffer is rewritten by every successful fetch, so its mtime
// approximates the last successful poll). Exit codes: 0 healthy,
// 1 degraded (usable, something needs attention), 2 faulty.
export async function runDoctor(options = {}) {
  const {
    stateDir,
    config = {},
    accountId,
    now = Date.now(),
    probeBinary = defaultProbeBinary,
    env = process.env
  } = options;

  if (!stateDir) {
    throw new TypeError("stateDir is required");
  }

  const checks = [];
  const add = (name, status, detail, data = {}) => {
    checks.push({ name, status, detail, ...data });
  };

  const ffmpegOk = await probeBinary("ffmpeg");
  add("ffmpeg", ffmpegOk ? "ok" : "degraded",
    ffmpegOk ? "ffmpeg is available on PATH" : "ffmpeg not found on PATH; voice/media conversion is unavailable");
  const ffprobeOk = await probeBinary("ffprobe");
  add("ffprobe", ffprobeOk ? "ok" : "degraded",
    ffprobeOk ? "ffprobe is available on PATH" : "ffprobe not found on PATH; audio duration probing is unavailable");

  try {
    const silkPath = await resolveSilkEncoder(config, env);
    add("silk-encoder", "ok", `SILK encoder resolved: ${silkPath}`, { path: silkPath });
  } catch {
    add("silk-encoder", "degraded", "No SILK encoder configured or on PATH; native voice conversion is unavailable");
  }

  const accounts = await listAccounts(stateDir);
  const account = accountId
    ? accounts.find((entry) => entry.accountId === String(accountId))
    : accounts[0];

  if (!account) {
    add("account", "faulty", accountId ? `Account not found: ${accountId}` : "No iLink account is saved; run wxb login first.");
    return finish(checks, undefined, now);
  }

  add("account", account.hasToken ? "ok" : "faulty",
    account.hasToken ? `Account ${account.accountId} is saved with a bot token` : `Account ${account.accountId} has no bot token; re-login is required`,
    { accountId: account.accountId });

  const tokenEntries = await readContextTokenEntries(stateDir, account.accountId);
  const tokenUsers = Object.keys(tokenEntries);
  if (tokenUsers.length === 0) {
    add("context-tokens", "degraded", "No context token is cached; sends will queue until the next inbound message refreshes one", { count: 0 });
  } else {
    const ages = tokenUsers
      .map((userId) => tokenEntries[userId].updatedAt ? Math.max(0, Math.floor((now - Date.parse(tokenEntries[userId].updatedAt)) / 1000)) : undefined)
      .filter((age) => age !== undefined);
    add("context-tokens", "ok", `${tokenUsers.length} context token(s) cached`, {
      count: tokenUsers.length,
      ...(ages.length ? { newestAgeSeconds: Math.min(...ages), oldestAgeSeconds: Math.max(...ages) } : {})
    });
  }

  const queue = await readDeliveryQueue(stateDir, account.accountId);
  const blockedCount = queue.filter((item) => item.blocked).length;
  add("delivery-queue",
    blockedCount > 0 ? "degraded" : "ok",
    queue.length === 0
      ? "Delivery queue is empty"
      : `${queue.length} queued deliver${queue.length === 1 ? "y" : "ies"}${blockedCount > 0 ? `, ${blockedCount} blocked (SESSION_EXPIRED)` : ""}`,
    { depth: queue.length, blocked: blockedCount });

  const stateFiles = [
    ["sync-buffer", syncBufferFilePath(stateDir, account.accountId)],
    ["seen-ids", seenStoreFilePath(stateDir, account.accountId)],
    ["quote-cache", quoteCacheFilePath(stateDir, account.accountId)]
  ];
  const corrupt = [];
  for (const [label, filePath] of stateFiles) {
    const result = await checkStateFile(filePath);
    if (!result.readable) {
      corrupt.push(label);
    }
  }
  add("state-files", corrupt.length ? "degraded" : "ok",
    corrupt.length ? `Unreadable/corrupt state file(s): ${corrupt.join(", ")}` : "State files are readable",
    { corrupt });

  try {
    const stats = await stat(syncBufferFilePath(stateDir, account.accountId));
    const ageMs = now - stats.mtimeMs;
    add("last-fetch",
      ageMs <= RECENT_FETCH_THRESHOLD_MS ? "ok" : "degraded",
      ageMs <= RECENT_FETCH_THRESHOLD_MS
        ? `Last successful fetch about ${Math.floor(ageMs / 1000)}s ago (sync buffer mtime)`
        : `No fetch in the last ${Math.floor(RECENT_FETCH_THRESHOLD_MS / 60000)} minutes (sync buffer mtime)`,
      { ageSeconds: Math.max(0, Math.floor(ageMs / 1000)) });
  } catch {
    add("last-fetch", "degraded", "No sync buffer found; this account has not completed a fetch yet");
  }

  return finish(checks, account.accountId, now);
}

function finish(checks, accountId, now) {
  const status = worstStatus(checks);
  return {
    status,
    exitCode: status === "faulty" ? 2 : status === "degraded" ? 1 : 0,
    ...(accountId ? { accountId } : {}),
    checkedAt: new Date(now).toISOString(),
    checks
  };
}
