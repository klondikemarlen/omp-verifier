export function buildBootPlan({ repo, pr, basePort = 3000 }) {
  const port = basePort + (pr % 1000);
  return {
    repo,
    pr,
    port,
    env: {
      PORT: String(port),
      VERIFIER_PR: String(pr),
    },
  };
}
