import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBootPlan } from "../tools/boot-app.js";
import { formatPrComment } from "../tools/comment-pr.js";
import { buildVerificationPlan } from "../tools/verify-pr.js";

const ADVISOR_CONFIG = `modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
  subagents: true
  syncBacklog: 1
`;

const WATCHDOG_ROSTER = `instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
  - name: Verifier
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md

      You are the always-on verifier for this project.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      Stay silent when the evidence is sufficient.

      Downstream project rules belong below this import: setup commands, test commands,
      database/service details, browser routes, and project-specific "done means" checks.
`;

async function writeBootstrapFile(path, content, force, forceHint = true) {
  try {
    await writeFile(path, content, { flag: force ? "w" : "wx" });
    return `${force ? "replaced" : "created"} ${path}`;
  } catch (error) {
    if (error?.code === "EEXIST") return `kept existing ${path}${forceHint ? " (rerun with --force to replace)" : " (merge advisor keys manually)"}`;
    throw error;
  }
}

export default function verifierPlugin(pi) {
  const { z } = pi.zod;

  pi.setLabel("Verifier");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Verifier plugin loaded", "info");
  });

  pi.registerCommand("verifier-info", {
    description: "Show verifier plugin commands, tools, and agents",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Verifier: /verify-pr <repo> <pr>; /verifier-bootstrap [--force]; agents=verifier,project-verifier; tools=verify_pr_plan,boot_app_plan,format_pr_comment",
        "info",
      );
    },
  });

  pi.registerCommand("verifier-bootstrap", {
    description: "Bootstrap this repo to use omp-verifier as an always-on advisor",
    handler: async (args, ctx) => {
      const force = args.trim().split(/\s+/).includes("--force");
      const cwd = ctx.cwd || process.cwd();
      const configDir = join(cwd, ".omp");
      await mkdir(configDir, { recursive: true });

      const results = [
        await writeBootstrapFile(join(configDir, "config.yml"), ADVISOR_CONFIG, false, false),
        await writeBootstrapFile(join(cwd, "WATCHDOG.yml"), WATCHDOG_ROSTER, force),
      ];

      ctx.ui.notify(`${results.join("; ")}. Restart OMP from this repo or run /advisor on.`, "info");
    },
  });

  pi.registerCommand("verify-pr", {
    description: "Start an evidence-first PR verification turn",
    handler: async (args, ctx) => {
      const [repo, pr] = args.trim().split(/\s+/);
      if (!repo || !pr) {
        ctx.ui.notify("Usage: /verify-pr <repo> <pr-number>", "error");
        return;
      }

      await pi.sendMessage(
        `Use the project-verifier agent to verify PR #${pr} in ${repo}. Start from Gold, read local project conventions first, create an isolated worktree when needed, derive PR-specific ports/env, run targeted tests or browser QA, and report PASS | FAIL | BLOCKED with evidence.`,
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  pi.registerTool({
    name: "verify_pr_plan",
    label: "Verify PR Plan",
    description: "Build an evidence-first verification plan for a PR in a local repo.",
    parameters: z.object({
      repo: z.string().describe("Local repo path, e.g. ~/code/klondikemarlen/my-app"),
      pr: z.number().int().positive().describe("Pull request number"),
    }),
    async execute(_toolCallId, params) {
      const plan = buildVerificationPlan(params);
      return {
        content: [{ type: "text", text: plan }],
        details: { repo: params.repo, pr: params.pr },
      };
    },
  });

  pi.registerTool({
    name: "boot_app_plan",
    label: "Boot App Plan",
    description: "Derive PR-specific ports and environment values for an isolated app boot.",
    parameters: z.object({
      repo: z.string(),
      pr: z.number().int().positive(),
      basePort: z.number().int().positive().optional(),
    }),
    async execute(_toolCallId, params) {
      const plan = buildBootPlan(params);
      return {
        content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        details: plan,
      };
    },
  });

  pi.registerTool({
    name: "format_pr_comment",
    label: "Format PR Comment",
    description: "Format a verifier PASS/FAIL/BLOCKED comment for a pull request.",
    parameters: z.object({
      verdict: z.enum(["PASS", "FAIL", "BLOCKED"]),
      evidence: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
    }),
    async execute(_toolCallId, params) {
      const comment = formatPrComment(params);
      return {
        content: [{ type: "text", text: comment }],
        details: params,
      };
    },
  });
}
