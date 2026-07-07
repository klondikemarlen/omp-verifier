import { buildBootPlan } from "./tools/boot-app.js";
import { formatPrComment } from "./tools/comment-pr.js";
import { buildVerificationPlan } from "./tools/verify-pr.js";

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
        "Verifier: /verify-pr <repo> <pr>; agents=verifier,wrap-verifier; tools=verify_pr_plan,boot_app_plan,format_pr_comment",
        "info",
      );
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
        `Use the verifier agent to verify PR #${pr} in ${repo}. Start from Gold, create an isolated worktree, derive PR-specific ports/env, run targeted tests or browser QA, and report PASS | FAIL | BLOCKED with evidence.`,
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
