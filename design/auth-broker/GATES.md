# Feasibility gates — recorded results

> Historical implementation record. For the current 0.9.11 connection and packaging instructions, see [README.md](../../README.md). The SAP ADT for VS Code bridge and its object index were removed in 0.9.11; the current universal VSIX includes Windows x64 and macOS Apple silicon RFC bindings.

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

### Gate 2 addendum — RFC calls inside the extension host (2026-10-16)

- Gate 2 measured that sap-rfc-lite loads in the extension host; it did not make a call. Running VERTEX in VS Code 1.142 (Electron 43.7.7, Node 24.21.0) showed the first ADT request over RFC never returning, while the same code in plain Node 24.19.0 answered 200 in about 3 s.
- Cause: Electron runs V8 with the memory cage, where `napi_create_external_buffer` is refused. sap-rfc-lite 0.2.3 wrapped RFCTYPE_BYTE and RFCTYPE_XSTRING results in external buffers (`src/cpp/nwrfcsdk.cc`). Under VS Code's Electron run as Node the call fails with "External buffers are not allowed"; in the extension host the exception is lost in the async completion and the call never settles. ADT over RFC returns its body as XSTRING, so every request hung. `connect` was unaffected.
- Fix, by the owner's decision, in sap-rfc-lite (PR fr0ster/sap-rfc-lite#18, branch `fix/electron-external-buffers`): `Napi::Buffer::NewOrCopy` keeps zero-copy where allowed (plain Node unchanged) and copies where not.
- Verified with a locally built binding (not committed to VERTEX): Electron as Node — connect, discovery 200, read 200, CSRF absent, LOCK/UNLOCK 200; VS Code extension host — VERTEX's Test SAP Systems on an snc system: discovery 200 (401206 bytes); plain Node — unchanged.
- Consequence for VERTEX: snc in the extension host needs sap-rfc-lite ≥ 0.2.4 (the release with this fix). Until it is published, VERTEX's lock stays on 0.2.3, and Task 13's snc integration waits for it. The lock is raised in a later commit once 0.2.4 is on the registry.

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

Basic path measured (2026-10-16, after Task 5):

- `node --test` of test/auth-systems, auth-stores, auth-migrate and auth-http-wire (54 tests, including the SPEC §7 table against the real abap-adt-api 8.4.3) passes under Node 18.20.8 and 20.20.2, as under 24.19.0.
- An end-to-end run of the real chain — VertexServiceKeyStore/VertexSessionStore → AuthBroker → the auth-providers Basic provider → the HTTP wire → abap-adt-api ADTClient — against a local HTTP server: login and a request answer 200 with the Basic header; after the stored password is changed to a wrong one, the request fails and the wire reports the provider's `credential-refused`. Identical under Node 18.20.8, 20.20.2 and 24.19.0.
- Verdict: `basic` works on the Node versions `^1.85.0` admits; no refusal needed for basic. `snc` keeps its own conditions (SPEC §9) and was measured only on Node 24 (gate 2).

SNC on older Node (2026-10-17): the `snc` path through VERTEX's own factory (`createAuth` → `makeClient` → RFC wire → abap-adt-api `ADTClient`) against the `snc` system ran 13 operations (login, package browse, search, read source, object structure, syntax check, LOCK/UNLOCK, logout then read again on the same client, ABAP Unit, ATC, data preview, dispose) with all steps ok under plain Node 18.20.8 and 20.20.2, as under VS Code 1.142's Electron (Node 24.21.0). Electron hosts of older VS Code releases were not run; they share the memory-cage restriction that sap-rfc-lite 0.2.4 addresses (gate 2 addendum). No refusal is added for `snc` on older hosts.

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
- Gate 2: PASS in VS Code 1.142.0; engines.vscode stays ^1.85.0 (owner); basic verified on Node 18, 20 and 24.
- Gate 2 addendum: snc needs sap-rfc-lite ≥ 0.2.4 (Electron external-buffer fix, PR fr0ster/sap-rfc-lite#18).

## Owner decisions — SNC platforms and packaging (2026-10-16)

- **D1:** SNC supports `win32-x64` and `darwin-arm64` only: Windows x64 and macOS on Apple
  silicon. `darwin-x64` is no longer supported by the vendor; `win32-arm64` is not available
  to test. Neither is supported by VERTEX.
- **D2:** Separate VSIX packages stay: `win32-x64` and `darwin-arm64`, each carrying only its
  own sap-rfc-lite prebuilt binding, plus the universal package without sap-rfc-lite
  (`npm ci --omit=optional`). sap-rfc-lite 0.2.3 ships prebuilds for `win32-x64`, `darwin-arm64`
  and `linux-x64` under `prebuilds/<platform>-<arch>/`, loaded by `node-gyp-build`. Both native
  packages can be built on any machine; no SDK or toolchain is needed at install. The SDK is
  needed only at run time.
- **D3:** On win32 with an architecture other than x64, or darwin with an architecture other
  than arm64 (and on other platforms), `hosts.js` refuses an `snc` system before anything native
  loads: "SNC runs on Windows x64 and macOS on Apple silicon only." The remote-host refusal
  takes precedence; Basic is never refused.

sap-rfc-lite 0.2.3 (prebuilt) was re-run against gate 1 on Windows with the same result:
connect, discovery, read, CSRF absent, LOCK/UNLOCK all ok.

## Packaging (Task 12)

Packaging logic lives in `vscode/package.js`, with `vscode/package.ps1` and `vscode/package.sh` as wrappers.

- Step 1 decision: no `win32-arm64`; `darwin-x64` is not supported.
- Targets: `win32-x64` and `darwin-arm64` each carry only their own prebuilt
  sap-rfc-lite binding. Universal uses `npm ci --omit=optional` without sap-rfc-lite.
- Archive verification lists entries and rejects missing target bindings, other
  platforms' bindings, local `sapnwrfc.node` builds, and SAP SDK libraries. Existing
  archive, content and Scheme navigation checks remain in place.
- `THIRD-PARTY-NOTICES.md` lists installed runtime versions, licence identifiers
  and actual licence paths, including separate, replaceable LGPL modules and the
  vendored open-abap-core subset. Notices and auth licence files are required.
- Step 4 changes nothing in `package.json`: `engines.vscode` stays `^1.85.0`.
- Packaging restores the developer install with plain `npm ci` in `finally`,
  unless `-KeepNodeModules` is supplied.

Verified 2026-10-17 on Windows x64 (PLAN Task 12, Step 5):
`package.ps1` (universal) and `package.ps1 -Target win32-x64` both succeeded
with all archive checks; the developer install was restored afterwards. The
universal package has no sap-rfc-lite and no `.node` binding; win32-x64 carries
only `prebuilds/win32-x64` and `TargetPlatform win32-x64`. Both carry
`THIRD-PARTY-NOTICES.md`; neither carries an SDK library. Each was installed
into a clean VS Code profile: with the universal package an `snc` system was
refused with "This VERTEX package has no SNC support; install the Windows or macOS package of VERTEX.";
with the win32-x64 package, Test SAP Systems on the `snc` system answered OK
without a password prompt. darwin-arm64 built on Windows x64 on 2026-10-17 with `package.ps1 -Target darwin-arm64`: all archive checks passed; it carries only prebuilds/darwin-arm64 and TargetPlatform darwin-arm64. Not installed on macOS; SNC on macOS (Apple silicon) is not verified.
