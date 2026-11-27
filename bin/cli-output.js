import { retainFindingsResults } from "#root/omp-plugin/findings-report.js";
import { formatVerificationResults } from "#root/omp-plugin/reporters.js";
import { recordSemanticReviewPage } from "#root/omp-plugin/semantic-evaluations.js";
import {
  buildSemanticReviewPage,
  formatSemanticReviewPage,
  serializeSemanticReviewResults,
} from "#root/omp-plugin/semantic-review-pages.js";

export function writeJson(value, { pretty = false } = {}) {
  const output = JSON.stringify(value, null, pretty ? 2 : undefined);
  process.stdout.write(`${output}\n`);
}

export async function writeResults(results, {
  reporter = "json",
  failuresOnly = false,
  pageIndex = 0,
  review = false,
  inlineReviewPage = true,
} = {}) {
  if (process.env.OMP_VERIFIER_GENERATION) {
    const generation = JSON.parse(process.env.OMP_VERIFIER_GENERATION);
    results = results.map(result => ({
      ...result,
      generation,
    }));
  }

  const hasFailures = results.some(result => result.status === "FAIL" || result.status === "BLOCKED");
  let reported = results;
  if (failuresOnly) {
    reported = results.filter(result =>
      ["FAIL", "BLOCKED", "PENDING", "SUPERSEDED", "WAIVED"].includes(result.status),
    );
  }

  let output;
  let reviewPage;
  if (inlineReviewPage && reporter === "text" && reported.length === 1 && reported[0]?.reviewRequest) {
    const result = reported[0];
    let currentPageIndex = pageIndex;
    if (result.evaluation?.supersededBy) currentPageIndex = 0;
    else if (result.reviewProgress?.nextPage !== undefined) currentPageIndex = result.reviewProgress.nextPage;

    reviewPage = result.reviewPage ?? buildSemanticReviewPage(result, currentPageIndex);
    output = formatSemanticReviewPage(reviewPage, {
      resumed: result.reviewPage !== undefined,
    });
  } else if (reporter === "text") {
    output = formatVerificationResults(reported);
  } else if (review) {
    output = serializeSemanticReviewResults(reported);
  } else {
    output = JSON.stringify(reported);
  }

  if (output) {
    await new Promise((resolve, reject) => {
      process.stdout.write(`${output}\n`, error => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (reviewPage && reported[0].status === "PENDING") {
      const cwd = process.cwd();
      await recordSemanticReviewPage({
        cwd,
        page: reviewPage,
      });
    }
    if (process.env.OMP_VERIFIER_RETAIN_FINDINGS === "1") {
      await retainFindingsForAdvice(reported);
    }
  }
  process.exitCode = hasFailures ? 1 : 0;
}

async function retainFindingsForAdvice(results) {
  let captures;
  try {
    captures = await retainFindingsResults(results);
  } catch {
    process.stderr.write("Verifier findings capture unavailable in this OMP profile; use the original results above.\n");
    return;
  }

  for (const { id, checkId } of captures) {
    process.stderr.write(`Verifier findings capture ${id} (${checkId})\n`);
  }
}
