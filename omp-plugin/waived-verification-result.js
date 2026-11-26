export function waivedVerificationResult({ id, requestId }) {
  return {
    id,
    status: "WAIVED",
    summary: "Verification waived by user; no verdict was produced",
    evidence: `User authorization in request ${requestId}.`,
  };
}

export default waivedVerificationResult;
