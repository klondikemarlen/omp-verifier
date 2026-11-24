import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { saveTimingRun } from "#root/omp-plugin/timing-history.js";

// A manual run dispatches checks concurrently. Keep their clocks independent
// and avoid threading analytics state through the verification/selection APIs.
const activeRun = new AsyncLocalStorage();
const timedOutResults = new WeakSet();
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

export function markVerificationTimeout(result) {
  // Record the coordinator's observation without changing the verdict payload.
  timedOutResults.add(result);
  return result;
}

function createTimingPublisher(cwd, run) {
  let writing;
  let pending = false;

  async function flush() {
    while (pending) {
      pending = false;
      // There is only one write in flight. Changes that arrive during it
      // share the next snapshot, with no queue of obsolete records.
      const snapshot = {
        ...run,
        checks: [...run.checks],
      };
      await saveTimingRun(cwd, snapshot).catch(() => {});
    }
    writing = undefined;
  }

  return function publish() {
    pending = true;
    writing ??= Promise.resolve().then(flush);
    return writing;
  };
}

export async function timeVerificationRun(cwd, command, execute, progress) {
  const runStarted = performance.now();
  const run = {
    id: randomUUID(),
    command,
    startedAt: Date.now(),
    coordinatorMs: null,
    generation: process.env.OMP_VERIFIER_GENERATION ? JSON.parse(process.env.OMP_VERIFIER_GENERATION).id : null,
    checks: [],
  };
  const cancellation = isCoordinator() ? new AbortController() : null;
  const publish = createTimingPublisher(cwd, run);
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
    run.coordinatorMs = null;
    run.cancelledAfterMs = Math.round(performance.now() - runStarted);
    run.cancellationSignal = signal;
    progress?.cancelled(signal, run.cancelledAfterMs);
    cancellation.abort();
    await publish();
    stopObserving();
    process.kill(process.pid, signal);
  }

  if (cancellation) {
    process.on("SIGINT", observeCancellation);
    process.on("SIGTERM", observeCancellation);
  }

  try {
    progress?.started();
    const execution = activeRun.run({
      run,
      publish,
      progress,
      runStarted,
      signal: cancellation?.signal,
    }, execute);
    publish();
    const results = await execution;
    if (interruption) {
      return interruption;
    }

    run.coordinatorMs = Math.round(performance.now() - runStarted);
    recordUnexecutedChecks(run, results);
    await publish();
    if (interruption) {
      return interruption;
    }

    progress?.finished(run.coordinatorMs);
    return results;
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

export async function timeVerificationCheck(id, execute, timeoutMs) {
  const context = activeRun.getStore();
  if (!context) {
    return execute();
  }

  const { run, signal, publish, progress, runStarted } = context;
  signal?.throwIfAborted();
  const started = performance.now();
  const startedAt = Date.now();
  const execution = execute();
  const observation = {
    id,
    status: "STARTED",
    startedAt,
    durationMs: null,
  };
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
    observation.timeoutMs = timeoutMs;
  }
  const index = run.checks.push(observation) - 1;
  progress?.checkStarted(observation, Math.round(started - runStarted));
  publish();

  const result = await execution;
  signal?.throwIfAborted();
  const durationMs = Math.round(performance.now() - started);
  const returnedCheck = checkObservation(id, result, durationMs);
  const completed = {
    ...observation,
    ...returnedCheck,
  };
  if (observation.timeoutMs !== undefined && timedOutResults.has(result)) {
    completed.timedOut = true;
  }
  run.checks[index] = completed;
  progress?.checkReturned(completed);
  publish();
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
