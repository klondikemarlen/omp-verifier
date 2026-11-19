import { readFileSync } from "node:fs";
import { Option } from "commander";

import { addReportingOptions, parseWholeNumber } from "#root/bin/cli-options.js";
import { writeJson, writeResults } from "#root/bin/cli-output.js";
import { validateContextPathLimit } from "#root/omp-plugin/semantic-context.js";
import {
  completeSemanticEvaluation,
  readSemanticDiagnostics,
  readSemanticEvaluation,
} from "#root/omp-plugin/semantic-evaluations.js";

export function registerSemanticCommands(program) {
  const review = program.command("review")
    .description("Read a semantic review request and recover supporting context")
    .argument("<request-file>", "Semantic request file")
    .option("--context <path>", "Add source context, optionally with #Lstart-Lend", appendContext, [])
    .option("--caller-context <path>", "Add caller source context", appendContext, [])
    .option("--external-context <path>", "Add external source context", appendContext, [])
    .option("--remove-context <path>", "Remove a retained context selector", appendContext, [])
    .option("--max-context-paths <count>", "Context path limit from 30 to 256", parseWholeNumber)
    .option("--page <index>", "Zero-based text review page", parseWholeNumber)
    .addOption(new Option("--continue", "Restart the complete review as bounded batches").conflicts("batch"))
    .option("--batch <index>", "Zero-based semantic batch", parseWholeNumber);
  addReportingOptions(review);
  review.action(reviewRequest);

  const evaluate = program.command("evaluate")
    .description("Complete a semantic review using a structured assessment")
    .argument("<request-file>", "Semantic request file")
    .requiredOption("--assessment <json>", "Assessment JSON, or - to read stdin");
  addReportingOptions(evaluate, {
    failuresOnly: true,
  });
  evaluate.action(evaluateRequest);

  const diagnostics = program.command("diagnostics")
    .description("Read privacy-safe semantic request diagnostics")
    .argument("<request-file>", "Semantic request file");
  addReportingOptions(diagnostics);
  diagnostics.action(showDiagnostics);
}

function appendContext(value, previous) {
  return [...previous, value];
}

async function reviewRequest(requestPath, options) {
  const pageIndex = options.page ?? 0;
  if (options.page !== undefined && options.reporter !== "text") {
    throw new Error("--page requires review --reporter text");
  }
  const hasContextOptions = options.context.length > 0 || options.callerContext.length > 0
    || options.externalContext.length > 0 || options.removeContext.length > 0
    || options.maxContextPaths !== undefined;
  if (pageIndex > 0 && hasContextOptions) {
    throw new Error("Context recovery must start at page 0; read later pages from the renewed request without context options");
  }
  if (options.continue && pageIndex !== 0) {
    throw new Error("--continue must start at page 0");
  }
  let maxContextPaths;
  if (options.maxContextPaths !== undefined) {
    maxContextPaths = validateContextPathLimit(options.maxContextPaths);
  }

  const cwd = process.cwd();
  const result = await readSemanticEvaluation({
    cwd,
    requestPath,
    contextPaths: options.context,
    callerContextPaths: options.callerContext,
    externalContextPaths: options.externalContext,
    removeContextPaths: options.removeContext,
    maxContextPaths,
    continuation: options.continue,
    batchIndex: options.batch,
  });
  await writeResults([result], {
    reporter: options.reporter,
    pageIndex,
    review: true,
  });
}

async function evaluateRequest(requestPath, options) {
  let assessmentText = options.assessment;
  if (assessmentText === "-") assessmentText = readFileSync(0, "utf8");
  const assessment = JSON.parse(assessmentText);
  const cwd = process.cwd();
  const result = await completeSemanticEvaluation({
    cwd,
    requestPath,
    assessment,
  });
  await writeResults([result], {
    reporter: options.reporter,
    failuresOnly: options.failuresOnly,
  });
}

async function showDiagnostics(requestPath, options) {
  try {
    const cwd = process.cwd();
    const diagnostics = await readSemanticDiagnostics({
      cwd,
      requestPath,
    });
    const pretty = options.reporter === "text";
    writeJson(diagnostics, {
      pretty,
    });
  } catch {
    // Routine telemetry must not echo private paths or source-bearing errors.
    writeJson({
      status: "BLOCKED",
      reason: "diagnostics-unavailable",
    });
    process.exitCode = 1;
  }
}
