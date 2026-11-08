import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M12 validation report records beta package install smoke", async () => {
  const report = await readFile("docs/m12-validation-report.md", "utf8");

  assert.match(report, /M12 npm beta 分发验收记录/);
  assert.match(report, /0\.1\.0-beta\.1/);
  assert.match(report, /npm\.cmd test/);
  assert.match(report, /126 项测试通过/);
  assert.match(report, /npm\.cmd run pack:dry-run/);
  assert.match(report, /54 个文件/);
  assert.match(report, /npm\.cmd pack/);
  assert.match(report, /--prefix C:\\tmp\\wxb-m12-global/);
  assert.match(report, /milestone: "M12"/);
  assert.match(report, /E403/);
  assert.match(report, /双因素验证码/);
  assert.match(report, /publish --dry-run --tag beta --access public/);
  assert.match(report, /--otp <one-time-code>/);
});

test("README documents integrated install paths", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /快速开始/);
  assert.match(readme, /\.\/install\.sh/);
  assert.match(readme, /npm install -g \./);
  assert.match(readme, /版本：0\.2\.1/);
  assert.match(readme, /SILK 编码器/);
});
