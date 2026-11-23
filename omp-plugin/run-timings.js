import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { saveTimingRun } from "#root/omp-plugin/timing-history.js";

// A manual run dispatches checks concurrently. Keep their clocks independent
// and avoid threading analytics state through the verification/selection APIs.
const activeRun = new AsyncLocalStorage();
const coordinatorPath = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));

function isCoordinator() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === coordinatorPath;
  } catch {
    return false;
  }
}

export function verificationCancellationSignal() {
  return activeRun.getStore()?.signal;
}

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
  const cancellation = isCoordinator() ? new AbortController() : null;
  let timingWrite;
  let interruption;

  function stopObserving() {
    process.off("SIGINT", observeCancellation);
    process.off("SIGTERM", observeCancellation);
  }

  async function observeCancellation(signal) {
    if (interruption) return;

    // Only the signal exit can finish this invocation. Provider settlement
    // while analytics is being saved must not resume the CLI reporter.
    interruption = new Promise(() => {});
    const cancelledRun = {
      ...run,
      coordinatorMs: null,
      cancelledAfterMs: Math.round(performance.now() - started),
      cancellationSignal: signal,
    };
    cancellation.abort();
    await timingWrite;
    await saveTimingRun(cwd, cancelledRun).catch(() => {});
    stopObserving();
    process.kill(process.pid, signal);
  }

  if (cancellation) {
    process.on("SIGINT", observeCancellation);
    process.on("SIGTERM", observeCancellation);
  }

  try {
    // Analytics is best-effort. A process that disappears without an
    // observable signal leaves only its start.
    timingWrite = saveTimingRun(cwd, run).catch(() => {});
    await timingWrite;
    if (interruption) {
      return interruption;
    }

    const results = await activeRun.run({
      run,
      signal: cancellation?.signal,
    }, execute);
    if (interruption) {
      return interruption;
    }

    run.coordinatorMs = Math.round(performance.now() - started);
    recordUnexecutedChecks(run, results);
    timingWrite = saveTimingRun(cwd, run).catch(() => {});
    await timingWrite;
    return interruption ?? results;
  } catch (error) {
    if (interruption) {
      return interruption;
    }

    throw error;
  } finally {
    if (cancellation && !interruption) stopObserving();
  }
}

function recordUnexecutedChecks(run, results) {
  // Selection blockers, suppressed matches, and retained handoff findings
  // can be reported without executing a check during this invocation.
  for (const result of results) {
    if (!run.checks.some(check => check.id === result.id && check.status === result.status)) {
      // An unmatched manual selector is arbitrary caller input, not an installed check ID.
      const id = run.command === "verify" ? "unidentified" : result.id;
      run.checks.push(checkObservation(id, result, null));
    }
  }
}

export async function timeVerificationCheck(id, execute) {
  const context = activeRun.getStore();
  if (!context) {
    return execute();
  }

  const { run, signal } = context;
  signal?.throwIfAborted();
  const started = performance.now();
  const result = await execute();
  signal?.throwIfAborted();
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
