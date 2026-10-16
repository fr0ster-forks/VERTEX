# Spec: auth broker in VERTEX — first landing (`basic` and `snc`)

Implements the first landing of [GOAL.md](GOAL.md). The second landing (`jwt`, `saml`) gets its
own spec. Where this one lays groundwork for it, that is said, and nothing more of it is built
here.

## 1. The shape in one paragraph

VERTEX keeps `abap-adt-api` for every ADT operation. Below it, VERTEX already replaces the
library's HTTP client with its own (`vscode/sap-http.js`). That replacement becomes a **wire** for
the auth stack's `IAuthProvider` contract.

A provider is asked for at four moments:

- `prepare()` once per client;
- `establish(logon)` once per logon;
- `authorize(request)` before every request attempt;
- `rejected(rejection)` when the system refuses.

The provider writes into targets the wire hands it: headers, cookies and RFC logon parameters. The
wire never learns which credential it carries, and a provider never learns which wire carries it.

- **`basic`:** the provider comes from the broker, and the wire is HTTP.
- **`snc`:** the provider comes from the broker, and the wire is the connector's RFC transport,
  reached through an adapter that speaks `sap-http`'s request contract.

`jwt` and `saml` in the second landing reuse the same HTTP wire with other providers.

## 2. Components

All new code is plain CommonJS under `vscode/auth/`. No bundler.

| File | Responsibility |
|---|---|
| `auth/systems.js` | Reads a `vertex.systems` entry into a validated system description (§3); computes its login identity (§4). |
| `auth/stores.js` | `VertexServiceKeyStore` (`IServiceKeyStore`) and `VertexSessionStore` (`ISessionStore`) over `vscode.SecretStorage` (§5). |
| `auth/broker.js` | One `AuthBroker` per extension host, built from the two stores. `providerFor(system)` returns the broker's `getProvider(identity)` (§6). |
| `auth/http-wire.js` | `createHttpWire(system, provider)` → an object with `request(options)`, the contract `sap-http.js` has today, which drives the four moments (§7). |
| `auth/rfc-wire.js` | `createRfcWire(system, provider, role)` → the same `request(options)` contract, carried over `@mcp-abap-adt/connection`'s RFC transport (§8). Loaded lazily, only for `snc`. |
| `auth/hosts.js` | `refusalFor(system)` → `null` or a sentence, decided before anything native is loaded (§9). |
| `auth/migrate.js` | Moves a legacy `vertex.password.<name>` to the new store (§10). |
| `auth/clients.js` | `makeClient(system, role)` → a configured `ADTClient`; the one place both the repository and the debugger build clients (§11). |

`vscode/sap-http.js` keeps its TLS policy, origin guard and keep-alive agent. Those move inside
`http-wire.js`, which replaces the module's use; `sap-http.js` is deleted.

## 3. Settings

`vertex.systems[]` gains:

| Field | Type | Meaning |
|---|---|---|
| `authType` | `"basic"` \| `"snc"` | Absent means `"basic"`. The second landing adds `"jwt"` and `"saml"`. |
| `snc` | object | Required when `authType` is `"snc"`: `partnerName` (required, the system's SNC name, e.g. `p:CN=SID, O=ACME`), `qop` (optional, `"1"`–`"9"`), `library` (optional path; discovered when absent), `myName` (optional). |
| `rfc` | object | Required when `authType` is `"snc"`: `ashost` (application server host), `sysnr` (two digits), `saprouter` (optional). Never derived from `url`: the ICM port says nothing reliable about the instance number. |

- `url` stays required for every type. It is the ADT origin for HTTP, and for `snc` it names the
  system for identity and WebGUI.
- `client` and `user` keep their meaning. `user` stays required for every type: for `basic` it is
  the logon user, and for `snc` it is the ABAP user the debugger targets (VERTEX's debugger
  identifies its debuggee by user). For `snc` it is identification only and carries no password.
- Settings never hold a secret. The schema's descriptions say so, and `systems.js` refuses a
  `password` field if one is present.

`systems.js` validates and answers `{ system }` or `{ error }`, naming the missing field in a
sentence. The current `missing()` in `extension.js` is replaced by it.

## 4. Login identity

A system's stored login is filed under an identity, not under its display name. The current
`vertex.password.<name>` makes two systems with one name share a password, and it keeps a
password after the URL is changed.

```
identity = "vertex.auth.v1." + sha256(JSON.stringify([
  canonicalOrigin(url), client || "", authType, user.toUpperCase(),
])).slice(0, 32)
```

- `canonicalOrigin` lower-cases the scheme and host, and makes the port explicit.
- The display name is not part of the identity: renaming a system keeps its login.
- Changing the URL, client, type or user is a different login, by design.

The identity is also the broker's destination name.

## 5. Stores

Both stores implement the contracts of `@mcp-abap-adt/interfaces-auth-broker` exactly. The
methods are listed in the notes. Every secret goes to `context.secrets`; nothing goes to settings,
`globalState` or a file.

- **`VertexServiceKeyStore`** — the means.
  - **`getConnectionConfig(identity)`** composes:
    - the system's non-secret fields from settings: `serviceUrl`, `sapClient`, `authType`, and for
      `snc` `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName`;
    - the secret means from SecretStorage key `<identity>.means`: for `basic`, `{ username,
      password }`.
  - **`getServiceKey`** answers the same record.
  - **`getAuthorizationConfig`** answers `null`: no OAuth client in this landing.
  - **`getClientCertificate`** is not implemented.
  - **A system that is no longer in settings** answers `null`.
- **`VertexSessionStore`** — the secret a session holds, under `<identity>.session`.
  - `basic` and `snc` obtain no session secret, so in this landing the broker writes nothing
    here.
  - It is implemented to the contract anyway, so the second landing only uses it:
    - writes merge;
    - an omitted `refreshToken` is preserved, and `""` clears it;
    - `issuedFor` and `issuedBy` are kept beside the secret and cleared with it;
    - a stored record that is not its own format is refused whole.
  - Unit-tested against the contract now.
- **Password entry.** VERTEX asks for a password when a `basic` system's means lack one, then
  writes it to `<identity>.means` before asking the broker for a provider. The prompt names the
  user and the system, as today.
- **Forgetting.** "Forget credentials" deletes `<identity>.means` and `<identity>.session`.

## 6. Broker

```js
const { AuthBroker } = require("@mcp-abap-adt/auth-broker");
new AuthBroker({ sessionStore, serviceKeyStore }, logger);
```

- Neither `renewal` nor `onWriteFailure` is needed for `basic` or `snc`: the broker requires them
  only for rows that write a secret. The second landing adds them.
- `providerFor(system)` is `broker.getProvider(identity, { signal })`. The broker rebuilds a
  provider when its means change, for example after a new password.
- The logger is VERTEX's output channel, at debug level. The auth stack never logs a secret.

## 7. HTTP wire

`createHttpWire(system, provider)` returns `{ request(options) }`, the contract `abap-adt-api`
calls on its replaced `httpclient`:

- **In:** `options` = `{ url, method, qs, headers, body, timeout, auth }`.
- **Out:** `{ body, status, statusText, headers }`.

1. **Once per wire:** `await provider.prepare()`. An Oops fails every request with the refusal's
   `reason` and `hint`.
2. **Per request:**
   - build the URL and enforce the origin guard, as `sap-http.js` does today;
   - **drop `options.auth`** — the credential comes from the provider only;
   - call `provider.authorize(target)`. The target is
     `{ header(name, value), cookies(value) }`: `header` sets the outgoing header, and `cookies`
     merges with the `Cookie` header `abap-adt-api` already put on the request (its own session
     cookies win on a name clash).
   - An Oops does not send the request; it fails it with the refusal.
3. **On a response with status 401:**
   - call `provider.rejected({ at: "request", status: 401, error: response })`;
   - on Ok, send the same request once more, back to step 2;
   - on Oops, return the 401 response unchanged and record the refusal for the caller (§12).

   The wire never calls `login()` and never touches cookies. The SAP session is
   `abap-adt-api`'s, per client.
4. **`establish(logon)`** is called once, before the first request, with an HTTP logon target:
   - `logonParameters()` answers Oops `logon-target` (HTTP takes no RFC parameters);
   - `tlsMaterial()` answers Oops `logon-target` too in this landing, as nothing uses client
     certificates yet.

   The `basic` provider ignores both, and the header carries it.

**What `abap-adt-api` is given.** Its constructor demands a password string or a token function.
VERTEX passes the constant string `"-"`. That is no secret, and the wire drops the
`options.auth` it produces.

**Why the wire retries rather than the library.** `AdtHTTP` re-logs in on a 401 only while
stateless, and its re-login clears the session's cookies (`AdtHTTP.js:101–129`, `:157–173`). A
retry inside the wire keeps the cookies, in either session mode. For `basic` the provider's
`rejected` answers Oops, so there is no retry and the behaviour is today's. For the second
landing's token providers it is the renewal path.

## 8. RFC wire (`snc`)

`createRfcWire(system, provider, role)` returns `{ request(options), dispose() }`, with the same
request contract as §7.

- **Construction.**
  - `new AdtOnPremConnector(config, provider, new RfcTransport(open, logger), logger)`.
  - `open` is `logon => new Client({ ashost, sysnr, saprouter?, client, lang: "EN", ...logon })`,
    with the client from `@mcp-abap-adt/sap-rfc-lite`. The address comes from `system.rfc` (§3).
    `rfcConversationFrom` and `SAP_SYSNR` are not used: they are derived and process-wide.
  - The connector calls the provider's `prepare` and `establish`. SNC's logon parameters reach
    the native client there.
  - `connect()` happens on the first request. It does not happen at construction.
- **Request mapping.**
  - In: `url` and `qs` become `{ url, params }`, `body` becomes `data`, `headers` pass on, and
    `timeout` passes on.
  - Out: `{ data, status, statusText, headers }` becomes `{ body, status, statusText, headers }`.
  - A response-bearing connector error becomes the response, so that `abap-adt-api`'s own error
    reading applies. A failure without a response (an RFC failure) is thrown with its message.
- **Session mode.**
  - The wire reads `X-sap-adt-sessiontype` from the outgoing headers.
  - `stateful` calls `connection.setSessionType("stateful")` before the request; anything else
    calls `"stateless"`.
  - The connector routes stateful requests to its persistent conversation, which is never reset,
    and stateless ones to its reset conversation.
- **Headers removed before RFC:** `Authorization`, `Cookie`, `x-csrf-token` and
  `X-sap-adt-sessiontype`. RFC has no cookies or CSRF, and the RFC transport forwards headers
  verbatim.
- **CSRF — feasibility gate 3.** `abap-adt-api` counts itself logged in only once a response
  carries `x-csrf-token` (`AdtHTTP.js:63–65`, `:227–229`). Until then it calls `login()` before
  every request, which costs an extra `GET /sap/bc/adt/compatibility/graph` each time.
  - **Before choosing, measure whether ADT over RFC returns `x-csrf-token`.**
  - **(A) It does:** nothing more is needed.
  - **(B) It does not:** the RFC wire adds `x-csrf-token: rfc` to every response it returns to
    `abap-adt-api`. The value never travels to SAP, because the wire strips the header on the way
    out. It only stops the library's login loop.
  - (B) is a local marker on the library side, not a token presented to SAP. The decision is
    recorded with the measurement.
- **Roles and conversations.** `role` is one of `repository`, `listener`, `probe` and `debuggee`.
  - Each wire has its own connector, and so its own RFC conversations.
  - A `debuggee` wire is stateful for its whole life, and its conversation is never reset.
  - The `listener` wire does nothing but listen.
- **Listener shutdown — feasibility gate 4.**
  - A native RFC call cannot be cancelled, and `sap-rfc-lite` holds the client mutex for the
    duration of the call.
  - Shutdown deletes the listener through the `probe` wire, never through the blocked `listener`
    wire. It then awaits the pending poll, bounded by the measured time.
  - If SAP does not end the poll on deletion, the owner decides the outcome. The design stops at
    that gate.
- **`dispose()`** calls `connection.disconnect()` once. It runs for the debugger's clients on
  detach and stop, for the repository when it is dropped, and for everything on deactivate.

## 9. Hosts

`refusalFor(system)` runs before a client is built and before `rfc-wire.js` is required:

| Condition | Answer |
|---|---|
| `authType` is `"snc"` and `vscode.env.remoteName` is set | "SNC needs the local VS Code on Windows or macOS; this window runs on a remote host (‹remoteName›)." |
| `authType` is `"snc"` and `process.platform` is neither `win32` nor `darwin` | "SNC runs on Windows and macOS only." |
| `authType` is `"snc"` and `@mcp-abap-adt/sap-rfc-lite` does not resolve | "This VERTEX package has no SNC support; install the Windows or macOS package of VERTEX." |
| otherwise | `null` |

- The native module's own loading failure (for example, the NW RFC SDK not on `PATH`) is reported
  with the connector's sentence, which names the SDK.
- `basic` is never refused here. It works wherever it works today, remote hosts included.

## 10. Migration of Basic passwords

When a `basic` system needs its password:

1. If `<identity>.means` has none, and `vertex.password.<name>` exists:
   - **The name is unique in `vertex.systems`:** copy the password to `<identity>.means`, read it
     back, and only then delete the legacy key.
   - **The name is not unique:** the legacy password cannot be attributed. VERTEX asks once for
     the password of this system, and the legacy key stays until every system of that name has
     its own login. Then it is deleted.
2. Otherwise, ask as today.

- The legacy key records nothing but the name. A system whose URL, client or user changed since
  the password was stored therefore inherits it, exactly as it does today.
- After one successful request with it, the password is the system's.
- A 401 on it deletes it from the new store and says so, as today.

## 11. Integration points in `vscode/`

| Where | Change |
|---|---|
| `extension.js` `secretKey`, `password` | replaced by `stores.js` + migration; prompt kept |
| `extension.js` `request`, `csrf`, `fetch` (the own HTTP path) | `request` goes through `http-wire.js`, or `rfc-wire.js` for `snc`. `csrf` keeps fetching a token over HTTP. For `snc`, writes go through the RFC wire, where no CSRF exists, so `csrf` is skipped. The 401 branch keeps discarding a refused password, through the store. |
| `extension.js` `debuggerFor` → `connect` / `make` / `open` | `makeClient(system, "listener" / "probe" / "debuggee")`; `open` keeps `stateful` + `login()` (over RFC, gate 3 decides what `login` costs). |
| `extension.js` `systemKey` | adds `authType` |
| `extension.js` test-connection, forget-password commands | test runs a discovery GET through the system's wire; forget becomes "Forget credentials" (§5) |
| `code-workbench.js` `repository()` and saved-editor keys | `makeClient(system, "repository")`; the saved key adds `authType` and, for `snc`, `rfc`; a saved key without `authType` reads as `basic` |
| `sap-code.js` `logout()` calls | after `logout`, dispose the wire (RFC) or keep it (HTTP, as today) |
| `system-setup.js` import probes | unchanged — they probe HTTP reachability without credentials and never claim authentication |
| `package.json` `vertex.systems` schema | §3 fields; `user` description updated; `password` explicitly not a setting |

## 12. Errors the user sees

- A refusal from a provider shows its `reason` and `hint` as they come, without rewording. The
  auth stack writes them for people.
- A lost stateful session is reported with what was lost:
  - a held lock: "the lock on ‹object› was lost";
  - an attached debugger: "the debugging session on ‹program› ended".
  The operation is never replayed in a new session.
- An RFC failure shows the connector's message, which names the SAP or SDK cause.

## 13. Packaging

- **New runtime dependencies,** all from the npm registry:
  - `@mcp-abap-adt/auth-broker`, `@mcp-abap-adt/auth-providers`, `@mcp-abap-adt/auth-stores`;
  - `@mcp-abap-adt/connection`, with `@mcp-abap-adt/sap-rfc-lite` as its optional native
    dependency.
- **VSIX targets:**
  - `win32-x64`, `darwin-arm64` and `darwin-x64` carry the `sap-rfc-lite` binary built for that
    target;
  - the universal (no-target) VSIX excludes it, so `snc` is refused by §9 there.
  - The architectures are confirmed with the owner before release: is Windows on arm64 wanted?
- **The SAP NW RFC SDK** is never shipped. The README tells SNC users to install it and put its
  `lib` on `PATH` (Windows) or `DYLD_LIBRARY_PATH` (macOS) before starting VS Code.
- **`engines.vscode`** is raised to the first release whose extension host runs Node 22 or later,
  as measured at feasibility gate 2. Until then it is unchanged.
- **Licences:** the LGPL-3.0-only notices of the auth packages ship with them in `node_modules`.
  The VSIX's third-party notice lists them.

## 14. Tests

- **Unit tests** (`node --test`, no SAP):
  - `systems.js` validation and identity;
  - both stores against the contract's rules (§5);
  - migration, all three cases of §10;
  - `http-wire.js` with a fake provider: header and cookie writing, Oops before sending, 401 →
    `rejected` → one retry, `options.auth` dropped;
  - `rfc-wire.js` with a fake connection: mapping, session mode from the header, stripped
    headers, the CSRF choice;
  - `hosts.js` for every row of §9.
- **Integration**, against real systems, by hand, recorded in `dev_history.md`:

  | Operation | `basic` (on-premise, HTTP) | `snc` (Windows, RFC) |
  |---|---|---|
  | browse, search, read source | ✓ | ✓ |
  | edit: lock, write, unlock, activate | ✓ | ✓ |
  | ABAP Unit, ATC, data preview | ✓ | ✓ |
  | debugger: attach, step, stack, variables, detach | ✓ | ✓ |
  | debugger: listener shutdown time | ✓ | ✓ (gate 4) |
  | migration of an existing password | ✓ | — |
  | refusal on Linux / remote host | — | ✓ |

  macOS SNC is run once a macOS machine with Secure Login Client is available. Until then the
  macOS targets are built but marked unverified in `history.md`.

## 15. Documentation

Per `AGENTS.md`, in the same landing:

- `README.md` and `vscode/README.md`: the `authType`, `snc` and `rfc` settings, SNC prerequisites,
  and which package to install.
- `history.md` and `dev_history.md`: the change.
- `docs/index.html` and `eclipse/README.md` are untouched; the Eclipse host is unchanged.

## 16. Feasibility gates this spec depends on

| Gate | Decides | Section |
|---|---|---|
| 1. SNC reaches the system (`probe/snc`) | that §8 works at all | §8 |
| 2. Extension host runs Node 22+ and loads `sap-rfc-lite` | `engines.vscode`; whether §8 runs in-process | §13 |
| 3. ADT over RFC and `x-csrf-token` | option A or B | §8 |
| 4. Listener deletion ends the long poll over RFC | shutdown design | §8 |

Every gate is a step of the plan and a stop point: work that depends on a gate does not start
before the gate's result is in. Gate 1 runs first, on the owner's Windows machine.

## 17. Not in this landing

- `jwt`, `saml`, their collaborators, renewal, and the cross-window refresh coordination. The
  second landing's spec covers them. This landing's stores already satisfy the contract they
  need.
- The standalone MCP in `mcp/`.
