import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WxbError } from "../../src/core/errors.js";
import { sendText } from "../../src/core/send-text.js";
import { saveAccount } from "../../src/state/account-store.js";
import {
  contextTokenFilePath,
  describeContextToken,
  getContextTokenInfo,
  readContextTokens,
  rememberContextToken,
  resolveContextToken,
  writeContextTokens
} from "../../src/state/context-token-store.js";
import { readDeliveryQueue } from "../../src/state/delivery-queue-store.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-token-age-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedAccount(stateDir) {
  await saveAccount(stateDir, {
    accountId: "bot_token_age",
    token: "bot_secret_token_age",
    baseUrl: "https://mock.example",
    ownerUserId: "owner_token_age"
  });
}

test("rememberContextToken records a timestamp while resolveContextToken still returns the bare token", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    await rememberContextToken(stateDir, "bot_token_age", "user_a", "ctx_a");

    assert.equal(await resolveContextToken(stateDir, "bot_token_age", "user_a"), "ctx_a");
    const info = await getContextTokenInfo(stateDir, "bot_token_age", "user_a");
    assert.equal(info.token, "ctx_a");
    assert.equal(typeof info.updatedAt, "string");
    assert.ok(info.ageSeconds >= 0 && info.ageSeconds < 60);
  });
});

test("legacy string entries still resolve, report no age, and stay untouched when another user is remembered", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    await writeContextTokens(stateDir, "bot_token_age", { user_legacy: "ctx_legacy" });

    assert.equal(await resolveContextToken(stateDir, "bot_token_age", "user_legacy"), "ctx_legacy");
    const info = await getContextTokenInfo(stateDir, "bot_token_age", "user_legacy");
    assert.equal(info.token, "ctx_legacy");
    assert.equal(info.ageSeconds, undefined);
    assert.deepEqual(await describeContextToken(stateDir, "bot_token_age", "user_legacy", "ctx_legacy"), { source: "stored" });

    await rememberContextToken(stateDir, "bot_token_age", "user_new", "ctx_new");
    const raw = JSON.parse(await readFile(contextTokenFilePath(stateDir, "bot_token_age"), "utf8"));
    assert.equal(raw.user_legacy, "ctx_legacy");
    assert.equal(raw.user_new.token, "ctx_new");
    assert.equal(typeof raw.user_new.updatedAt, "string");
    assert.equal(Object.keys(await readContextTokens(stateDir, "bot_token_age")).length, 2);
  });
});

test("describeContextToken reports stored age, explicit provenance, and none", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const twoMinutesAgo = new Date(Date.now() - 120000).toISOString();
    await writeContextTokens(stateDir, "bot_token_age", {
      user_a: { token: "ctx_a", updatedAt: twoMinutesAgo }
    });

    const stored = await describeContextToken(stateDir, "bot_token_age", "user_a", "ctx_a");
    assert.equal(stored.source, "stored");
    assert.ok(stored.ageSeconds >= 118 && stored.ageSeconds <= 125);
    assert.deepEqual(await describeContextToken(stateDir, "bot_token_age", "user_a", "ctx_other"), { source: "explicit" });
    assert.deepEqual(await describeContextToken(stateDir, "bot_token_age", "user_a", undefined), { source: "none" });
  });
});

test("INVALID_CONTEXT_TOKEN queueing records token age and source in the queued item", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const fiveMinutesAgo = new Date(Date.now() - 300000).toISOString();
    await writeContextTokens(stateDir, "bot_token_age", {
      user_a: { token: "ctx_stale", updatedAt: fiveMinutesAgo }
    });
    const client = {
      async sendTextMessage() {
        throw new WxbError("INVALID_CONTEXT_TOKEN", "invalid context", { retryable: false });
      }
    };

    const result = await sendText({
      stateDir,
      userId: "user_a",
      text: "hello",
      client,
      config: {}
    });

    assert.equal(result.queued, true);
    const [item] = await readDeliveryQueue(stateDir, "bot_token_age");
    assert.equal(item.lastError.code, "INVALID_CONTEXT_TOKEN");
    assert.equal(item.lastError.details.tokenSource, "stored");
    assert.ok(item.lastError.details.tokenAgeSeconds >= 298);
  });
});

test("NO_CONTEXT_TOKEN errors carry tokenSource none", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    await assert.rejects(
      sendText({
        stateDir,
        userId: "user_missing",
        text: "hello",
        client: { async sendTextMessage() { return { ret: 0 }; } },
        config: {},
        queueOnNoContext: false
      }),
      (error) => error.code === "NO_CONTEXT_TOKEN" && error.details?.tokenSource === "none"
    );
  });
});
