# Feasibility gates — recorded results

Results of the gates from GOAL.md / SPEC.md §16, recorded per PLAN.md Tasks 1 and 2.
No secrets, system IDs, hosts or user IDs are recorded.
The owner chose to record measured values (statuses, durations and flags) instead of copying JSON reports because the reports contain the destination service URL.

## Test baseline (Windows)

`npm test` in `vscode/` at commit `586b9f5` on Windows x64, Node 24.19.0,
with sap-rfc-lite built (`sapnwrfc.node` present): 596 tests, 559 pass, 37 fail.
The failures are the diagrams, local analysis, SelecTor, visual-debug and lens pages,
unrelated to authentication. Linux reference from HISTORY.md: 44 failing at `7057143`.
Rule: no task adds a failure to this baseline.

## Run environment (2026-10-16)

Windows x64, Node 24.19.0, N-API 10; SAP NW RFC SDK on PATH and
SAPNWRFC_HOME set. `probe/snc` at commit `1b332da`; an `snc` destination
read by EnvDestinationStore, SNC QOP 9, SNC library omitted from the
destination and discovered; provider SncLogonProvider.

## Gate 1 — SNC reaches the system

Verdict: PASS.

Run A (standard program):
`node probe.js --dir <dir> --destination <name> --program <PROG>`

- Destination ok; getProvider ok (SncLogonProvider).
- Connect ok: 14.8 s on first logon, 1.0 s on later runs.
- Discovery 200: 401206 bytes, 2.0 s; read source 200; disconnect ok.

Run B:
`node probe.js --dir <dir> --destination <name> --program <Z_PROG> --lock --csrf`

- Connect ok: 1.0 s; discovery 200; read source 200.
- LOCK 200 with a lock handle received; UNLOCK 200; disconnect ok.

## Gate 2 — the extension host runs the stack

Verdict: PASS.

Run (2026-10-16): `probe/host` at commit `919f475`, on the owner's Windows
machine in a local window. `npm install` in `probe/host` with SAPNWRFC_HOME
set and the SDK lib on PATH built `sapnwrfc.node`. VS Code was started from
that shell with `code --extensionDevelopmentPath=<repo>\probe\host`, then
command "VERTEX Probe: Report Host" was run.

Report (verbatim, contains nothing secret):

```json
{
  "vscode": "1.142.0",
  "node": "24.21.0",
  "electron": "43.7.7",
  "napi": "10",
  "platform": "win32",
  "arch": "x64",
  "remoteName": null,
  "@mcp-abap-adt/auth-broker": "loaded",
  "@mcp-abap-adt/connection": "loaded",
  "@mcp-abap-adt/sap-rfc-lite": "loaded"
}
```

Node ≥ 22: yes (24.21.0). sap-rfc-lite loads in the extension host: yes,
in-process, so SPEC §8 runs in the extension host.

Gate 2 itself passed in VS Code 1.142.0. The engines.vscode floor (SPEC §13)
is the owner's decision below.

## Owner decision — engines.vscode stays ^1.85.0

Decision (2026-10-16): `engines.vscode` stays `^1.85.0`, as in upstream VERTEX.
VS Code 1.85 runs extensions on Node 18 (Electron 25), while the auth stack's
packages declare engines node `^22 || ^24 || ^26`.

Consequence: VERTEX must show that the stack works on the older Node versions
it then admits; where it does not, VERTEX refuses with a message instead of
crashing.

First measurement (2026-10-16, Windows x64, `vscode/node_modules` at this
branch): under Node 18.20.8 and Node 20.20.2, `require` of
`@mcp-abap-adt/auth-broker`, `@mcp-abap-adt/auth-providers`,
`@mcp-abap-adt/auth-stores`, `@mcp-abap-adt/auth-errors` and
`@mcp-abap-adt/connection` all load.

Still to measure: the `basic` path end to end (broker → provider → HTTP wire)
under Node 18. Once Task 5 lands, run its unit tests (broker, http-wire, the
`abap-adt-api` table) under Node 18 and 20. Record the result here; if anything
fails, take it to the owner.

## Gate 3 — CSRF over RFC

Verdict: option B (SPEC §8.5).

The library's login request, `GET /sap/bc/adt/compatibility/graph` with
`x-csrf-token: fetch`, answered 200 over RFC without an `x-csrf-token` header:
`csrfHeaderPresent: false`, `csrfValueKind: "absent"`. This occurred in run B
and in a separate run with the same result:
`node probe.js --dir <dir> --destination <name> --program <PROG> --csrf`

The RFC wire adds `x-csrf-token: rfc` to every response returned to
abap-adt-api. The value never travels to SAP because SPEC §8.2 strips the
header outbound.

## Gate 4 — listener deletion over RFC

Verdict: PASS (the poll ends on deletion).

Command, run twice:
`node probe.js --dir <dir> --destination <name> --program <PROG> --listener --user <ABAP user>`

| Measurement | Run 1 | Run 2 |
| --- | --- | --- |
| Delete from second connection | 200 | 200 |
| deleteOk | true | true |
| endedBeforeDelete | false | false |
| Poll outcome | answered | answered |
| Poll status | 200 | 200 |
| secondsAfterDelete | 0.828 | 0.814 |
| totalSeconds | 5.834 | 5.826 |
| Left pending | no | no |

Both runs agree. For Task 9, `LISTENER_STOP_MS` = ceil(0.828 s) + 5 s =
6 s = 6000 ms.

## Decisions taken from the gates

- Gate 3: option B (SPEC §8.5).
- Gate 4: shutdown deletes through the probe wire and awaits the poll,
  bounded by `LISTENER_STOP_MS = 6000`.
- Gate 1: SPEC §8 is feasible.
- Gate 2: PASS in VS Code 1.142.0; engines.vscode stays ^1.85.0 (owner), with Node 18/20 verified for basic after Task 5.
