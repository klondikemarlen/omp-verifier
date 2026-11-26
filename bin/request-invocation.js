import { readRequestIntent, SupersededRequestIntent } from "#root/omp-plugin/request-intent.js";
import { waivedVerificationResult } from "#root/omp-plugin/waived-verification-result.js";

export function addRequestOption(command) {
  return command.option("--request <intent-handle>", "current host-injected request intent");
}

export async function resolveVerificationInvocation(request, gateId, { allowWholeRunWaiver = true, invalidNextCheck } = {}) {
  if (request === undefined) return {};

  let intent;
  try {
    intent = await readRequestIntent(request);
  } catch (error) {
    if (error instanceof SupersededRequestIntent) {
      return {
        result: {
          id: "verifier:request-intent",
          status: "SUPERSEDED",
          summary: "Historical request; no checks ran and no verdict was produced",
          evidence: error.message,
          nextCheck: "Do not retry this historical invocation. Only if the current request needs verification, use its host-injected handle and current scope.",
        },
      };
    }

    return {
      result: {
        id: "verifier:request-intent",
        status: "BLOCKED",
        summary: "Request intent could not be verified",
        evidence: error.message,
        nextCheck: invalidNextCheck ?? "Use the active request's host-injected handle and explicit scope.",
      },
    };
  }

  if (intent.waiver === undefined) {
    return {
      intent,
    };
  }

  const waiver = {
    id: intent.waiver,
    requestId: intent.requestId,
  };
  if ((allowWholeRunWaiver && waiver.id === "verification") || waiver.id === gateId) {
    return {
      result: waivedVerificationResult(waiver),
    };
  }

  return {
    intent,
    waiver,
  };
}
