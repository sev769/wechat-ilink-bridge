import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { runDoctorCommand } from "../../src/cli/commands/doctor.js";
import { runDoctor } from "../../src/core/doctor.js";
import { saveAccount } from "../../src/state/account-store.js";
import { rememberContextToken } from "../../src/state/context-token-store.js";
import { writeSyncBuffer } from "../../src/state/sync-buffer-store.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-doctor-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const allBinariesOk = async () => true;
const noBinaries = async () => false;

async function fakeSilkConfig(stateDir) {
  const encoderPath = path.join(stateDir, "fake-silk-encoder");
  await writeFile(encoderPath, "#!/bin/sh\n");
  return { silkEncoderPath: encoderPath };
}

test("doctor reports healthy for a fully provisioned account", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_doctor",
      token: "bot_secret_doctor",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_doctor"
    });
    await rememberContextToken(stateDir, "bot_doctor", "user_doctor", "ctx_doctor");
    await writeSyncBuffer(stateDir, "bot_doctor", "cursor_doctor");

    const report = await runDoctor({
      stateDir,
      config: await fakeSilkConfig(stateDir),
      probeBinary: allBinariesOk
    });

    assert.equal(report.status, "healthy");
    assert.equal(report.exitCode, 0);
    assert.equal(report.accountId, "bot_doctor");
    assert.ok(report.checks.every((check) => check.status === "ok"));
    assert.equal(JSON.stringify(report).includes("bot_secret_doctor"), false);
    assert.equal(JSON.stringify(report).includes("ctx_doctor"), false);
  });
});

test("doctor reports faulty when no account is saved", async () => {
  await withTempDir(async (stateDir) => {
    const report = await runDoctor({
      stateDir,
      config: await fakeSilkConfig(stateDir),
      probeBinary: allBinariesOk
    });

    assert.equal(report.status, "faulty");
    assert.equal(report.exitCode, 2);
    assert.equal(report.checks.find((check) => check.name === "account")?.status, "faulty");
  });
});

test("doctor reports degraded when the toolchain and tokens are missing but the account exists", async () => {
  await withTempDir(async (stateDir) => {
    await saveAccount(stateDir, {
      accountId: "bot_doctor",
      token: "bot_secret_doctor",
      baseUrl: "https://mock.example",
      ownerUserId: "owner_doctor"
    });

    const report = await runDoctor({
      stateDir,
      config: {},
      probeBinary: noBinaries,
      env: { PATH: "/nonexistent" }
    });

    assert.equal(report.status, "degraded");
    assert.equal(report.exitCode, 1);
    assert.equal(report.checks.find((check) => check.name === "ffmpeg")?.status, "degraded");
    assert.equal(report.checks.find((check) => check.name === "silk-encoder")?.status, "degraded");
    assert.equal(report.checks.find((check) => check.name === "context-tokens")?.status, "degraded");
    assert.equal(report.checks.find((check) => check.name === "account")?.status, "ok");
  });
});

test("the doctor CLI command prints a human summary and sets the exit code", async () => {
  await withTempDir(async (stateDir) => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const previousExitCode = process.exitCode;
    try {
      const result = await runDoctorCommand(["--state-dir", stateDir], {
        config: { stateDir },
        stdout
      });
      assert.equal(result, undefined);
      assert.equal(process.exitCode, 2);
      assert.match(output, /wxb doctor — FAULTY \(exit 2\)/);
      assert.match(output, /\[FAULTY\] account:/);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
