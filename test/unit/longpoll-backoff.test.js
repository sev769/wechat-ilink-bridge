import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WxbError } from "../../src/core/errors.js";
import {
  fetchMessages,
  getUpdatesWithRetry,
  isLongPollTimeoutError,
  pickLongpollingTimeoutMs
} from "../../src/core/fetch-messages.js";
import { saveAccount } from "../../src/state/account-store.js";

function timeoutError() {
  return new WxbError("NETWORK_ERROR", "Network request failed.", {
    retryable: true,
    details: { cause: "request timeout" }
  });
}

function networkError() {
  return new WxbError("NETWORK_ERROR", "Network request failed.", {
    retryable: true,
    details: { cause: "socket hang up" }
  });
}

function scriptedClient(script) {
  const queue = [...script];
  return {
    calls: 0,
    async getUpdates() {
      this.calls += 1;
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next ?? { ret: 0, msgs: [] };
    }
  };
}

function recordingSleep(delays) {
  return async (ms) => {
    delays.push(ms);
  };
}

test("client timeouts are treated as normal long-poll ends: immediate re-poll, no backoff, no escalation", async () => {
  const delays = [];
  const client = scriptedClient([timeoutError(), timeoutError(), timeoutError(), { ret: 0, msgs: [] }]);

  const { response, attempts } = await getUpdatesWithRetry(client, {}, {
    maxAttempts: 5,
    sleep: recordingSleep(delays)
  });

  assert.equal(response.ret, 0);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, []);
});

test("general failures back off 2s, then 30s from the third consecutive failure", async () => {
  const delays = [];
  const client = scriptedClient([networkError(), networkError(), networkError(), networkError(), { ret: 0, msgs: [] }]);

  const { attempts } = await getUpdatesWithRetry(client, {}, {
    maxAttempts: 6,
    sleep: recordingSleep(delays)
  });

  assert.equal(attempts, 5);
  assert.deepEqual(delays, [2000, 2000, 30000, 30000]);
});

test("timeouts interleaved with failures do not advance the escalation counter", async () => {
  const delays = [];
  const client = scriptedClient([networkError(), timeoutError(), networkError(), { ret: 0, msgs: [] }]);

  await getUpdatesWithRetry(client, {}, {
    maxAttempts: 6,
    sleep: recordingSleep(delays)
  });

  assert.deepEqual(delays, [2000, 2000]);
});

test("SESSION_EXPIRED is thrown immediately without any retry or sleep", async () => {
  const delays = [];
  const expired = new WxbError("SESSION_EXPIRED", "iLink session expired; scan login is required.", {
    retryable: true // even if mislabelled retryable, the guard must win
  });
  const client = scriptedClient([expired, { ret: 0, msgs: [] }]);

  await assert.rejects(
    getUpdatesWithRetry(client, {}, { maxAttempts: 5, sleep: recordingSleep(delays) }),
    (error) => error.code === "SESSION_EXPIRED"
  );
  assert.equal(client.calls, 1);
  assert.deepEqual(delays, []);
});

test("an explicit legacy retryDelaysMs schedule still wins", async () => {
  const delays = [];
  const client = scriptedClient([networkError(), networkError(), { ret: 0, msgs: [] }]);

  await getUpdatesWithRetry(client, {}, {
    maxAttempts: 4,
    retryDelaysMs: [7, 11],
    sleep: recordingSleep(delays)
  });

  assert.deepEqual(delays, [7, 11]);
});

test("isLongPollTimeoutError and pickLongpollingTimeoutMs classify inputs", () => {
  assert.equal(isLongPollTimeoutError(timeoutError()), true);
  assert.equal(isLongPollTimeoutError(networkError()), false);
  assert.equal(isLongPollTimeoutError(new WxbError("SESSION_EXPIRED", "x", {})), false);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isLongPollTimeoutError(abort), true);

  assert.equal(pickLongpollingTimeoutMs({ longpolling_timeout_ms: 25000 }), 25000);
  assert.equal(pickLongpollingTimeoutMs({ longPollingTimeoutMs: "30000" }), 30000);
  assert.equal(pickLongpollingTimeoutMs({ longpolling_timeout_ms: 10 }), undefined);
  assert.equal(pickLongpollingTimeoutMs({}), undefined);
  assert.equal(pickLongpollingTimeoutMs(undefined), undefined);
});

test("fetchMessages surfaces a server-provided longpolling_timeout_ms", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-backoff-"));
  try {
    await saveAccount(dir, {
      accountId: "bot_backoff",
      token: "bot_secret_backoff",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_backoff"
    });
    const client = {
      async getUpdates() {
        return { ret: 0, msgs: [], get_updates_buf: "cursor_backoff", longpolling_timeout_ms: 25000 };
      }
    };

    const result = await fetchMessages({ stateDir: dir, client, retry: { maxAttempts: 1 } });
    assert.equal(result.longpollingTimeoutMs, 25000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
