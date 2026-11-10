import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
  recordSemanticReviewPage,
} from "#root/omp-plugin/semantic-evaluations.js";
import { buildSemanticReviewPage } from "#root/omp-plugin/semantic-review-pages.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verifications.js";

test("when documentation capture has an oversized retained selector and a final omitted line, premature verdicts preserve bounded recovery", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-documentation-"));
  const packagePath = join(root, "plugins", "publisher");
  const adoption = `${"Use the documented adoption boundary. ".repeat(12)}\n`.repeat(143);
  const example = `${"Keep example setup reproducible. ".repeat(3)}\n`.repeat(234);
  const changedPaths = ["README.md", "docs/adoption.md", "example-app/README.md", "tests/README.md"];
  const oversizedSelector = "docs/adoption.md#L1-L50";

  try {
    await mkdir(packagePath, { recursive: true });
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "example-app"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "README.md"), "Start with the adoption guide.\n");
    await writeFile(join(root, "docs/adoption.md"), adoption);
    await writeFile(join(root, "example-app/README.md"), example);
    await writeFile(join(root, "tests/README.md"), "Run tests using the documented runner.\n");
    await writeFile(join(packagePath, "standard.md"), "Documentation directs readers to the appropriate guide.\n");
    await writeFile(join(packagePath, "contract.json"), JSON.stringify({
      version: 1,
      standardId: "publisher:documentation",
      source: "./standard.md",
      gold: "Documentation directs readers to the appropriate guide.",
      requiredContext: ["changed-code"],
      rubric: [{ id: "discovery", question: "Can readers find the appropriate guide?" }],
    }));
    await writeFile(join(packagePath, "package.json"), JSON.stringify({
      name: "publisher",
      version: "1.0.0",
      omp: {
        extensions: ["./index.js"],
        verifications: [{
          id: "publisher:documentation", label: "Documentation Discovery", description: "Assesses guide discovery.",
          mode: "agentic", contract: "./contract.json", pathTriggers: ["**/*.md"],
        }],
      },
    }));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline"], { cwd: root });
    const discovery = await discoverVerificationChecks({ packageDirectory: join(root, "plugins") });
    const prepared = await prepareSemanticEvaluation({
      check: discovery.checks[0],
      cwd: root,
      changedPaths,
      contextPaths: [
        oversizedSelector, "docs/adoption.md#L51-L80", "docs/adoption.md#L81-L110", "docs/adoption.md#L111-L144",
        "example-app/README.md#L1-L80", "example-app/README.md#L81-L160", "example-app/README.md#L161-L234",
      ],
    });
    const firstPage = buildSemanticReviewPage(prepared);
    for (let index = 0; index < firstPage.count; index += 1) {
      await recordSemanticReviewPage({ cwd: root, page: buildSemanticReviewPage(prepared, index) });
    }

    // Act
    const draft = {
      requestId: prepared.reviewRequest.requestId,
      status: "PASS",
      summary: "The documents direct readers to their guides.",
      rationale: "The root documentation links to the adoption guide.",
      citations: [{ path: "README.md", line: 1, quote: "Start with the adoption guide." }],
    };
    const prematurePass = await completeSemanticEvaluation({
      cwd: root, requestPath: prepared.reviewRequest.path, assessment: draft,
    });
    const prematureFail = await completeSemanticEvaluation({
      cwd: root, requestPath: prepared.reviewRequest.path, assessment: { ...draft, status: "FAIL" },
    });
    const recovered = await readSemanticEvaluation({
      cwd: root,
      requestPath: prematureFail.reviewRequest.path,
      removeContextPaths: [oversizedSelector],
      contextPaths: [
        "docs/adoption.md#L1-L10", "docs/adoption.md#L11-L20", "docs/adoption.md#L21-L30",
        "docs/adoption.md#L31-L40", "docs/adoption.md#L41-L50", "example-app/README.md#L235-L235",
      ],
    });
    await recordSemanticReviewPage({ cwd: root, page: buildSemanticReviewPage(recovered) });
    const unread = await completeSemanticEvaluation({
      cwd: root,
      requestPath: recovered.reviewRequest.path,
      assessment: { ...draft, requestId: recovered.reviewRequest.requestId },
    });
    const renewedPageCount = buildSemanticReviewPage(recovered).count;
    for (let index = 1; index < renewedPageCount; index += 1) {
      await recordSemanticReviewPage({ cwd: root, page: buildSemanticReviewPage(recovered, index) });
    }
    const completed = await completeSemanticEvaluation({
      cwd: root,
      requestPath: recovered.reviewRequest.path,
      assessment: { ...draft, requestId: recovered.reviewRequest.requestId },
    });

    // Assert
    assert.deepEqual(prepared.reviewRequest.context.changedCodeCoverage.find(record =>
      record.path === "example-app/README.md").omittedRanges, [[235, 235]]);
    assert.match(prepared.reviewRequest.context.changedCode.find(record =>
      record.path === "docs/adoption.md").reason, /excerpt exceeds/);
    for (const premature of [prematurePass, prematureFail]) {
      assert.equal(premature.status, "PENDING");
      assert.equal(premature.reviewRequest.requestId, prepared.reviewRequest.requestId);
      assert.equal(premature.reviewRequest.path, prepared.reviewRequest.path);
      assert.equal(premature.reviewProgress, undefined);
      assert.deepEqual(premature.reviewRequest.scope.changedPaths, changedPaths);
    }
    assert.notEqual(recovered.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.equal(recovered.reviewRequest.scope.contextPaths.includes(oversizedSelector), false);
    assert.deepEqual(recovered.reviewRequest.scope.changedPaths, changedPaths);
    assert.deepEqual(recovered.reviewRequest.missingContext, []);
    assert.equal(recovered.reviewRequest.context.changedCodeCoverage.every(record => record.complete), true);
    assert.equal(unread.status, "PENDING");
    assert.equal(unread.reviewProgress.nextPage, 1);
    assert.equal(completed.status, "PASS");
    assert.equal(completed.reviewRequest, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
