import { parseCliArgs } from "../../config/load-config.js";
import { cliSuccess } from "../../core/errors.js";
import { runDoctor } from "../../core/doctor.js";

const STATUS_LABEL = {
  ok: "ok",
  degraded: "DEGRADED",
  faulty: "FAULTY"
};

export async function runDoctorCommand(argv, context) {
  const flags = parseCliArgs(argv);
  const report = await runDoctor({
    stateDir: context.config.stateDir,
    config: context.config,
    accountId: flags.account === true ? undefined : flags.account
  });

  process.exitCode = report.exitCode;

  if (flags.json === true) {
    return cliSuccess(report);
  }

  const lines = [`wxb doctor — ${report.status.toUpperCase()} (exit ${report.exitCode})`];
  for (const check of report.checks) {
    lines.push(`  [${STATUS_LABEL[check.status] ?? check.status}] ${check.name}: ${check.detail}`);
  }
  context.stdout.write(`${lines.join("\n")}\n`);
  return undefined;
}
