import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { confirmFreshReviewerTarget } from "#root/omp-plugin/fresh-reviewer-target.js";

const githubPullRequest = "https://github.com/upstream/project/pull/42";
const githubEndpoint = "gh api --hostname github.com repos/upstream/project/pulls/42";
const gitlabMergeRequest = "https://gitlab.example/team/subgroup/project/-/merge_requests/7";
const gitlabEndpoint = "glab api --hostname gitlab.example projects/team%2Fsubgroup%2Fproject/merge_requests/7";
const gitlabBranchEndpoint = "glab api --hostname gitlab.example projects/21/repository/branches/stack%2Fbase";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-verifier-review-target-"));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(cwd, {
      recursive: true,
      force: true,
    });
  });

  git(cwd, "init", "--quiet", "--initial-branch=main");
  git(cwd, "config", "user.name", "Fresh reviewer test");
  git(cwd, "config", "user.email", "fresh-reviewer@example.invalid");
  git(cwd, "commit", "--quiet", "--allow-empty", "-m", "base");
  const baseCommit = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "--quiet", "--create", "topic");
  git(cwd, "commit", "--quiet", "--allow-empty", "-m", "head");
  const headCommit = git(cwd, "rev-parse", "HEAD");

  const tools = join(cwd, "tools");
  const responses = join(tools, "responses.json");
  const calls = join(tools, "calls.log");
  await mkdir(tools);
  await writeFile(calls, "");
  for (const tool of ["gh", "glab"]) {
    await writeFile(join(tools, tool), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const key = [${JSON.stringify(tool)}, ...process.argv.slice(2)].join(" ");
appendFileSync(${JSON.stringify(calls)}, key + "\\n");
const response = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"))[key];
if (!response) process.exit(1);
console.log(JSON.stringify(response));
`, {
      mode: 0o755,
    });
  }
  process.env.PATH = [tools, originalPath].join(delimiter);

  return {
    cwd,
    delivery: {
      baseRef: "refs/heads/main",
      baseCommit,
      headCommit,
    },
    respond: data => writeFile(responses, JSON.stringify(data)),
    hostCalls: () => readFile(calls, "utf8"),
  };
}

function githubResponse(delivery) {
  return {
    number: 42,
    html_url: githubPullRequest,
    state: "open",
    base: {
      ref: "main",
      sha: delivery.baseCommit,
      repo: {
        full_name: "upstream/project",
      },
    },
    head: {
      sha: delivery.headCommit,
      repo: {
        full_name: "contributor/project",
      },
    },
  };
}

function gitlabResponse(delivery, targetTip) {
  return {
    [gitlabEndpoint]: {
      iid: 7,
      web_url: gitlabMergeRequest,
      state: "opened",
      target_branch: "stack/base",
      target_project_id: 21,
      sha: delivery.headCommit,
      diff_refs: {
        base_sha: "a".repeat(40),
      },
    },
    [gitlabBranchEndpoint]: {
      name: "stack/base",
      commit: {
        id: targetTip,
      },
    },
  };
}

test("when there is no captured delivery or PR argument, no live target is required", async () => {
  // Arrange
  const options = {};

  // Act
  const target = await confirmFreshReviewerTarget(options);

  // Assert
  assert.equal(target, null);
});

test("when a PR is supplied without captured delivery, confirmation is rejected", async () => {
  // Arrange
  const options = {
    pullRequest: githubPullRequest,
  };

  // Act
  const confirmation = confirmFreshReviewerTarget(options);

  // Assert
  await assert.rejects(confirmation, /require captured delivery review evidence/);
});

test("when the GitHub source fork is a fetch remote, the live PR target is confirmed", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "origin", "git@github.com:Contributor/Project.git");
  await respond({
    [githubEndpoint]: githubResponse(delivery),
  });

  // Act
  const target = await confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  assert.deepEqual(target, {
    url: githubPullRequest,
    targetBranch: "main",
    baseCommit: delivery.baseCommit,
    headCommit: delivery.headCommit,
  });
});

test("when the only GitHub remote is an unrelated repository, confirmation is rejected", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "origin", "https://github.com/unrelated/project.git");
  await respond({
    [githubEndpoint]: githubResponse(delivery),
  });

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  await assert.rejects(confirmation, /no checkout fetch remote matches/);
});

test("when the checkout has no fetch remote on the PR host, the host is not queried", async t => {
  // Arrange
  const { cwd, delivery, hostCalls } = await fixture(t);
  git(cwd, "remote", "add", "origin", "https://unrelated.example/upstream/project.git");

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  await assert.rejects(confirmation, /host does not match any fetch remote/);
  assert.equal(await hostCalls(), "");
});

test("when the GitHub pull request is closed, confirmation is rejected", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "upstream", "https://github.com/upstream/project.git");
  const pr = githubResponse(delivery);
  pr.state = "closed";
  await respond({
    [githubEndpoint]: pr,
  });

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  await assert.rejects(confirmation, /no longer open/);
});

test("when the GitHub pull request head advances, confirmation is rejected", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "upstream", "https://github.com/upstream/project.git");
  const pr = githubResponse(delivery);
  pr.head.sha = "b".repeat(40);
  await respond({
    [githubEndpoint]: pr,
  });

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  await assert.rejects(confirmation, /live PR\/MR head commit no longer matches/);
});

test("when the GitHub pull request target branch changes, confirmation is rejected", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "upstream", "https://github.com/upstream/project.git");
  const pr = githubResponse(delivery);
  pr.base.ref = "release";
  await respond({
    [githubEndpoint]: pr,
  });

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  await assert.rejects(confirmation, /live PR\/MR target branch does not match/);
});

test("when the local base ref moves but the remote does not, confirmation is rejected", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "upstream", "https://github.com/upstream/project.git");
  git(cwd, "branch", "--force", "main", "HEAD");
  await respond({
    [githubEndpoint]: githubResponse(delivery),
  });

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  await assert.rejects(confirmation, /owning checkout base or HEAD no longer matches/);
});

test("when the live GitLab target branch tip matches the captured base, the MR target is confirmed", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "upstream", "ssh://git@gitlab.example/team/subgroup/project.git");
  await respond(gitlabResponse(delivery, delivery.baseCommit));

  // Act
  const target = await confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: gitlabMergeRequest,
    targetBranch: "stack/base",
  });

  // Assert
  assert.deepEqual(target, {
    url: gitlabMergeRequest,
    targetBranch: "stack/base",
    baseCommit: delivery.baseCommit,
    headCommit: delivery.headCommit,
  });
});

test("when the GitLab source fork is a fetch remote, the live MR target is confirmed", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "origin", "git@gitlab.example:contributor/project.git");
  const responses = gitlabResponse(delivery, delivery.baseCommit);
  responses[gitlabEndpoint].source_project_id = 25;
  responses["glab api --hostname gitlab.example projects/25"] = {
    id: 25,
    path_with_namespace: "contributor/project",
  };
  await respond(responses);

  // Act
  const target = await confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: gitlabMergeRequest,
    targetBranch: "stack/base",
  });

  // Assert
  assert.deepEqual(target, {
    url: gitlabMergeRequest,
    targetBranch: "stack/base",
    baseCommit: delivery.baseCommit,
    headCommit: delivery.headCommit,
  });
});

test("when the GitLab target branch advances but the diff merge base does not, confirmation is rejected", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "upstream", "https://gitlab.example/team/subgroup/project.git");
  const responses = gitlabResponse(delivery, "b".repeat(40));
  responses[gitlabEndpoint].diff_refs.base_sha = delivery.baseCommit;
  await respond(responses);

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: gitlabMergeRequest,
    targetBranch: "stack/base",
  });

  // Assert
  await assert.rejects(confirmation, /live PR\/MR base commit no longer matches/);
});

test("when the host is unavailable, local refs alone cannot confirm the PR target", async t => {
  // Arrange
  const { cwd, delivery, respond } = await fixture(t);
  git(cwd, "remote", "add", "upstream", "https://github.com/upstream/project.git");
  await respond({});

  // Act
  const confirmation = confirmFreshReviewerTarget({
    cwd,
    delivery,
    pullRequest: githubPullRequest,
    targetBranch: "main",
  });

  // Assert
  await assert.rejects(confirmation, /gh could not confirm the live pull request/);
});
