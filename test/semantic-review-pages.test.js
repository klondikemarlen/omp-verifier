import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSemanticReviewPage,
  formatSemanticReviewPage,
  serializeSemanticReviewResults,
} from "#root/omp-plugin/semantic-review-pages.js";

function reviewResult({ path = "/tmp/semantic-review.json", sourceContent, startLine = 1 } = {}) {
  return {
    id: "publisher:alignment",
    status: "BLOCKED",
    summary: "Semantic evaluation is ready for assessment",
    evidence: "Review the captured evidence",
    reviewRequest: {
      requestId: "request-123",
      path,
      version: 1,
      nonce: "nonce-456",
      check: {
        id: "publisher:alignment",
        label: "Module Boundary Alignment",
      },
      scope: {
        repositoryRoot: "/tmp/project",
        changedPaths: ["src/policy.js"],
        contextPaths: [],
        callerContextPaths: [],
      },
      missingContext: [],
      standard: {
        id: "publisher:alignment",
        source: "docs/standard.md",
        gold: "Changed code owns a meaningful invariant.",
        requiredContext: ["changed-code"],
        rubric: [{ id: "ownership", question: "What does this code own?" }],
        sourceDetails: {
          text: "The implementation owns policy lookup.\nIts caller boundary is explicit.",
        },
      },
      context: {
        changedPaths: ["src/policy.js"],
        changedCodeCoverage: [{ path: "src/policy.js", lineCount: sourceContent.split("\n").length, complete: true }],
        callerRetrieval: { inspectedFiles: 1, omittedFiles: 0 },
        evidenceBudget: { maxBytes: 256000, usedBytes: Buffer.byteLength(sourceContent), usedFiles: 1 },
        evidenceTruncated: { callers: false, siblings: false },
        notes: [],
        missingChangedPaths: [],
        missingContextPaths: [],
        missingGuidancePaths: [],
        fingerprint: "context-fingerprint",
        changedCode: [{ path: "src/policy.js", startLine, content: sourceContent }],
        callers: { status: "none-found", explanation: "No caller source was found." },
        siblings: { status: "none-found", explanation: "No sibling source was found." },
        projectGuidance: { status: "none-found", explanation: "No project guidance was found." },
        guidanceRequirements: [],
        targetedContext: [],
        sourceInventory: {
          complete: true,
          files: [{ path: "src/policy.js", size: Buffer.byteLength(sourceContent), sha256: "source-hash" }],
        },
        siblingInventory: [],
        callerContextPaths: [],
      },
    },
  };
}

function collectPages(result) {
  const firstPage = buildSemanticReviewPage(result);
  const pages = [firstPage];
  for (let index = 1; index < firstPage.count; index += 1) {
    pages.push(buildSemanticReviewPage(result, index));
  }
  return pages;
}

test("when captured source is serialized for review, original citation coordinates are retained", () => {
  // Arrange
  const result = reviewResult({
    sourceContent: "export const policy = true;\nexport function allows(event) { return event.enabled; }",
    startLine: 41,
  });

  // Act
  const serialized = serializeSemanticReviewResults([result]);
  const decoded = JSON.parse(serialized);

  // Assert
  assert.deepEqual(decoded[0].reviewRequest.context.changedCode[0].content, {
    41: "export const policy = true;",
    42: "export function allows(event) { return event.enabled; }",
  });
  assert.deepEqual(decoded[0].reviewRequest.standard.sourceDetails.text, [
    "The implementation owns policy lookup.",
    "Its caller boundary is explicit.",
  ]);
});

test("when review evidence spans pages, the complete request is reconstructed without loss", () => {
  // Arrange
  const sourceLines = Array.from({ length: 500 }, (_, index) =>
    `export function applyPolicy${index + 1}(event) { return event.enabled && event.type === "policy-${index + 1}"; }`);
  const sourceContent = sourceLines.join("\n");
  const result = reviewResult({ sourceContent, startLine: 31 });
  const expectedView = serializeSemanticReviewResults([result]);

  // Act
  const pages = collectPages(result);
  const fragments = pages.map(page => page.content);
  const reconstructed = fragments.join("");
  const formatted = pages.map(formatSemanticReviewPage);

  // Assert
  assert.ok(pages.length > 1);
  assert.deepEqual(JSON.parse(reconstructed), JSON.parse(expectedView));
  assert.equal(pages[0].startByte, 0);
  assert.equal(pages.at(-1).endByte, pages[0].totalBytes);
  assert.equal(pages.every((page, index) => page.endByte === pages[index + 1]?.startByte
    || index === pages.length - 1), true);
  assert.ok(formatted.every(page => Buffer.byteLength(page, "utf8") <= 24_000));
});

test("when a long review line contains multibyte characters, page boundaries preserve UTF-8", () => {
  // Arrange
  const sourceContent = `export const title = "${"界🙂é".repeat(8_000)}";`;
  const result = reviewResult({ sourceContent });
  const expectedView = serializeSemanticReviewResults([result]);

  // Act
  const pages = collectPages(result);
  const fragments = pages.map(page => page.content);
  const reconstructed = fragments.join("");

  // Assert
  assert.ok(pages.length > 1);
  assert.equal(reconstructed, expectedView);
  assert.equal(Buffer.concat(fragments.map(fragment => Buffer.from(fragment, "utf8"))).toString("utf8"), expectedView);
  assert.ok(fragments.every(fragment => !fragment.includes("�")));
  assert.ok(pages.every(page => Buffer.byteLength(formatSemanticReviewPage(page), "utf8") <= 24_000));
});

test("when rendered source exceeds tool column limits, display continuations preserve every character", () => {
  // Arrange
  const title = '界🙂é"\\'.repeat(800);
  const sourceContent = `export const title = ${JSON.stringify(title)};`;
  const result = reviewResult({ sourceContent });

  // Act
  const rendered = formatSemanticReviewPage(buildSemanticReviewPage(result));
  const displayedFragment = rendered.split("JSON fragment:\n")[1].split("\nNext page index:")[0];
  const decoded = JSON.parse(displayedFragment.replace(/\\\n/g, ""));

  // Assert
  assert.equal(decoded[0].reviewRequest.context.changedCode[0].content[1], sourceContent);
  assert.ok(rendered.split("\n").every(line => Buffer.byteLength(line) <= 601));
  assert.ok(Buffer.byteLength(rendered) <= 24_000);
});

test("when a page index is invalid, review rejects it rather than returning partial evidence", () => {
  // Arrange
  const result = reviewResult({ sourceContent: "export const policy = true;" });
  const multiPageResult = reviewResult({ sourceContent: "export const policy = true;\n".repeat(500) });
  const pageCount = buildSemanticReviewPage(multiPageResult).count;

  // Act / Assert
  assert.throws(() => buildSemanticReviewPage(result, -1), RangeError);
  assert.throws(() => buildSemanticReviewPage(result, 1.5), RangeError);
  assert.throws(() => buildSemanticReviewPage(multiPageResult, pageCount), RangeError);
  assert.throws(() => buildSemanticReviewPage({ status: "BLOCKED" }), TypeError);
  assert.throws(() => buildSemanticReviewPage(reviewResult({
    path: "x".repeat(25_000),
    sourceContent: "export const policy = true;",
  })), RangeError);
});
