import { fileURLToPath } from "node:url";

import { tryClaimRequestLease } from "#root/omp-plugin/file-lease.js";
import { runFreshReviewer } from "#root/omp-plugin/fresh-reviewer-process.js";
import { confirmFreshReviewerTarget } from "#root/omp-plugin/fresh-reviewer-target.js";
import { readCheckpointHandoffTarget, readSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";

export async function resumeCheckpoint({ cwd, requestPath, pullRequest, targetBranch, waiver }, dispatch = runFreshReviewer) {
  const target = await readCheckpointHandoffTarget({
    cwd,
    requestPath,
  });
  const confirmTarget = () => confirmFreshReviewerTarget({
    cwd: target.repositoryRoot,
    delivery: target.delivery,
    pullRequest,
    targetBranch,
  });
  const readCurrent = () => readSemanticEvaluation({
    cwd: target.repositoryRoot,
    requestPath: target.requestPath,
    waiver,
  });
  const lease = await tryClaimRequestLease(target.requestPath);
  if (!lease) {
    throw new Error("Another assessment or fresh reviewer already owns this checkpoint");
  }

  try {
    const reviewTarget = await confirmTarget();
    const current = await readCurrent();
    if (!current.reviewRequest && current.evaluation?.requestId === target.requestId && !current.evaluation.supersededBy) {
      throw new Error("The request was assessed before the fresh reviewer could start");
    }

    if (current.reviewRequest?.requestId !== target.requestId) {
      return current;
    }

    const coordinator = process.env.OMP_VERIFIER_COORDINATOR ?? fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
    await dispatch({
      cwd: target.repositoryRoot,
      requestPath: target.requestPath,
      coordinator,
      reviewTarget,
    });

    // A completed child process proves neither freshness nor an accepted assessment.
    await confirmTarget();
    return await readCurrent();
  } finally {
    await lease.close();
  }
}
