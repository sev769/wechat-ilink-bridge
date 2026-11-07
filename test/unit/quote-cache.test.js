import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchMessages } from "../../src/core/fetch-messages.js";
import { pickServerMessageId } from "../../src/core/ilink-client.js";
import { saveAccount } from "../../src/state/account-store.js";
import {
  cacheQuoteSummaries,
  getQuoteSummary,
  readQuoteCache,
  summarizeForQuoteCache
} from "../../src/state/quote-cache-store.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-quote-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("pickServerMessageId reads the server id and ignores client id echoes", () => {
  assert.equal(pickServerMessageId({ ret: 0, message_id: "srv_001" }, "wxb-1-a"), "srv_001");
  assert.equal(pickServerMessageId({ ret: 0, data: { msg_id: "srv_002" } }, "wxb-1-a"), "srv_002");
  assert.equal(pickServerMessageId({ ret: 0, message_id: "wxb-1-a" }, "wxb-1-a"), undefined);
  assert.equal(pickServerMessageId({ ret: 0 }, "wxb-1-a"), undefined);
  assert.equal(pickServerMessageId(undefined, "wxb-1-a"), undefined);
});

test("quote cache stores text summaries truncated and media as placeholders", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q",
      token: "bot_secret_q",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q"
    });

    const longText = "x".repeat(600);
    await cacheQuoteSummaries(stateDir, "bot_q", [
      summarizeForQuoteCache({ id: "srv_text", direction: "incoming", fromUserId: "user_q", type: "text", text: longText, timestamp: 1715000000 }, "incoming"),
      summarizeForQuoteCache({ id: "srv_img", direction: "outgoing", fromUserId: "owner_q", type: "image", fileName: "pic.png", timestamp: 1715000001 }, "outgoing")
    ]);

    const textHit = await getQuoteSummary(stateDir, "bot_q", "srv_text");
    assert.equal(textHit.kind, "text");
    assert.equal(textHit.text.length, 500);
    assert.equal(textHit.direction, "incoming");

    const mediaHit = await getQuoteSummary(stateDir, "bot_q", "srv_img");
    assert.equal(mediaHit.kind, "image");
    assert.equal(mediaHit.fileName, "pic.png");
    assert.equal(Object.hasOwn(mediaHit, "text"), false);

    assert.equal(await getQuoteSummary(stateDir, "bot_q", "srv_missing"), undefined);
    const cache = await readQuoteCache(stateDir, "bot_q");
    assert.deepEqual(Object.keys(cache).sort(), ["srv_img", "srv_text"]);
  });
});

test("quote cache prunes entries older than the retention window on write", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q2",
      token: "bot_secret_q2",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q2"
    });

    const stale = summarizeForQuoteCache({ id: "srv_old", type: "text", text: "old", timestamp: 1 }, "incoming");
    stale.summary.cachedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await cacheQuoteSummaries(stateDir, "bot_q2", [stale]);
    assert.equal(await getQuoteSummary(stateDir, "bot_q2", "srv_old"), undefined);

    await cacheQuoteSummaries(stateDir, "bot_q2", [
      summarizeForQuoteCache({ id: "srv_new", type: "text", text: "new", timestamp: 2 }, "incoming")
    ]);
    const cache = await readQuoteCache(stateDir, "bot_q2");
    assert.deepEqual(Object.keys(cache), ["srv_new"]);
  });
});

test("fetchMessages resolves a ref_msg quote against messages cached by earlier fetches", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q3",
      token: "bot_secret_q3",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q3"
    });

    const responses = [
      {
        ret: 0,
        get_updates_buf: "cursor_q1",
        msgs: [
          {
            msg_id: "7524943367072022152",
            from_user_id: "user_q3",
            to_user_id: "owner_q3",
            context_token: "ctx_q3_a",
            timestamp: 1794086306,
            item_list: [{ type: 1, text_item: { text: "这是被引用的原文" } }]
          }
        ]
      },
      {
        ret: 0,
        get_updates_buf: "cursor_q2",
        msgs: [
          {
            msg_id: "7524945285671009000",
            from_user_id: "user_q3",
            to_user_id: "owner_q3",
            context_token: "ctx_q3_b",
            timestamp: 1794086762,
            item_list: [
              {
                type: 1,
                msg_id: "v1:2145779410884326998",
                ref_msg: {
                  message_item: {
                    type: 0,
                    create_time_ms: 1794086306000,
                    msg_id: "7524943367072022152"
                  }
                },
                text_item: { text: "1" }
              }
            ]
          }
        ]
      }
    ];
    const queue = [...responses];
    const client = {
      async getUpdates() {
        return queue.shift();
      },
      async sendTextMessage() {
        return { ret: 0 };
      }
    };

    const first = await fetchMessages({ stateDir, client, retry: { maxAttempts: 1 } });
    assert.equal(first.messages.length, 1);

    const second = await fetchMessages({ stateDir, client, retry: { maxAttempts: 1 } });
    assert.equal(second.messages.length, 1);
    const [quoted] = second.messages;
    assert.deepEqual(quoted.quote, { messageId: "7524943367072022152", createTimeMs: 1794086306000 });
    assert.equal(quoted.quotedMessage.messageId, "7524943367072022152");
    assert.equal(quoted.quotedMessage.kind, "text");
    assert.equal(quoted.quotedMessage.text, "这是被引用的原文");
    assert.equal(quoted.quotedMessage.direction, "incoming");
  });
});

test("sendText records the send response server message id into the quote cache", async () => {
  await withTempDir(async (stateDir) => {
    const { sendText } = await import("../../src/core/send-text.js");
    const { rememberContextToken } = await import("../../src/state/context-token-store.js");
    await saveAccount(stateDir, {
      accountId: "bot_q4",
      token: "bot_secret_q4",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q4"
    });
    await rememberContextToken(stateDir, "bot_q4", "user_q4", "ctx_q4");

    const client = {
      async sendTextMessage() {
        return { ret: 0, message_id: "srv_out_001" };
      }
    };

    const result = await sendText({
      stateDir,
      userId: "user_q4",
      text: "机器人的一条回复",
      client,
      config: {}
    });

    assert.equal(result.sent[0].serverMessageId, "srv_out_001");
    const hit = await getQuoteSummary(stateDir, "bot_q4", "srv_out_001");
    assert.equal(hit.direction, "outgoing");
    assert.equal(hit.kind, "text");
    assert.equal(hit.text, "机器人的一条回复");
  });
});

test("sendText without a server message id in the response caches nothing", async () => {
  await withTempDir(async (stateDir) => {
    const { sendText } = await import("../../src/core/send-text.js");
    const { rememberContextToken } = await import("../../src/state/context-token-store.js");
    await saveAccount(stateDir, {
      accountId: "bot_q5",
      token: "bot_secret_q5",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q5"
    });
    await rememberContextToken(stateDir, "bot_q5", "user_q5", "ctx_q5");

    const client = {
      async sendTextMessage() {
        return { ret: 0 };
      }
    };

    const result = await sendText({
      stateDir,
      userId: "user_q5",
      text: "no server id",
      client,
      config: {}
    });

    assert.equal(Object.hasOwn(result.sent[0], "serverMessageId"), false);
    assert.deepEqual(await readQuoteCache(stateDir, "bot_q5"), {});
  });
});
