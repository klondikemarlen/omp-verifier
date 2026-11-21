import { prepareCloseoutHandoff } from "#root/omp-plugin/closeout-handoff.js";
import {
  checkCloseoutReceipts,
  MAX_CLOSEOUT_PATH_LENGTH,
  MAX_CLOSEOUT_RECEIPTS,
} from "#root/omp-plugin/closeout-summary.js";

const TOOL_LABEL = "Cleanup check";
const INDEPENDENT_STATUS = "Independent verifier: unconfirmed.";
const NEXT_CHECK = {
  PASS: "No action needed from you; the independent check belongs to the verifier.",
  FAIL: "Next: primary agent investigates and rechecks; ask before any action outside existing authorization.",
  BLOCKED: "Next: primary agent restores the missing prerequisite or asks the user if needed.",
};

export function registerCloseoutTool(pi, verifyReceipt) {
  const { zod } = pi;
  const { Text } = pi.pi;
  const exactPath = zod.string().min(1).max(MAX_CLOSEOUT_PATH_LENGTH);

  pi.registerTool({
    name: "verifier_closeout",
    label: TOOL_LABEL,
    description: "Check final resource dispositions from exact prepared receipts, after cleanup or retention. Only the primary agent may call this read-only tool. It does not perform cleanup or establish an independent verdict.",
    approval: "read",
    loadMode: "essential",
    parameters: zod.object({
      repositoryRoot: exactPath.describe("Normalized absolute path to the declared repository root."),
      receiptPaths: zod.array(exactPath).min(1).max(MAX_CLOSEOUT_RECEIPTS)
        .describe("Exact normalized absolute receipt paths returned by closeout prepare for this repository and task."),
    }).strict(),
    async execute(_toolCallId, { repositoryRoot, receiptPaths }, _signal, _onUpdate, ctx) {
      if (ctx?.agent?.kind !== "main") {
        throw new Error("Only the primary agent may run verifier_closeout.");
      }

      const handoffId = await prepareCloseoutHandoff({
        repositoryRoot,
        receiptPaths,
      });
      const details = await checkCloseoutReceipts({
        repositoryRoot,
        receiptPaths,
        verifyReceipt,
      });
      const report = describeCloseout(details);
      return {
        content: [
          {
            type: "text",
            text: [...reportLines(report), `Independent check: closeout review ${handoffId}`].join("\n"),
          },
        ],
        details: {
          ...details,
          handoffId,
        },
        isError: details.status !== "PASS",
      };
    },
    renderCall(_args, _options, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(TOOL_LABEL)), 0, 0);
    },
    renderResult(result, { expanded }, _theme, args) {
      const report = describeCloseout(result.details);
      const lines = reportLines(report);
      if (expanded) {
        const evidence = receiptEvidence(result.details, args);
        if (evidence.length > 0) {
          lines.push("", ...evidence);
        }
      } else if (result.details || (
        Array.isArray(args?.receiptPaths) && args.receiptPaths.some(receiptPath => typeof receiptPath === "string")
      )) {
        lines.push("Expand tool output for receipt evidence.");
      }
      return new Text(lines.join("\n"), 0, 0);
    },
    // TSP uses semantic views, not renderCall/renderResult. Without this hook its generic head displays args.
    describeResult(result, _options, args) {
      const report = describeCloseout(result.details);
      const evidence = receiptEvidence(result.details, args);
      return {
        tool: {
          title: TOOL_LABEL,
          target: report.primary,
          targetKind: "text",
          meta: report.problem ? [INDEPENDENT_STATUS, report.problem] : [INDEPENDENT_STATUS],
          note: report.nextCheck,
        },
        preview: "none",
        body: [
          {
            k: "text",
            p: {
              text: [...reportLines(report), "", ...evidence].join("\n"),
              wrap: "word",
            },
          },
        ],
      };
    },
  });
}

function describeCloseout(details) {
  if (!details) {
    return {
      primary: "Primary: BLOCKED — no closeout evidence was returned.",
      nextCheck: "Next: primary agent checks the repository and receipt paths and restores verifier access as needed.",
    };
  }

  const { status, checkedResources, receipts } = details;
  const receiptLabel = receipts.length === 1 ? "receipt" : "receipts";
  const observationLabel = checkedResources === 1 ? "observation" : "observations";
  const observations = checkedResources === 0
    ? "no resource observations verified"
    : `${checkedResources} resource ${observationLabel} checked`;
  const problem = receipts.find(receipt => receipt.status === status)?.problem;
  return {
    primary: `Primary: ${status} — ${receipts.length} ${receiptLabel}, ${observations}.`,
    problem,
    nextCheck: NEXT_CHECK[status],
  };
}

function reportLines({ primary, problem, nextCheck }) {
  const lines = [primary, INDEPENDENT_STATUS];
  if (problem) {
    lines.push(problem);
  }
  lines.push(nextCheck);
  return lines;
}

function receiptEvidence(details, args) {
  if (details) {
    return details.receipts.map(({ receiptPath, status, summary, problem }) => {
      const receipt = `${status}: ${displayPath(receiptPath)}\n  ${summary}`;
      if (problem) {
        return `${receipt}\n  ${problem}`;
      }
      return receipt;
    });
  }

  if (!Array.isArray(args?.receiptPaths)) {
    return [];
  }
  return args.receiptPaths.filter(receiptPath => typeof receiptPath === "string")
    .map(receiptPath => `UNCONFIRMED: ${displayPath(receiptPath)}`);
}

function displayPath(receiptPath) {
  // Keep terminal controls inert, even in arguments from a rejected call.
  return receiptPath.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, character => `\\u{${character.codePointAt(0).toString(16)}}`);
}
