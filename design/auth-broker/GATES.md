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

Status: not yet run.

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
- Gate 2: still open (Task 2).
