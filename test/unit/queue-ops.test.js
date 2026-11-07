import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WxbError } from "../../src/core/errors.js";
import {
  discardQueuedDelivery,
  flushOneQueuedDeliveryForUser,
  listQueuedDeliveries,
  queueTextDelivery,
  retryQueuedDeliveryById
} from "../../src/core/delivery-queue.js";
import { saveAccount } from "../../src/state/account-store.js";
import { rememberContextToken } from "../../src/state/context-token-store.js";
import { clearQueuedDeliveryBlock, readDeliveryQueue } from "../../src/state/delivery-queue-store.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-queue-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(stateDir) {
  const account = await saveAccount(stateDir, {
    accountId: "bot_queue_ops",
    token: "bot_secret_queue_ops",
    baseUrl: "https://mock.example",
    ownerUserId: "owner_queue_ops"
  });
  await rememberContextToken(stateDir, "bot_queue_ops", "user_queue_ops", "ctx_queue_ops");
  return account;
}

function fakeClient(options = {}) {
  const calls = [];
  return {
    calls,
    async sendTextMessage(request) {
      calls.push(request);
      if (options.error) {
        throw options.error;
      }
      return { ret: 0, message_id: `srv_${calls.length}` };
    }
  };
}

test("queue list exposes status, age, attempts, source, and the stable client id", async () => {
  await withTempDir(async (stateDir) => {
    await seed(stateDir);
    const queued = await queueTextDelivery({
      stateDir,
      accountId: "bot_queue_ops",
      userId: "user_queue_ops",
      text: "later please",
      source: "invalid_context"
    });

    assert.match(queued.clientId, /^wxb-\d+-[a-f0-9]{8}$/);
    const [item] = await listQueuedDeliveries(stateDir, "bot_queue_ops");
    assert.equal(item.id, queued.id);
    assert.equal(item.status, "pending");
    assert.equal(item.source, "invalid_context");
    assert.equal(item.attempts, 0);
    assert.equal(item.clientId, queued.clientId);
    assert.equal(typeof item.ageSeconds, "number");
    assert.ok(item.ageSeconds >= 0);
  });
});

test("manual retry delivers with the stored client id and removes the item", async () => {
  await withTempDir(async (stateDir) => {
    const account = await seed(stateDir);
    const queued = await queueTextDelivery({
      stateDir,
      accountId: "bot_queue_ops",
      userId: "user_queue_ops",
      text: "retry me",
      source: "invalid_context"
    });
    const client = fakeClient();

    const result = await retryQueuedDeliveryById({
      stateDir,
      account,
      queueId: queued.id,
      client,
      config: {}
    });

    assert.equal(result.status, "sent");
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].clientId, queued.clientId);
    assert.equal((await readDeliveryQueue(stateDir, "bot_queue_ops")).length, 0);
  });
});

test("manual retry refuses SESSION_EXPIRED items unless forced", async () => {
  await withTempDir(async (stateDir) => {
    const account = await seed(stateDir);
    const queued = await queueTextDelivery({
      stateDir,
      accountId: "bot_queue_ops",
      userId: "user_queue_ops",
      text: "blocked text",
      source: "invalid_context",
      error: new WxbError("SESSION_EXPIRED", "expired", { retryable: false })
    });
    const client = fakeClient();

    await assert.rejects(
      retryQueuedDeliveryById({ stateDir, account, queueId: queued.id, client, config: {} }),
      (error) => error.code === "QUEUE_ITEM_SESSION_EXPIRED"
    );
    assert.equal(client.calls.length, 0);

    const forced = await retryQueuedDeliveryById({
      stateDir,
      account,
      queueId: queued.id,
      client,
      config: {},
      force: true
    });
    assert.equal(forced.status, "sent");
    assert.equal(client.calls.length, 1);
  });
});

test("a SESSION_EXPIRED flush failure blocks automatic retries until a fresh inbound lifts the block", async () => {
  await withTempDir(async (stateDir) => {
    const account = await seed(stateDir);
    await queueTextDelivery({
      stateDir,
      accountId: "bot_queue_ops",
      userId: "user_queue_ops",
      text: "will expire",
      source: "invalid_context"
    });
    const failing = fakeClient({
      error: new WxbError("SESSION_EXPIRED", "expired", { retryable: false })
    });

    const failed = await flushOneQueuedDeliveryForUser({
      stateDir,
      account,
      userId: "user_queue_ops",
      contextToken: "ctx_queue_ops",
      client: failing,
      config: {}
    });
    assert.equal(failed.status, "failed");

    const [stored] = await readDeliveryQueue(stateDir, "bot_queue_ops");
    assert.equal(stored.blocked, "SESSION_EXPIRED");
    assert.equal(stored.attempts, 1);

    const working = fakeClient();
    const skipped = await flushOneQueuedDeliveryForUser({
      stateDir,
      account,
      userId: "user_queue_ops",
      contextToken: "ctx_queue_ops",
      client: working,
      config: {}
    });
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.reason, "SESSION_EXPIRED");
    assert.equal(working.calls.length, 0);

    await clearQueuedDeliveryBlock(stateDir, "bot_queue_ops", "user_queue_ops");
    const sent = await flushOneQueuedDeliveryForUser({
      stateDir,
      account,
      userId: "user_queue_ops",
      contextToken: "ctx_queue_ops",
      client: working,
      config: {}
    });
    assert.equal(sent.status, "sent");
    assert.equal(working.calls.length, 1);
    assert.equal((await readDeliveryQueue(stateDir, "bot_queue_ops")).length, 0);
  });
});

test("discard removes exactly one item and rejects unknown ids", async () => {
  await withTempDir(async (stateDir) => {
    await seed(stateDir);
    const first = await queueTextDelivery({
      stateDir,
      accountId: "bot_queue_ops",
      userId: "user_queue_ops",
      text: "drop me",
      source: "send"
    });
    await queueTextDelivery({
      stateDir,
      accountId: "bot_queue_ops",
      userId: "user_queue_ops",
      text: "keep me",
      source: "send"
    });

    const discarded = await discardQueuedDelivery(stateDir, "bot_queue_ops", first.id);
    assert.equal(discarded.id, first.id);
    const remaining = await readDeliveryQueue(stateDir, "bot_queue_ops");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].text, "keep me");

    await assert.rejects(
      discardQueuedDelivery(stateDir, "bot_queue_ops", "queued-missing"),
      (error) => error.code === "QUEUE_ITEM_NOT_FOUND"
    );
  });
});
