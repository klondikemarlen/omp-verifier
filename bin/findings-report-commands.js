import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { addReportingOptions, parseWholeNumber } from "#root/bin/cli-options.js";
import { writeJson } from "#root/bin/cli-output.js";
import { composeFindingsReport, readFindingsReport } from "#root/omp-plugin/findings-report.js";
import { formatVerificationResults } from "#root/omp-plugin/reporters.js";

export function registerFindingsReportCommands(program) {
  const report = program.command("report")
    .description("Read the exact retained results behind an advisor findings note");

  report.command("compose <spec>")
    .description("Prepare a native blocker note from retained checks; read JSON from stdin with -")
    .action(composeReport);

  addReportingOptions(report.command("show <id>"))
    .description("Read a findings report by its exact ID without rerunning verification")
    .option("--evidence <check>", "write only the literal evidence for this one-based check number", parseWholeNumber)
    .action(showReport);
}

async function composeReport(spec) {
  const json = spec === "-" ? readFileSync(0, "utf8") : spec;
  const coordinator = process.env.OMP_VERIFIER_COORDINATOR ?? fileURLToPath(new URL("./omp-verifier.js", import.meta.url));
  const detailCommand = `node '${coordinator.replaceAll("'", "'\"'\"'")}' report show`;
  const { note } = await composeFindingsReport(JSON.parse(json), detailCommand);
  process.stdout.write(`${note}\n`);
}

async function showReport(id, options) {
  const report = await readFindingsReport(id);
  if (options.evidence !== undefined) {
    const checks = report.groups.flatMap(group => group.checks);
    const evidence = checks[options.evidence - 1]?.result.evidence;
    if (typeof evidence !== "string") throw new Error("No retained evidence for that check number");

    process.stdout.write(evidence);
    return;
  }

  if (options.reporter === "json") {
    writeJson(report);
    return;
  }

  const lines = [report.note, "Retained verification results (historical, not rerun):"];
  let checkNumber = 0;
  for (const { target, checks } of report.groups) {
    if (target) {
      lines.push(`${target.url} · target ${target.targetBranch} · base ${target.baseCommit} · head ${target.headCommit}`);
    }
    for (const { result } of checks) {
      checkNumber++;
      lines.push(`Check ${checkNumber}:\n${formatVerificationResults([result])}`);
    }
  }
  process.stdout.write(`${lines.join("\n\n")}\n`);
}
