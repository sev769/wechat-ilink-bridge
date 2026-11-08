import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package metadata marks the 0.2.1 integrated release", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(manifest.name, "@dongh4o/wechat-ilink-bridge");
  assert.equal(manifest.version, "0.2.1");
  assert.equal(manifest.private, false);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.bin.wxb, "src/cli/index.js");
  assert.equal(manifest.bin["wxb-mcp"], "src/mcp/index.js");
  assert.equal("wxb-spike" in manifest.bin, false);
  assert.equal(manifest.scripts["pack:dry-run"], "npm pack --dry-run");
  assert.equal(manifest.scripts.spike, "node scripts/protocol-spike.js");
  assert.deepEqual(manifest.engines, { node: ">=18" });
  assert.match(manifest.description, /Agent-safe fetch, send, state, and media handoff/);
  assert.match(manifest.repository.url, /github\.com\/DONGH4O\/wechat-ilink-bridge/);
  assert.match(manifest.bugs.url, /github\.com\/DONGH4O\/wechat-ilink-bridge\/issues/);
  assert.match(manifest.homepage, /github\.com\/DONGH4O\/wechat-ilink-bridge#readme/);
  for (const requiredFile of ["src/", "skills/", "docs/", "extras/", "third_party/", "install.sh", "README.md", "CHANGELOG.md", "LICENSE"]) {
    assert.ok(manifest.files.includes(requiredFile), `${requiredFile} must be packed`);
  }
  assert.equal(manifest.files.includes("scripts/"), false);
});

test("README documents integrated usage and release expectations", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /版本：0\.2\.1/);
  assert.match(readme, /个人自用/);
  assert.match(readme, /快速开始/);
  assert.match(readme, /\.\/install\.sh/);
  assert.match(readme, /npm install -g \./);
  assert.match(readme, /wxb login --json/);
  assert.match(readme, /命令速查/);
  assert.match(readme, /queue retry/);
  assert.match(readme, /延迟补发队列/);
  assert.match(readme, /INVALID_CONTEXT_TOKEN/);
  assert.match(readme, /SESSION_EXPIRED/);
  assert.match(readme, /DONGH4O\/wechat-ilink-bridge/);
  assert.match(readme, /LICENSE/);
  assert.match(readme, /安全须知/);
  assert.match(readme, /完整 token/);
});

test("release framework documents package boundaries and secret audit", async () => {
  const [releaseProcess, npmignore, gitignore, license, changelog] = await Promise.all([
    readFile("docs/release-process.md", "utf8"),
    readFile(".npmignore", "utf8"),
    readFile(".gitignore", "utf8"),
    readFile("LICENSE", "utf8"),
    readFile("CHANGELOG.md", "utf8")
  ]);

  assert.match(releaseProcess, /0\.1\.0-beta\.1/);
  assert.match(releaseProcess, /@dongh4o\/wechat-ilink-bridge/);
  assert.match(releaseProcess, /DONGH4O\/wechat-ilink-bridge/);
  assert.match(releaseProcess, /package\.json\.private/);
  assert.match(releaseProcess, /npm scope `@dongh4o`/);
  assert.match(releaseProcess, /source-only maintenance script/);
  assert.match(releaseProcess, /not a public bin/);
  assert.match(releaseProcess, /should not include `scripts\/`/);
  assert.match(releaseProcess, /Secret audit commands/);
  assert.match(releaseProcess, /npm\.cmd run pack:dry-run/);
  assert.match(releaseProcess, /CHANGELOG\.md/);
  assert.match(releaseProcess, /LICENSE/);
  assert.match(releaseProcess, /m8-image-fetch\.stdout\.json/);
  assert.match(releaseProcess, /git status --short --ignored/);
  assert.match(releaseProcess, /npm publish --tag beta --access public/);
  assert.match(releaseProcess, /--prefix \$prefix/);
  assert.match(releaseProcess, /\.workbuddy\//);
  assert.match(npmignore, /^\.env$/m);
  assert.match(npmignore, /^m\*-\*\.stdout\.json$/m);
  assert.match(npmignore, /^test\/fixtures\/raw\/live-\*\.json$/m);
  assert.match(npmignore, /^你的真实测试状态目录\/$/m);
  assert.match(gitignore, /^\.workbuddy\/$/m);
  assert.match(gitignore, /^m\*-\*\.stdout\.json$/m);
  assert.match(gitignore, /^你的真实测试状态目录\/$/m);
  assert.match(gitignore, /^\*\.tgz$/m);
  assert.match(gitignore, /^\*\.log$/m);
  assert.match(license, /^MIT License/);
  assert.match(changelog, /## 0\.1\.0-beta\.1 - 2026-05-17/);
  assert.match(changelog, /## 0\.1\.0-beta\.0 - 2026-05-17/);
});
