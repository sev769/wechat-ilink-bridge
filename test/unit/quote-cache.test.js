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
  resolveQuoteSummary,
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
            msg_id: "7434943367072022152",
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
            msg_id: "7434945285671009000",
            from_user_id: "user_q3",
            to_user_id: "owner_q3",
            context_token: "ctx_q3_b",
            timestamp: 1794086762,
            item_list: [
              {
                type: 1,
                msg_id: "v1:3000000000000000002",
                ref_msg: {
                  message_item: {
                    type: 0,
                    create_time_ms: 1794086306000,
                    msg_id: "7434943367072022152"
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
    assert.deepEqual(quoted.quote, { messageId: "7434943367072022152", createTimeMs: 1794086306000 });
    assert.equal(quoted.quotedMessage.messageId, "7434943367072022152");
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

// Measured on the live account: the sendmessage response id (cache key) and
// the id a later ref_msg points at are different numbers sharing the same
// >> 10 block. Pair 1: 7434957599004039000 -> 7434957599004038792 (Δ208),
// pair 2: 7434958399143069000 -> 7434958399143068936 (Δ64).
test("resolveQuoteSummary marks exact hits as exact", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q6",
      token: "bot_secret_q6",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q6"
    });
    await cacheQuoteSummaries(stateDir, "bot_q6", [
      summarizeForQuoteCache({ id: "7434957465569018000", direction: "incoming", fromUserId: "user_q6", type: "text", text: "你好", timestamp: 1794089666 }, "incoming")
    ]);

    const hit = await resolveQuoteSummary(stateDir, "bot_q6", { messageId: "7434957465569018000", createTimeMs: 1794089666000 });
    assert.equal(hit.matchType, "exact");
    assert.equal(hit.messageId, "7434957465569018000");
    assert.equal(hit.text, "你好");
  });
});

test("resolveQuoteSummary falls back to same-block + time match (measured pair 1)", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q7",
      token: "bot_secret_q7",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q7"
    });
    // Outgoing bot reply cached under the send-response id; the local send
    // timestamp (seconds) is 1794089697, the ref's server create_time_ms is
    // 1794089699000 — 2s apart, as measured live.
    await cacheQuoteSummaries(stateDir, "bot_q7", [
      summarizeForQuoteCache({ id: "7434957599004039000", direction: "outgoing", fromUserId: "owner_q7", type: "text", text: "收到，在呢。", timestamp: 1794089697 }, "outgoing")
    ]);

    const hit = await resolveQuoteSummary(stateDir, "bot_q7", { messageId: "7434957599004038792", createTimeMs: 1794089699000 });
    assert.equal(hit.matchType, "block-time");
    assert.equal(hit.messageId, "7434957599004039000");
    assert.equal(hit.text, "收到，在呢。");
    assert.equal(hit.direction, "outgoing");
  });
});

test("resolveQuoteSummary falls back to same-block + time match (measured pair 2)", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q8",
      token: "bot_secret_q8",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q8"
    });
    await cacheQuoteSummaries(stateDir, "bot_q8", [
      summarizeForQuoteCache({ id: "7434958399143069000", direction: "outgoing", fromUserId: "owner_q8", type: "text", text: "🧪 引用编号对照测试", timestamp: 1794089887 }, "outgoing")
    ]);

    const hit = await resolveQuoteSummary(stateDir, "bot_q8", { messageId: "7434958399143068936", createTimeMs: 1794089889000 });
    assert.equal(hit.matchType, "block-time");
    assert.equal(hit.messageId, "7434958399143069000");
    assert.equal(hit.text, "🧪 引用编号对照测试");
  });
});

test("resolveQuoteSummary picks the nearest timestamp among same-block candidates", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q9",
      token: "bot_secret_q9",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q9"
    });
    const block = BigInt("7434957599004038792") >> 10n;
    const farId = ((block << 10n) + 111n).toString();
    const nearId = ((block << 10n) + 222n).toString();
    const targetId = ((block << 10n) + 333n).toString();
    const baseSec = 1794089697;
    await cacheQuoteSummaries(stateDir, "bot_q9", [
      summarizeForQuoteCache({ id: farId, direction: "outgoing", fromUserId: "owner_q9", type: "text", text: "较早的一条", timestamp: baseSec }, "outgoing"),
      summarizeForQuoteCache({ id: nearId, direction: "outgoing", fromUserId: "owner_q9", type: "text", text: "较近的一条", timestamp: baseSec + 8 }, "outgoing")
    ]);

    // Target time is 1s after the nearer entry, 9s after the farther one:
    // both within tolerance, the nearer must win.
    const hit = await resolveQuoteSummary(stateDir, "bot_q9", { messageId: targetId, createTimeMs: (baseSec + 8) * 1000 + 1000 });
    assert.equal(hit.matchType, "block-time");
    assert.equal(hit.messageId, nearId);
    assert.equal(hit.text, "较近的一条");
  });
});

test("resolveQuoteSummary misses when no same-block candidate exists", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q10",
      token: "bot_secret_q10",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q10"
    });
    await cacheQuoteSummaries(stateDir, "bot_q10", [
      summarizeForQuoteCache({ id: "7434950000000000000", direction: "outgoing", fromUserId: "owner_q10", type: "text", text: "别的块", timestamp: 1794089697 }, "outgoing")
    ]);

    assert.equal(
      await resolveQuoteSummary(stateDir, "bot_q10", { messageId: "7434957599004038792", createTimeMs: 1794089699000 }),
      undefined
    );
    // Non-numeric ids can never block-match and must not throw.
    assert.equal(
      await resolveQuoteSummary(stateDir, "bot_q10", { messageId: "srv_text", createTimeMs: 1794089699000 }),
      undefined
    );
    // Missing createTimeMs disables the fallback entirely.
    assert.equal(
      await resolveQuoteSummary(stateDir, "bot_q10", { messageId: "7434957599004038792" }),
      undefined
    );
  });
});

test("resolveQuoteSummary misses when the same-block candidate is too far in time", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q11",
      token: "bot_secret_q11",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q11"
    });
    await cacheQuoteSummaries(stateDir, "bot_q11", [
      summarizeForQuoteCache({ id: "7434957599004039000", direction: "outgoing", fromUserId: "owner_q11", type: "text", text: "收到，在呢。", timestamp: 1794089697 }, "outgoing")
    ]);

    // Same block, but the ref claims a create time 62s after the entry.
    const hit = await resolveQuoteSummary(stateDir, "bot_q11", { messageId: "7434957599004038792", createTimeMs: 1794089699000 + 60000 });
    assert.equal(hit, undefined);
  });
});

test("resolveQuoteSummary falls back to proximity + time across a block boundary (measured pair 3)", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q12",
      token: "bot_secret_q12",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q12"
    });
    await cacheQuoteSummaries(stateDir, "bot_q12", [
      summarizeForQuoteCache({ id: "7434961003499663000", direction: "outgoing", fromUserId: "owner_q12", type: "text", text: "引用复验", timestamp: 1794090508 }, "outgoing")
    ]);

    // Measured live 2026-11-08: this pair straddles the >>10 block boundary
    // (delta +752), so the block fallback misses and the proximity tier
    // must claim it.
    const hit = await resolveQuoteSummary(stateDir, "bot_q12", { messageId: "7434961003499663752", createTimeMs: 1794090510000 });
    assert.equal(hit.text, "引用复验");
    assert.equal(hit.matchType, "time");
    assert.equal(hit.messageId, "7434961003499663000");
  });
});

test("resolveQuoteSummary proximity tier refuses ambiguous candidates", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q13",
      token: "bot_secret_q13",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q13"
    });
    await cacheQuoteSummaries(stateDir, "bot_q13", [
      summarizeForQuoteCache({ id: "7434961003499663000", direction: "outgoing", fromUserId: "owner_q13", type: "text", text: "甲", timestamp: 1794090508 }, "outgoing"),
      summarizeForQuoteCache({ id: "7434961003499662000", direction: "outgoing", fromUserId: "owner_q13", type: "text", text: "乙", timestamp: 1794090509 }, "outgoing")
    ]);

    // Both entries are numerically near the ref id and their time diffs
    // (2000ms vs 1000ms) are within the ambiguity window: refuse to guess.
    const hit = await resolveQuoteSummary(stateDir, "bot_q13", { messageId: "7434961003499663752", createTimeMs: 1794090510000 });
    assert.equal(hit, undefined);
  });
});

test("resolveQuoteSummary proximity tier misses when the id is too far away", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q14",
      token: "bot_secret_q14",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q14"
    });
    await cacheQuoteSummaries(stateDir, "bot_q14", [
      summarizeForQuoteCache({ id: "7434961003499763000", direction: "outgoing", fromUserId: "owner_q14", type: "text", text: "太远", timestamp: 1794090508 }, "outgoing")
    ]);

    // Same moment, but the cached id is ~100k away from the ref id: not a
    // sibling id, so the proximity tier must not claim it.
    const hit = await resolveQuoteSummary(stateDir, "bot_q14", { messageId: "7434961003499663752", createTimeMs: 1794090510000 });
    assert.equal(hit, undefined);
  });
});

test("fetchMessages restores a quote whose ref id differs from the send-response cache key", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_q12",
      token: "bot_secret_q12",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_q12"
    });
    // The bot's earlier reply, cached under its send-response id.
    await cacheQuoteSummaries(stateDir, "bot_q12", [
      summarizeForQuoteCache({ id: "7434957599004039000", direction: "outgoing", fromUserId: "owner_q12", type: "text", text: "收到，在呢。", timestamp: 1794089697 }, "outgoing")
    ]);

    const client = {
      async getUpdates() {
        return {
          ret: 0,
          get_updates_buf: "cursor_q12",
          msgs: [
            {
              msg_id: "7434957681848401000",
              from_user_id: "user_q12",
              to_user_id: "owner_q12",
              context_token: "ctx_q12",
              timestamp: 1794089718,
              item_list: [
                {
                  type: 1,
                  msg_id: "v1:3000000000000000001",
                  ref_msg: {
                    message_item: {
                      type: 0,
                      create_time_ms: 1794089699000,
                      msg_id: "7434957599004038792"
                    }
                  },
                  text_item: { text: "我引用的是什么" }
                }
              ]
            }
          ]
        };
      },
      async sendTextMessage() {
        return { ret: 0 };
      }
    };

    const result = await fetchMessages({ stateDir, client, retry: { maxAttempts: 1 } });
    assert.equal(result.messages.length, 1);
    const [message] = result.messages;
    assert.deepEqual(message.quote, { messageId: "7434957599004038792", createTimeMs: 1794089699000 });
    assert.equal(message.quotedMessage.messageId, "7434957599004039000");
    assert.equal(message.quotedMessage.matchType, "block-time");
    assert.equal(message.quotedMessage.text, "收到，在呢。");
  });
});
