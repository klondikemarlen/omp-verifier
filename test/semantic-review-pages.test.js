import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSemanticReviewPage,
  formatSemanticReviewPage,
  serializeSemanticReviewResults,
} from "#root/omp-plugin/semantic-review-pages.js";

function reviewResult({ requestId = "request-123", path = "/tmp/semantic-review.json", sourceContent, startLine = 1 } = {}) {
  return {
    id: "publisher:alignment",
    status: "PENDING",
    summary: "Semantic evaluation is ready for assessment",
    evidence: "Review the captured evidence",
    reviewRequest: {
      requestId,
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
          files: [{
            path: "src/policy.js",
            size: Buffer.byteLength(sourceContent),
            sha256: "a".repeat(64),
          }],
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

test("when review evidence spans pages, the projected request is reconstructed without loss", () => {
  // Arrange
  const sourceLines = Array.from({ length: 500 }, (_, index) =>
    `export function applyPolicy${index + 1}(event) { return event.enabled && event.type === "policy-${index + 1}"; }`);
  const sourceContent = sourceLines.join("\n");
  const result = reviewResult({ sourceContent, startLine: 31 });
  const expectedView = JSON.parse(serializeSemanticReviewResults([result]));
  expectedView[0].reviewRequest.context.sourceInventory.files = ["src/policy.js"];

  // Act
  const pages = collectPages(result);
  const fragments = pages.map(page => page.content);
  const reconstructed = fragments.join("");
  const formatted = pages.map(formatSemanticReviewPage);

  // Assert
  assert.ok(pages.length > 1);
  assert.deepEqual(JSON.parse(reconstructed), expectedView);
  assert.equal(pages[0].startByte, 0);
  assert.equal(pages.at(-1).endByte, pages[0].totalBytes);
  assert.equal(pages.every((page, index) => page.endByte === pages[index + 1]?.startByte
    || index === pages.length - 1), true);
  assert.ok(formatted.every(page => Buffer.byteLength(page, "utf8") <= 24_000));
});

test("when the inventory is large, bounded review omits successful integrity metadata but retains paths and diagnostics", () => {
  // Arrange
  const result = reviewResult({ sourceContent: "export const policy = true;" });
  const capturedFiles = Array.from({ length: 1_200 }, (_, index) => ({
    path: `src/deeply/nested/source/candidate-${index}.js`,
    sha256: "f".repeat(64),
    size: 1234,
  }));
  const unreadableFile = {
    path: "src/inaccessible.js",
    unreadable: "permission denied",
  };
  const unclassifiedFile = {
    path: "src/diagnostic.js",
    sha256: "a".repeat(64),
    size: 0,
    note: "inspection did not complete",
  };
  const incompleteFile = {
    path: "src/unknown.js",
    size: 12,
  };
  const sourceInventory = {
    complete: false,
    omittedFiles: 2,
    note: "Inventory read limit reached.",
    files: [...capturedFiles, unreadableFile, unclassifiedFile, incompleteFile],
  };
  result.reviewRequest.context.sourceInventory = sourceInventory;

  // Act
  const pages = collectPages(result);
  const reconstructed = JSON.parse(pages.map(page => page.content).join(""));
  const fullExport = serializeSemanticReviewResults([result], { compact: true });

  // Assert
  assert.deepEqual(reconstructed[0].reviewRequest.context.sourceInventory, {
    complete: false,
    omittedFiles: 2,
    note: "Inventory read limit reached.",
    files: [...capturedFiles.map(file => file.path), unreadableFile, unclassifiedFile, incompleteFile],
  });
  assert.deepEqual(JSON.parse(fullExport)[0].reviewRequest.context.sourceInventory, sourceInventory);
  assert.equal(result.reviewRequest.context.sourceInventory.files[0].sha256, "f".repeat(64));
  assert.ok(pages[0].totalBytes < Buffer.byteLength(fullExport) / 2);
  assert.ok(pages.every(page => Buffer.byteLength(formatSemanticReviewPage(page)) <= 24_000));
});

test("when a long review line contains multibyte characters, page boundaries preserve UTF-8", () => {
  // Arrange
  const sourceContent = `export const title = "${"界🙂é".repeat(8_000)}";`;
  const result = reviewResult({ sourceContent });
  const expectedView = JSON.parse(serializeSemanticReviewResults([result]));
  expectedView[0].reviewRequest.context.sourceInventory.files = ["src/policy.js"];
  const expectedJson = JSON.stringify(expectedView);

  // Act
  const pages = collectPages(result);
  const fragments = pages.map(page => page.content);
  const reconstructed = fragments.join("");

  // Assert
  assert.ok(pages.length > 1);
  assert.equal(reconstructed, expectedJson);
  assert.equal(Buffer.concat(fragments.map(fragment => Buffer.from(fragment, "utf8"))).toString("utf8"), expectedJson);
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

test("when exact request IDs are enabled, batch page and checkpoint commands use the full UUID without changing receipts", t => {
  // Arrange
  const previousCapability = process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT;
  t.after(() => {
    if (previousCapability === undefined) delete process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT;
    else process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT = previousCapability;
  });
  process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT = "0";
  const requestId = "21883d11-72b1-4adc-98f0-ea1393b16c59";
  const path = "/tmp/cache/8a3b6ed1-e1ef-417d-a0f4-398192821271.other-request.json";
  const result = reviewResult({
    requestId,
    path,
    sourceContent: "export const policy = true;\n".repeat(1_000),
  });
  result.reviewRequest.continuation = { phase: "batch", batchIndex: 2 };
  const [legacyFirst] = collectPages(result);
  const legacyOutput = formatSemanticReviewPage(legacyFirst);

  // Act
  process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT = "1";
  const pages = collectPages(result);
  const first = formatSemanticReviewPage(pages[0], { resumed: true });
  const last = formatSemanticReviewPage(pages.at(-1));

  // Assert
  assert.deepEqual(pages[0], legacyFirst);
  assert.ok(legacyOutput.includes(`Request path: ${path}\n`));
  assert.ok(legacyOutput.includes(` review '${path}' --reporter text --batch 2 --page 1`));
  assert.doesNotMatch(first, /^Request path:/m);
  assert.ok(first.includes(`Request ID: ${requestId}\n`));
  assert.ok(first.includes(` review '${requestId}' --reporter text --batch 2 --page 1`));
  assert.ok(last.includes(` evaluate '${requestId}' --assessment - --reporter text --failures-only`));
  assert.ok(last.includes("batchIndex: 2"));
  assert.ok([first, last].every(page => Buffer.byteLength(page) <= 24_000));
});
