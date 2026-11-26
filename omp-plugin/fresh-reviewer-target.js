import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { deliveryGit } from "#root/omp-plugin/delivery-git.js";

const execute = promisify(execFile);
const GITHUB_HOST = "github.com";
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PATH_SEGMENT = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

export async function confirmFreshReviewerTarget({ cwd, delivery, pullRequest, targetBranch }) {
  if (delivery == null) {
    if (pullRequest == null && targetBranch == null) return null;

    throw new Error("PR/MR options require captured delivery review evidence");
  }

  const target = parseReviewUrl(pullRequest);
  if (!target || typeof targetBranch !== "string" || !targetBranch) {
    throw new Error("delivery review requires an identified HTTPS GitHub PR or GitLab MR URL and the exact target branch");
  }
  const capturedCommits = [delivery.baseCommit, delivery.headCommit];
  if (typeof delivery.baseRef !== "string" || !delivery.baseRef ||
      !capturedCommits.every(commit => typeof commit === "string" && COMMIT.test(commit))) {
    throw new Error("delivery review requires captured base and head commits");
  }

  await deliveryGit(cwd, ["check-ref-format", `refs/heads/${targetBranch}`]);
  const remoteProjects = await projectsOnHost(cwd, target.host);
  if (!remoteProjects.size) {
    throw new Error("PR/MR host does not match any fetch remote in the owning checkout");
  }

  let remoteBase;
  if (target.host === GITHUB_HOST) {
    remoteBase = await githubBase(cwd, target, remoteProjects, targetBranch, delivery.headCommit);
  } else {
    remoteBase = await gitlabBase(cwd, target, remoteProjects, targetBranch, delivery.headCommit);
  }
  if (remoteBase !== delivery.baseCommit) {
    throw new Error("live PR/MR base commit no longer matches the captured delivery base");
  }

  const [localBase, localHead] = await Promise.all([
    resolveCommit(cwd, delivery.baseRef),
    resolveCommit(cwd, "HEAD"),
  ]);
  if (localBase !== delivery.baseCommit || localHead !== delivery.headCommit) {
    throw new Error("owning checkout base or HEAD no longer matches the captured delivery");
  }

  return {
    url: pullRequest,
    targetBranch,
    baseCommit: delivery.baseCommit,
    headCommit: delivery.headCommit,
  };
}

function projectPath(host, path) {
  if (typeof path !== "string") return null;

  const segments = path.split("/");
  if (segments.length < 2 || !segments.every(segment => PATH_SEGMENT.test(segment))) return null;

  if (host === GITHUB_HOST) {
    if (segments.length !== 2) return null;

    return path.toLowerCase();
  }
  return path;
}

function parseReviewUrl(url) {
  if (typeof url !== "string" || url !== url.trim()) return null;

  const match = /^https:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]*)\/(.+)\/(pull|-\/merge_requests)\/([1-9][0-9]*)\/?$/.exec(url);
  if (!match) return null;

  const [, authority, path, route, number] = match;
  const host = authority.toLowerCase();
  const expectedRoute = host === GITHUB_HOST ? "pull" : "-/merge_requests";
  const project = projectPath(host, path);
  const id = Number(number);
  if (route !== expectedRoute || !project || !isId(id)) return null;

  return {
    host,
    project,
    id,
  };
}

function sameReview(url, target) {
  const observed = parseReviewUrl(url);
  return observed?.host === target.host && observed.project === target.project && observed.id === target.id;
}

function isId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

async function projectsOnHost(cwd, host) {
  const remotes = (await deliveryGit(cwd, ["remote"])).trimEnd();
  const projects = new Set();
  if (!remotes) return projects;

  for (const remote of remotes.split("\n")) {
    const url = (await deliveryGit(cwd, ["remote", "get-url", "--", remote])).replace(/\n$/, "");
    if (url !== url.trim()) continue;

    const match = /^(?:https|ssh):\/\/(?:[a-zA-Z0-9_.-]+@)?([a-zA-Z0-9.-]+)\/(.+)$/.exec(url) ||
      /^(?:[a-zA-Z0-9_.-]+@)?([a-zA-Z0-9.-]+):([^/].*)$/.exec(url);
    if (match?.[1].toLowerCase() !== host) continue;

    const path = match[2].replace(/\/$/, "").replace(/\.git$/, "");
    const project = projectPath(host, path);
    if (project) projects.add(project);
  }
  return projects;
}

async function resolveCommit(cwd, ref) {
  const value = await deliveryGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  return value.trim();
}

async function readHost(cwd, tool, host, endpoint, resource) {
  try {
    const { stdout } = await execute(tool, ["api", "--hostname", host, endpoint], {
      cwd,
      timeout: 15_000,
      maxBuffer: 2_000_000,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GLAB_PROMPT_DISABLED: "1",
      },
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${tool} is required to confirm the live ${resource}`, {
        cause: error,
      });
    }
    throw new Error(`${tool} could not confirm the live ${resource}; check host availability and API access`, {
      cause: error,
    });
  }
}

function requireOpenReview(isOpen, observedBranch, observedHead, targetBranch, headCommit) {
  if (!isOpen) throw new Error("identified PR/MR is no longer open");
  if (observedBranch !== targetBranch) throw new Error("live PR/MR target branch does not match the intended branch");
  if (observedHead !== headCommit) throw new Error("live PR/MR head commit no longer matches the captured delivery head");
}

async function githubBase(cwd, target, remoteProjects, targetBranch, headCommit) {
  const { host, project, id } = target;
  const pr = await readHost(cwd, "gh", host, `repos/${project}/pulls/${id}`, "pull request");
  if (pr?.number !== id || !sameReview(pr.html_url, target) || projectPath(host, pr.base?.repo?.full_name) !== project) {
    throw new Error("GitHub did not confirm the identified pull request");
  }
  if (!remoteProjects.has(project) && !remoteProjects.has(projectPath(host, pr.head?.repo?.full_name))) {
    throw new Error("no checkout fetch remote matches the pull request target or source repository");
  }

  requireOpenReview(pr.state === "open", pr.base?.ref, pr.head?.sha, targetBranch, headCommit);
  return pr.base?.sha;
}

async function gitlabBase(cwd, target, remoteProjects, targetBranch, headCommit) {
  const { host, project, id } = target;
  const mr = await readHost(cwd, "glab", host, `projects/${encodeURIComponent(project)}/merge_requests/${id}`, "merge request");
  if (mr?.iid !== id || !sameReview(mr.web_url, target) || !isId(mr.target_project_id)) {
    throw new Error("GitLab did not confirm the identified merge request");
  }

  requireOpenReview(mr.state === "opened", mr.target_branch, mr.sha, targetBranch, headCommit);
  if (!remoteProjects.has(project)) {
    if (!isId(mr.source_project_id)) {
      throw new Error("GitLab did not confirm the merge request source project");
    }
    const source = await readHost(cwd, "glab", host, `projects/${mr.source_project_id}`, "merge request source project");
    if (source?.id !== mr.source_project_id || !remoteProjects.has(projectPath(host, source.path_with_namespace))) {
      throw new Error("no checkout fetch remote matches the merge request target or source project");
    }
  }

  // GitLab diff_refs.base_sha is the diff merge base, not the current target branch tip.
  const branchEndpoint = `projects/${mr.target_project_id}/repository/branches/${encodeURIComponent(targetBranch)}`;
  const branch = await readHost(cwd, "glab", host, branchEndpoint, "merge request target branch");
  if (branch?.name !== targetBranch) {
    throw new Error("GitLab did not confirm the exact merge request target branch");
  }
  return branch.commit?.id;
}

export default confirmFreshReviewerTarget;
