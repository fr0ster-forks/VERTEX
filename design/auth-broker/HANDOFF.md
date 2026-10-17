# Handoff — read this first

You are continuing the integration of the `@mcp-abap-adt` auth stack into the VERTEX VS Code
extension, on branch `feat/auth-broker` of `fr0ster-forks/VERTEX`. The earlier session ran on a
Linux machine that cannot run SNC. You run on the owner's Windows machine, where SNC, Secure Login
Client and the SAP NW RFC SDK are set up.

## Read, in this order

1. `design/auth-broker/HISTORY.md` — what was asked, learned and decided, and what is done and not.
2. `design/auth-broker/GOAL.md` — approved. The "Decided" section is the owner's and is not
   reopened.
3. `design/auth-broker/SPEC.md` — approved. It covers the first landing (`basic` and `snc`) only.
4. `design/auth-broker/PLAN.md` — approved. Thirteen tasks; execute them as written.
5. `probe/AUTH_BROKER_NOTES.md` — background from the code study.

## How to work (the owner's rules for this work)

- **Roles.** The session plans and controls. Implementation steps are delegated to codex (the
  `codex:codex-rescue` subagent), and every task is reviewed by codex before the next one starts.
  The session does git: commits, pushes, the PR. The owner confirms each stage, and confirms
  anything that changes a decision.
- **One task at a time,** in plan order. A task marked **STOP** is a gate: nothing that depends on
  it starts before its result is recorded in `design/auth-broker/GATES.md` and reported to the
  owner. A gate that fails goes to the owner with options; it is never worked around.
- **One PR for the whole task:** open a draft PR from `feat/auth-broker` to the fork's `main` when
  the first code lands. Spec, plan, code, tests and docs all go in it.
- **No change to the auth stack, the connector or `sap-rfc-lite`.** No lock, no new port. If the
  stack seems to need a change, stop and ask the owner.
- **Dependencies from the npm registry only.** After every install, `package-lock.json` has no
  `"link": true`, and no `file:` or `link:` specifiers. The owner's sibling repositories must
  never be linked.
- **No secret** in settings, files, logs or commits; only VS Code SecretStorage. Do not write SAP
  system IDs, host names or user IDs into tracked files.
- **Tests:** `npm test` in `vscode/`. Upstream `main` already fails 45 of 596 on Linux (diagrams,
  local analysis, SelecTor). Record the Windows baseline once, before Task 3 continues. No task may
  add a failure.
- **Documentation** follows `AGENTS.md`: `README.md`, `vscode/README.md`, `history.md`,
  `dev_history.md` (and the walkthrough, per plan Task 11).
- **Language:** repository artifacts are in English. Talk to the owner in Ukrainian.

## Where to start

1. Get the branch and install with the SDK visible, so that `sap-rfc-lite` builds. npm drops an
   optional native dependency whose build fails, silently.

```
git fetch origin
git checkout feat/auth-broker
cd vscode
set SAPNWRFC_HOME=<SDK dir>
set PATH=<SDK dir>\lib;%PATH%
npm ci
npm test
```

   Check that `node_modules\**\@mcp-abap-adt\sap-rfc-lite\build\Release\sapnwrfc.node` exists,
   and record the test baseline in `GATES.md`.
2. **Plan Task 1, step 1** (codex): extend `probe/snc/probe.js` with gate 3 (`--csrf`), gate 4
   (`--listener --user`) and the watchdog, exactly as the plan's code shows. Create `GATES.md`.
3. **Plan Task 1, step 2** (owner): run the probe three ways (see the plan). The destination is the
   owner's existing SNC destination for the MCP server: an `.env` in the format `probe/snc/README.md`
   describes. Ask the owner where it lives; never print its contents.
4. **Plan Task 1, steps 3–4:** record the gates, then stop and report.
5. **Plan Task 2:** the host probe, run in the owner's VS Code. Record, stop, report.
6. Then Tasks 3 (from step 2), 4, 5, 6 and 8. These do not depend on the gates. Task 7 and
   everything after it follow once gates 1–4 are recorded.

## Open owner decisions you will meet

- **Gate outcomes.** Gate 1 failing; gate 4 showing that the poll does not end on deletion; gate 2
  showing Node < 22 or `sap-rfc-lite` not loading in the extension host.
- **Task 12:** whether a `win32-arm64` VSIX is wanted. The default is no.
- **The version number** for `history.md`, which is the owner's.
