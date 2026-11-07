import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WxbError } from "../../src/core/errors.js";
import { resolveSilkEncoder } from "../../src/core/send-media.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-silk-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("uses the configured silk encoder path when the file exists", async () => {
  await withTempDir(async (dir) => {
    const encoder = path.join(dir, "my-encoder");
    await writeFile(encoder, "#!/bin/sh\n");
    const resolved = await resolveSilkEncoder({ silkEncoderPath: encoder }, {});
    assert.equal(resolved, encoder);
  });
});

test("rejects a configured silk encoder path that does not exist", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => resolveSilkEncoder({ silkEncoderPath: path.join(dir, "missing") }, {}),
      (error) => error instanceof WxbError && error.code === "SILK_ENCODER_NOT_FOUND"
    );
  });
});

test("finds silk-encoder on PATH", async () => {
  await withTempDir(async (dir) => {
    const encoder = path.join(dir, "silk-encoder");
    await writeFile(encoder, "#!/bin/sh\n");
    await chmod(encoder, 0o755);
    const resolved = await resolveSilkEncoder({}, { PATH: dir });
    assert.equal(resolved, encoder);
  });
});

test("throws a helpful error when no silk encoder is available", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => resolveSilkEncoder({}, { PATH: dir }),
      (error) => error instanceof WxbError
        && error.code === "SILK_ENCODER_NOT_FOUND"
        && /WX_SILK_ENCODER_PATH/.test(error.message)
    );
  });
});

test("reads WX_SILK_ENCODER_PATH from the environment", async () => {
  await withTempDir(async (dir) => {
    const encoder = path.join(dir, "env-encoder");
    await writeFile(encoder, "#!/bin/sh\n");
    const resolved = await resolveSilkEncoder({}, { WX_SILK_ENCODER_PATH: encoder, PATH: "" });
    assert.equal(resolved, encoder);
  });
});
