import { InvalidArgumentError } from "commander";

import { addReportingOptions, parseLintBudget } from "#root/bin/cli-options.js";
import { writeJson, writeResults } from "#root/bin/cli-output.js";
import { addRequestOption, resolveVerificationInvocation } from "#root/bin/request-invocation.js";
import { readCloseoutHandoff } from "#root/omp-plugin/closeout-handoff.js";
import {
  checkDeliveryHandoff,
  prepareDeliveryHandoff,
  recoverDeliveryHandoff,
  releaseDeliveryHandoff,
} from "#root/omp-plugin/delivery-handoff.js";
import { prepareResourceCloseout, verifyResourceCloseout } from "#root/omp-plugin/resource-closeout.js";
import { timeVerificationRun } from "#root/omp-plugin/run-timings.js";
import { generationCommand } from "#root/omp-plugin/runtime-generations.js";
import { waivedVerificationResult } from "#root/omp-plugin/waived-verification-result.js";

export function registerLifecycleCommands(program) {
  const generation = addReportingOptions(program.command("generation"))
    .description("Prepare, select, inspect, or collect immutable runtime generations")
    .action(statusGeneration);

  addReportingOptions(generation.command("prepare"))
    .description("Build a runtime generation from the configured installed packages")
    .action(prepareGeneration);

  addReportingOptions(generation.command("activate <id>"))
    .description("Select an existing runtime generation for new processes")
    .action(activateGeneration);

  addReportingOptions(generation.command("status"))
    .description("Show the active runtime generation (also the default generation action)")
    .action(statusGeneration);

  addReportingOptions(generation.command("collect"))
    .description("Collect unused runtime generations while preserving active leases")
    .action(collectGenerations);

  const handoff = program.command("handoff")
    .description("Preserve and recover committed delivery source for final verification");

  addReportingOptions(handoff.command("prepare"))
    .description("Pin committed delivery source before removing its clean checkout; preparation is not PASS")
    .requiredOption("--base <ref>", "Actual delivery base commit or ref")
    .action(prepareHandoff);

  addReportingOptions(handoff.command("recover <handoff-file>"))
    .description("Recover the exact pinned delivery source without substituting another checkout")
    .action(recoverHandoff);

  addRequestOption(addReportingOptions(handoff.command("check <handoff-file>"), {
    failuresOnly: true,
  }))
    .description("Check the pinned delivery and retain it while assessments are outstanding")
    .option("--fresh", "discard saved work from an interrupted matching run")
    .option("--lint-budget-ms <milliseconds>", "shared project lint budget (1–600000)", parseLintBudget)
    .action(checkHandoff);

  addReportingOptions(handoff.command("release <handoff-file>"))
    .description("Release a delivery handoff after final verification")
    .action(releaseHandoff);

  addReportingOptions(handoff.command("cancel <handoff-file>"))
    .description("Cancel a handoff only for explicit user cancellation or waiver; cancellation is not PASS")
    .requiredOption("--reason <reason>", "Explicit cancellation or waiver reason", cancellationReason)
    .action(cancelHandoff);

  const closeout = program.command("closeout")
    .description("Declare owned and protected resources, then verify their final dispositions");

  addRequestOption(addReportingOptions(closeout.command("prepare <declaration.json>")))
    .description("Capture a resource declaration before authorized cleanup or retention; preparation is not PASS")
    .action(prepareCloseout);

  addRequestOption(addReportingOptions(closeout.command("verify <receipt.json>"), {
    failuresOnly: true,
  }))
    .description("Check fresh resource observations against the prepared closeout receipt")
    .action(verifyCloseout);

  addRequestOption(addReportingOptions(closeout.command("review <handoff-id>"), {
    failuresOnly: true,
  }))
    .description("Independently recheck the exact receipt set declared by the primary tool")
    .action(reviewCloseout);
}

async function prepareGeneration() {
  const result = await generationCommand(["prepare"]);
  writeJson(result, {
    pretty: true,
  });
}

async function activateGeneration(id) {
  const result = await generationCommand(["activate", id]);
  writeJson(result, {
    pretty: true,
  });
}

async function statusGeneration() {
  const result = await generationCommand(["status"]);
  writeJson(result, {
    pretty: true,
  });
}

async function collectGenerations() {
  const result = await generationCommand(["collect"]);
  writeJson(result, {
    pretty: true,
  });
}

function cancellationReason(value) {
  if (!value.trim()) throw new InvalidArgumentError("Cancellation reason must not be blank");
  return value;
}

async function prepareHandoff(options) {
  const cwd = process.cwd();
  const operation = prepareDeliveryHandoff({
    cwd,
    baseRef: options.base,
  });
  await reportDeliveryHandoff(operation, options);
}

async function recoverHandoff(handoffPath, options) {
  const operation = recoverDeliveryHandoff({
    handoffPath,
  });
  await reportDeliveryHandoff(operation, options);
}

async function checkHandoff(handoffPath, options) {
  const { result, waiver } = await resolveVerificationInvocation(options.request, "verifier:delivery-handoff");
  if (result) {
    await writeResults([result], options);
    return;
  }

  const cwd = process.cwd();
  const results = await timeVerificationRun(cwd, "handoff check", async () => {
    try {
      return await checkDeliveryHandoff({
        handoffPath,
        fresh: options.fresh,
        lintBudgetMs: options.lintBudgetMs,
        waiver,
      });
    } catch (error) {
      return [handoffBlocker(error)];
    }
  });
  // The lifecycle command may run outside the selected checkout. The reviewer
  // reads and acknowledges semantic pages from the request's actual root.
  await writeResults(results, {
    ...options,
    inlineReviewPage: false,
  });
}

async function releaseHandoff(handoffPath, options) {
  const operation = releaseDeliveryHandoff({
    handoffPath,
  });
  await reportDeliveryHandoff(operation, options);
}

async function cancelHandoff(handoffPath, options) {
  const operation = releaseDeliveryHandoff({
    handoffPath,
    cancellationReason: options.reason,
  });
  await reportDeliveryHandoff(operation, options);
}

async function reportDeliveryHandoff(operation, options) {
  try {
    const result = await operation;
    writeJson(result, {
      pretty: options.reporter === "text",
    });
  } catch (error) {
    await writeResults([handoffBlocker(error)], options);
  }
}

function handoffBlocker(error) {
  return {
    id: "verifier:delivery-handoff",
    status: "BLOCKED",
    summary: "Delivery source handoff could not complete",
    evidence: error.message,
    nextCheck: "Resolve the named source or handoff prerequisite; do not substitute another checkout or treat cleanup as verification.",
  };
}

async function prepareCloseout(declarationPath, options) {
  const { result: disposition } = await resolveVerificationInvocation(options.request, "verifier:resource-closeout", {
    allowWholeRunWaiver: false,
  });
  if (disposition) {
    await writeResults([disposition], options);
    return;
  }

  const cwd = process.cwd();
  const result = await prepareResourceCloseout({
    cwd,
    declarationPath,
  });
  if (result.status === "PREPARED") {
    writeJson(result, {
      pretty: true,
    });
    return;
  }
  await writeResults([result], options);
}

async function verifyCloseout(receiptPath, options) {
  const { result: disposition } = await resolveVerificationInvocation(options.request, "verifier:resource-closeout", {
    allowWholeRunWaiver: false,
  });
  if (disposition) {
    await writeResults([disposition], options);
    return;
  }

  const cwd = process.cwd();
  const result = await verifyResourceCloseout({
    cwd,
    receiptPath,
  });
  await writeResults([result], options);
}

async function reviewCloseout(handoffId, options) {
  const { result, waiver } = await resolveVerificationInvocation(options.request, "verifier:resource-closeout", {
    allowWholeRunWaiver: false,
  });
  if (result) {
    await writeResults([result], options);
    return;
  }

  let handoff;
  try {
    handoff = await readCloseoutHandoff(handoffId);
  } catch (error) {
    if (waiver?.id === "verifier:closeout-handoff") {
      await writeResults([waivedVerificationResult(waiver)], options);
      return;
    }

    await writeResults([{
      id: "verifier:closeout-handoff",
      status: "BLOCKED",
      summary: "Independent closeout handoff unavailable; no resources checked",
      evidence: error.message,
      nextCheck: "Use the handoff ID returned by the current verifier_closeout tool call.",
    }], options);
    return;
  }

  const results = [];
  for (const receiptPath of handoff.receiptPaths) {
    const result = await verifyResourceCloseout({
      cwd: handoff.repositoryRoot,
      receiptPath,
    });
    results.push(result);
  }
  await writeResults(results, options);
}
