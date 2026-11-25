import { isAbsolute, resolve } from "node:path";

export const MAX_CLOSEOUT_RECEIPTS = 8;
export const MAX_CLOSEOUT_PATH_LENGTH = 4_000;

const RESOURCE_CLOSEOUT_ID = "verifier:resource-closeout";
const MAX_DECLARED_RESOURCES = 64;
const STATUS_PRIORITY = {
  PASS: 0,
  BLOCKED: 1,
  FAIL: 2,
};

export async function checkCloseoutReceipts({ repositoryRoot, receiptPaths, verifyReceipt }) {
  const exactReceiptPaths = validateCloseoutInputs(repositoryRoot, receiptPaths);

  let status = "PASS";
  let checkedResources = 0;
  const receipts = [];
  for (const receiptPath of exactReceiptPaths) {
    const receipt = await checkReceipt(repositoryRoot, receiptPath, verifyReceipt, exactReceiptPaths);
    checkedResources += receipt.checkedResources;
    status = strongerStatus(status, receipt.status);
    receipts.push({
      receiptPath,
      status: receipt.status,
      summary: receipt.summary,
      ...(receipt.problem && {
        problem: receipt.problem,
      }),
      ...(receipt.nextCheck && {
        nextCheck: receipt.nextCheck,
      }),
    });
  }
  return {
    status,
    checkedResources,
    receipts,
  };
}

export function validateCloseoutInputs(repositoryRoot, receiptPaths) {
  requireAbsolutePath(repositoryRoot, "repositoryRoot");
  if (!Array.isArray(receiptPaths) || receiptPaths.length < 1 || receiptPaths.length > MAX_CLOSEOUT_RECEIPTS) {
    throw new RangeError(`Provide between 1 and ${MAX_CLOSEOUT_RECEIPTS} exact closeout receipt paths`);
  }

  const exactReceiptPaths = new Set();
  for (const receiptPath of receiptPaths) {
    requireAbsolutePath(receiptPath, "receipt path");
    exactReceiptPaths.add(receiptPath);
  }
  return exactReceiptPaths;
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || value.length > MAX_CLOSEOUT_PATH_LENGTH ||
      /[\p{Cc}\u2028\u2029]/u.test(value) || !isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute path of at most ${MAX_CLOSEOUT_PATH_LENGTH} characters`);
  }
}

async function checkReceipt(repositoryRoot, receiptPath, verifyReceipt, exactReceiptPaths) {
  let result;
  try {
    result = await verifyReceipt(repositoryRoot, receiptPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : error;
    const reason = evidenceExcerpt(message, exactReceiptPaths, 160);
    const problem = reason
      ? `Verifier could not return evidence: ${reason}`
      : "Verifier could not return evidence; check the launcher and repository access, then retry.";
    return unavailableReceipt(problem);
  }

  const receipt = summarizeReceipt(result, exactReceiptPaths);
  if (!receipt) {
    return unavailableReceipt("Verifier returned invalid closeout evidence; rerun the closeout check with the installed verifier.");
  }
  return receipt;
}

function unavailableReceipt(problem) {
  return {
    status: "BLOCKED",
    checkedResources: 0,
    summary: "No valid receipt evidence",
    problem,
  };
}

function summarizeReceipt(result, exactReceiptPaths) {
  if (result?.id !== RESOURCE_CLOSEOUT_ID || !isCloseoutStatus(result.status)) {
    return;
  }

  const { status, dispositions } = result;
  const summary = evidenceExcerpt(result.summary, exactReceiptPaths, 160);
  if (!summary) {
    return;
  }

  // The CLI also emits a receipt-level BLOCKED result before any resource can be attested.
  if (status === "BLOCKED" && dispositions === undefined) {
    const problem = evidenceExcerpt(result.evidence, exactReceiptPaths, 200);
    if (!problem) {
      return;
    }
    return {
      status,
      checkedResources: 0,
      summary,
      problem,
      nextCheck: evidenceExcerpt(result.nextCheck, exactReceiptPaths, 800),
    };
  }

  if (!Array.isArray(dispositions) || dispositions.length < 1 || dispositions.length > MAX_DECLARED_RESOURCES) {
    return;
  }

  let observedStatus = "PASS";
  let checkedResources = 0;
  let firstProblem;
  for (const disposition of dispositions) {
    if (!isCloseoutStatus(disposition?.status)) {
      return;
    }

    if (disposition.status !== "BLOCKED") {
      checkedResources += 1;
    }
    if (STATUS_PRIORITY[disposition.status] > STATUS_PRIORITY[observedStatus]) {
      observedStatus = disposition.status;
      firstProblem = disposition;
    }
  }
  if (observedStatus !== status) {
    return;
  }

  if (!firstProblem) {
    return {
      status,
      checkedResources,
      summary,
    };
  }

  const resourceId = evidenceExcerpt(firstProblem.id, exactReceiptPaths, 48);
  const evidence = evidenceExcerpt(firstProblem.evidence, exactReceiptPaths, 150);
  if (!resourceId || !evidence) {
    return;
  }
  return {
    status,
    checkedResources,
    summary,
    problem: `${resourceId}: ${evidence}`,
    nextCheck: evidenceExcerpt(result.nextCheck, exactReceiptPaths, 800),
  };
}

function isCloseoutStatus(status) {
  return typeof status === "string" && Object.hasOwn(STATUS_PRIORITY, status);
}

function strongerStatus(left, right) {
  if (STATUS_PRIORITY[right] > STATUS_PRIORITY[left]) {
    return right;
  }
  return left;
}

function evidenceExcerpt(value, exactReceiptPaths, limit) {
  if (typeof value !== "string") {
    return;
  }
  for (const receiptPath of exactReceiptPaths) {
    if (receiptPath.length > 1) {
      value = value.replaceAll(receiptPath, "[receipt path]");
    }
  }
  const line = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (line.length > limit) {
    return `${line.slice(0, limit - 1).trimEnd()}…`;
  }
  return line || undefined;
}
