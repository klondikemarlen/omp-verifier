export class MissingSemanticRequestState extends Error {
  constructor() {
    super("No semantic request state was found for the supplied check.");
  }
}

export function blocked(id, summary, evidence) {
  return { id, status: "BLOCKED", summary, ...(evidence ? { evidence } : {}) };
}

export function requestBlock(id, error) {
  const result = blocked(id || "semantic-evaluation", "Semantic request is unavailable", error.message);
  if (error instanceof MissingSemanticRequestState) {
    result.nextCheck = "Retry the exact command from the last review page footer in the owning checkout. If that command still reports missing state, report that prerequisite.";
  } else {
    result.nextCheck = "Restore the named request prerequisite, then prepare fresh verification with the original complete scope and actual delivery base. Do not reuse citations from an unavailable or stale request.";
  }
  return result;
}
