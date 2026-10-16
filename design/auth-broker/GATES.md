# Feasibility gates ? recorded results

Results of the gates from GOAL.md / SPEC.md ?16, recorded per PLAN.md Tasks 1 and 2.
No secrets, system IDs, hosts or user IDs are recorded.

## Test baseline (Windows)

`npm test` in `vscode/` at commit `586b9f5` on Windows x64, Node 24.19.0,
with sap-rfc-lite built (`sapnwrfc.node` present): 596 tests, 559 pass, 37 fail.
The failures are the diagrams, local analysis, SelecTor, visual-debug and lens pages,
unrelated to authentication. Linux reference from HISTORY.md: 44 failing at `7057143`.
Rule: no task adds a failure to this baseline.

## Gate 1 ? SNC reaches the system

Status: not yet run.

## Gate 2 ? the extension host runs the stack

Status: not yet run.

## Gate 3 ? CSRF over RFC

Status: not yet run.

## Gate 4 ? listener deletion over RFC

Status: not yet run.
