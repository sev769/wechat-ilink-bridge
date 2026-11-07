import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchMessages } from "../../src/core/fetch-messages.js";
import { listAccounts, saveAccount } from "../../src/state/account-store.js";
import {
  acquirePollerLease,
  pollerLeaseFilePath,
  releasePollerLease
} from "../../src/state/poller-lease.js";
import { markSeenIds, readSeenIds } from "../../src/state/seen-store.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-lease-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedAccount(stateDir) {
  await saveAccount(stateDir, {
    accountId: "bot_lease",
    token: "bot_secret_lease",
    baseUrl: "https://mock.example",
    ownerUserId: "owner_lease"
  });
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

test("a second acquire fails fast while a live poller holds the lease, and succeeds after release", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const lease = await acquirePollerLease(stateDir, "bot_lease", { pid: process.pid });

    await assert.rejects(
      acquirePollerLease(stateDir, "bot_lease", { pid: 999999 }),
      (error) => error.code === "POLLER_ALREADY_RUNNING" && error.details?.pid === process.pid
    );

    await lease.release();
    const next = await acquirePollerLease(stateDir, "bot_lease", { pid: 999999 });
    await next.release();
  });
});

test("a lease held by a dead pid is taken over immediately", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const pid = await deadPid();
    await writeFile(pollerLeaseFilePath(stateDir, "bot_lease"), JSON.stringify({
      pid,
      acquiredAt: new Date().toISOString()
    }));

    const lease = await acquirePollerLease(stateDir, "bot_lease", { pid: process.pid });
    await lease.release();
  });
});

test("an expired lease is taken over even when its pid is still alive", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    await writeFile(pollerLeaseFilePath(stateDir, "bot_lease"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 11 * 60 * 1000).toISOString()
    }));

    const lease = await acquirePollerLease(stateDir, "bot_lease", { pid: 424242 });
    await lease.release();
  });
});

test("release only removes the holder's own lease, and the lease file is not listed as an account", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    await acquirePollerLease(stateDir, "bot_lease", { pid: process.pid });

    // A non-owner release must leave the lease in place.
    await releasePollerLease(stateDir, "bot_lease", { pid: 313131 });
    await assert.rejects(
      acquirePollerLease(stateDir, "bot_lease", { pid: 999999 }),
      (error) => error.code === "POLLER_ALREADY_RUNNING"
    );

    const accounts = await listAccounts(stateDir);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].accountId, "bot_lease");

    await releasePollerLease(stateDir, "bot_lease", { pid: process.pid });
    const lease = await acquirePollerLease(stateDir, "bot_lease", { pid: 999999 });
    await lease.release();
  });
});

test("fetchMessages refuses a concurrent second poller and allows the next serial poll", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const blockingClient = {
      async getUpdates() {
        await gate;
        return { ret: 0, msgs: [], get_updates_buf: "cursor_lease" };
      }
    };
    const fastClient = {
      async getUpdates() {
        return { ret: 0, msgs: [], get_updates_buf: "cursor_lease" };
      }
    };

    const first = fetchMessages({ stateDir, client: blockingClient, retry: { maxAttempts: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await assert.rejects(
      fetchMessages({ stateDir, client: fastClient, retry: { maxAttempts: 1 } }),
      (error) => error.code === "POLLER_ALREADY_RUNNING"
    );

    unblock();
    await first;

    const third = await fetchMessages({ stateDir, client: fastClient, retry: { maxAttempts: 1 } });
    assert.equal(third.newMessageCount, 0);
  });
});

test("seen ids persist on disk and prune to the most recent 500 once past 1000", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const ids = Array.from({ length: 1001 }, (_, index) => `msg_${index}`);
    await markSeenIds(stateDir, "bot_lease", ids);

    const stored = await readSeenIds(stateDir, "bot_lease");
    assert.equal(stored.length, 500);
    assert.equal(stored[0], "msg_501");
    assert.equal(stored.at(-1), "msg_1000");
  });
});
