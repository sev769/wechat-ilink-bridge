import { open, readFile, rm } from "node:fs/promises";
import { WxbError } from "../core/errors.js";
import { accountStatePath, ensureStateDir } from "./state-dir.js";

// Single-poller lease for fetch. Exactly one live fetch per account may
// hold the lease; a second fetch fails fast with POLLER_ALREADY_RUNNING
// instead of running a competing getupdates long-poll (two pollers race
// the same sync cursor). The lease is a small JSON file { pid, acquiredAt }
// created exclusively; a lease whose pid is dead, or that is older than
// the TTL (guards against pid reuse), may be taken over — the same
// stale-lock reclamation idea the fork applied to the state lock.
// Normal serial polling is unaffected: each fetch releases its lease when
// it finishes, so the next poll acquires a fresh one.
export const DEFAULT_POLLER_LEASE_TTL_MS = 10 * 60 * 1000;

export function pollerLeaseFilePath(stateDir, accountId) {
  return accountStatePath(stateDir, accountId, ".poller-lease.json");
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLease(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return {
      pid: Number(parsed.pid),
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : undefined
    };
  } catch {
    return undefined;
  }
}

function leaseAgeMs(lease, now) {
  const acquiredMs = lease?.acquiredAt ? Date.parse(lease.acquiredAt) : Number.NaN;
  return Number.isFinite(acquiredMs) ? now - acquiredMs : Number.POSITIVE_INFINITY;
}

export async function acquirePollerLease(stateDir, accountId, options = {}) {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_POLLER_LEASE_TTL_MS;
  const filePath = pollerLeaseFilePath(stateDir, accountId);
  await ensureStateDir(stateDir);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await open(filePath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const existing = await readLease(filePath);
      const fresh = leaseAgeMs(existing, now) < ttlMs;
      if (existing && fresh && isPidAlive(existing.pid)) {
        throw new WxbError("POLLER_ALREADY_RUNNING", "Another fetch is already polling this account; refusing to run a second poller.", {
          retryable: true,
          details: {
            accountId,
            pid: existing.pid,
            acquiredAt: existing.acquiredAt
          }
        });
      }
      // Stale lease (dead pid, expired, or unreadable): reclaim it.
      await rm(filePath, { force: true });
      continue;
    }

    try {
      await handle.writeFile(JSON.stringify({
        pid,
        accountId: String(accountId),
        acquiredAt: new Date(now).toISOString()
      }));
    } finally {
      await handle.close();
    }

    return {
      pid,
      filePath,
      async release() {
        await releasePollerLease(stateDir, accountId, { pid });
      }
    };
  }

  throw new WxbError("POLLER_ALREADY_RUNNING", "Could not acquire the poller lease for this account.", {
    retryable: true,
    details: { accountId }
  });
}

export async function releasePollerLease(stateDir, accountId, options = {}) {
  const pid = options.pid ?? process.pid;
  const filePath = pollerLeaseFilePath(stateDir, accountId);
  const existing = await readLease(filePath);
  // Only the holder removes its lease; if the lease was taken over in the
  // meantime, the file belongs to the new poller.
  if (existing && existing.pid === pid) {
    await rm(filePath, { force: true });
  }
}
