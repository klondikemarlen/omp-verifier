import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { saveTimingRun } from "#root/omp-plugin/timing-history.js";

// A manual run dispatches checks concurrently. Keep their clocks independent
// and avoid threading analytics state through the verification/selection APIs.
const activeRun = new AsyncLocalStorage();

export async function timeVerificationRun(cwd, command, execute) {
  const started = performance.now();
  const run = {
    id: randomUUID(),
    command,
    startedAt: Date.now(),
    coordinatorMs: null,
    generation: process.env.OMP_VERIFIER_GENERATION ? JSON.parse(process.env.OMP_VERIFIER_GENERATION).id : null,
    checks: [],
  };
  // Analytics storage is not a prerequisite for checking source. If the
  // process stops hereafter, leave a start without inventing a finish time.
  await saveTimingRun(cwd, run).catch(() => {});
  const results = await activeRun.run(run, execute);
  run.coordinatorMs = Math.round(performance.now() - started);

  // Selection blockers, suppressed matches, and retained handoff findings
  // can be reported without executing a check during this invocation.
  for (const result of results) {
    if (!run.checks.some(check => check.id === result.id && check.status === result.status)) {
      // An unmatched manual selector is arbitrary caller input, not an installed check ID.
      const id = command === "verify" ? "unidentified" : result.id;
      run.checks.push(checkObservation(id, result, null));
    }
  }
  await saveTimingRun(cwd, run).catch(() => {});
  return results;
}

export async function timeVerificationCheck(id, execute) {
  const run = activeRun.getStore();
  if (!run) return execute();

  const started = performance.now();
  const result = await execute();
  const durationMs = Math.round(performance.now() - started);
  run.checks.push(checkObservation(id, result, durationMs));
  return result;
}

function checkObservation(id, result, durationMs) {
  const observation = {
    id,
    status: result?.status ?? "N/A",
    durationMs,
  };
  if (result?.reviewRequest?.requestId) {
    observation.requestId = result.reviewRequest.requestId;
  }
  return observation;
}
