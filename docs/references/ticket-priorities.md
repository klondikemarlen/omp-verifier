# Ticket priorities

Rank work by what happens to the person waiting for verification. Use the highest applicable tier. These are triage decisions, not reviewer verdicts or GitHub labels.

| Priority | User impact | Example |
| --- | --- | --- |
| P0 — hard blocker | Required work cannot finish through a supported path, or a false success lets unverified work ship. | The named reviewer exhausts its context and abandons the required review without a verdict. |
| P1 — speed | Work can finish, but a material wait, repeated review, or operator intervention makes it substantially slower. | A review with usable evidence sits idle until someone prompts it again. |
| P2 — other bugs | The workflow remains usable, but its output or interface is wrong. | A blocker quotes the wrong text while the original reporter evidence remains available. |
| P3 — enhancements | An improvement to a working workflow, with no demonstrated blocker or material delay. | Add a new policy control. |

A `BLOCKED` result can be correct: reporting a missing dependency is not itself a P0 bug. Conversely, an upstream dependency affects *readiness*, not impact. Keep the priority, identify who can unblock the ticket and what evidence would let work resume, then take the highest-priority actionable item. Within a tier, favor the problem that recurs more often, affects more users or costs more time per occurrence. Mark unknown impact rather than guessing.

For speed, measure elapsed time from the user-visible start to a usable result. Compare the same scope, reviewer and completion condition. Report manual resumptions and abandoned runs separately. Fewer evidence pages explain a possible gain; they do not prove a shorter wait. Never count a skipped check as a speedup.

## Grouping and recurring defects

Group tickets when the same owner, reproduction or prerequisite lets one investigation advance them together. Close one as a duplicate only if the same fix and acceptance check resolve both. For example, delivering the verdict for the **current** PR and delivering its text **unchanged** can share a delivery test fixture, but either check can fail while the other passes.

When a defect returns after a fix, or several fixes touch the same decision, pause before adding another special case. Compare the last known good case with the failure: version, input, expected behavior and first boundary where they differ. A recurring symptom may be an unresolved upstream defect, not a regression in Verifier.

If two local paths own the same decision and disagree, give that decision one owner. If two states are being confused, model the distinction explicitly (for example, a pending request versus an accepted verdict). Use a new abstraction or pattern only when it makes the demonstrated failure harder to repeat. Prove the repair at the affected user boundary with both the returning failure and the previously working case. Keep the evidence and rationale on the ticket; keep the live queue out of this reference.
