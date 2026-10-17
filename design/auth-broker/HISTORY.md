# How this work came about — session history

> Historical implementation record. For the current 0.9.11 connection and packaging instructions, see [README.md](../../README.md). The SAP ADT for VS Code bridge and its object index were removed in 0.9.11; the current universal VSIX includes Windows x64 and macOS Apple silicon RFC bindings.

A condensed record of the session that produced this branch: what was asked, what was learned,
what was decided and by whom. The raw session transcript is not committed. This repository is
public, and the transcript mixes this work with unrelated work, internal host names and account
data. This file carries everything from it that matters for this branch.

## 1. Origin

- The owner forked `ysichov/VERTEX` into `fr0ster-forks` and cloned it next to their other
  projects.
- A read-only study of the extension found the following.
  - VERTEX ships one VS Code extension (`vscode/`) and an Eclipse plugin.
  - It reaches SAP only through ADT REST over HTTP(S), using `abap-adt-api` 8.4.3 with its own
    `sap-http.js` transport, plus a second request path inside `extension.js`.
  - Authentication is Basic only, with the password in `context.secrets` under
    `vertex.password.<name>`.
  - ABAP code in `src/` (installed via abapGit) adds only `/sap/bc/adt/vertex/about` and
    `/vertex/store/{name}`, for saving reviews.
- The owner asked whether their own auth stack (`@mcp-abap-adt/auth-broker`, `auth-providers`,
  `auth-stores`, `auth-errors`, `interfaces-auth*`, `connection`) could be integrated.

## 2. What was established before any design

- **Path a** was chosen by the owner: keep `abap-adt-api`, get credentials from the broker. The
  rejected alternatives were routing everything through `@mcp-abap-adt/connection`, or replacing
  `abap-adt-api` with `@mcp-abap-adt/adt-clients`.
- **SNC is RFC only.** The owner stated it; the code confirms it. `SncLogonProvider` yields only
  RFC logon parameters (`snc_mode`, `snc_partnername`, `snc_qop`, `snc_lib`, `snc_myname`), which
  need `@mcp-abap-adt/sap-rfc-lite` and the SAP NW RFC SDK. There is no HTTP form of SNC.
- **SNC is Windows and macOS only.** The owner stated this.
- **Several VS Code windows must share one refresh token.** The owner stated this. A study found
  that the broker keeps the refresh token in its provider's memory and joins renewals only within
  one process.
- **The owner rejected a renewal-lock port in the auth stack:** "it brings a lock into the auth
  stack". The auth stack stays agnostic of its consumers and is not changed for VERTEX. VERTEX
  coordinates windows itself, through the ports the stack already has. The owner's view: broker,
  stores and providers are the reusable parts; coordinating processes is the consumer's job.
- **The owner has a Windows test machine with SNC fully set up** (Secure Login Client, NW RFC SDK,
  an SNC system). They test their MCP server over SNC there. SNC evidence comes from that machine.

## 3. Design documents and their reviews

Every document was reviewed by codex (read-only) until it had no findings, then confirmed by the
owner.

| Document | Rounds | Owner decisions taken along the way |
|---|---|---|
| `GOAL.md` | 2 | First landing `snc` + `basic`; second landing `jwt` (authorization_code) + `saml` (both `saml2_pure` and `saml2_bearer`); remote extension hosts out of scope for `jwt`/`saml`/`snc` for now (`basic` keeps working where it works today); the standalone MCP in `mcp/` later, as separate work. |
| `SPEC.md` | 5 | Basic password migration by name, once at upgrade. GOAL criterion 6 was rewritten to say so, with its limit stated: a legacy key records only the name. |
| `PLAN.md` | 4 | — (24 findings fixed, none needing a decision) |

**Key design points that came out of the reviews.** Read the spec for the full text.

- VERTEX's transport becomes a *wire* for the auth stack's `IAuthProvider` contract:
  - `prepare` and `establish` once per provider instance;
  - `authorize` before every request;
  - `rejected` on a 401, with at most one retry, never through `login()`.
- The provider is asked of the broker before every HTTP request. A changed or forgotten password,
  including one changed in another window, therefore reaches existing clients.
- The RFC wire runs one request at a time and tracks `keep` mode. It answers
  `/sap/public/bc/icf/logoff` locally by ending its session; the next request opens a new
  connector, so cached clients survive `sap-code.js`'s `logout()` after every apply.
- Debugger operations other than the poll move from the listener to the probe client. `stop()`
  waits for the loop, bounded by gate 4's measured time.
- The cost of a refused request is pinned against the real `abap-adt-api` (SPEC §7, four rows).
- Saved editors are restored against the current settings: an exact connection-key match first,
  then a unique name, otherwise an explicit ambiguity. Old source is never shown after a key
  change.
- Packaging builds one VSIX per target. The `sapnwrfc.node` binding is allowed; SAP SDK libraries
  are refused. A third-party notice ships with every package.

## 4. Done on this branch so far

| Commit | What |
|---|---|
| `30743db`, `0cb94db` | `probe/snc` (SNC over RFC, outside VS Code) and `probe/AUTH_BROKER_NOTES.md` |
| `ad315aa` … `351334b` | `GOAL.md`, approved |
| `900258a` … `1ee618b` | `SPEC.md`, approved |
| `7007194` … `76fd45f` | `PLAN.md`, approved |
| `7057143` | Plan Task 3, step 1: the auth stack added to `vscode/package.json` from the npm registry. No `"link": true`; the `interfaces-*` packages are deduplicated. `sap-rfc-lite` did not build on the Linux machine (no SDK, and it is optional), which is expected. |

**Test baseline.** On the unmodified upstream `main`, `npm test` in `vscode/` on Linux fails 45 of
596 tests. They are diagrams, local analysis and SelecTor pages, unrelated to authentication. This
branch at `7057143` fails 44. The rule: no task adds a failure.

## 5. Not done

- Plan Task 1, step 1 (extend `probe/snc` with gate 3 and gate 4, plus the watchdog) and Task 2,
  step 1 (the host probe) were handed to codex in the original session. Codex could not write to
  this worktree from there, because its sandbox allowed writes only under another project
  directory. **Nothing of those steps exists yet.**
- Every implementation task (3 from step 2 onwards, and 4–13) is open.
- `GATES.md` does not exist yet.
