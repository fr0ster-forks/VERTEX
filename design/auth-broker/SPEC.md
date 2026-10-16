# Spec: auth broker in VERTEX — first landing (`basic` and `snc`)

Implements the first landing of [GOAL.md](GOAL.md). The second landing (`jwt`, `saml`) gets its
own spec. Where this one lays groundwork for it, that is said, and nothing more of it is built
here.

## 1. The shape in one paragraph

VERTEX keeps `abap-adt-api` for every ADT operation. Below it, VERTEX already replaces the
library's HTTP client with its own (`vscode/sap-http.js`). That replacement becomes a **wire** for
the auth stack's `IAuthProvider` contract.

A provider is asked for at four moments:

- `prepare()` once per provider;
- `establish(logon)` once per logon;
- `authorize(request)` before every request attempt;
- `rejected(rejection)` when the system refuses.

The provider writes into targets the wire hands it: headers, cookies and RFC logon parameters. The
wire never learns which credential it carries, and a provider never learns which wire carries it.

- **`basic`:** the provider comes from the broker, and the wire is HTTP.
- **`snc`:** the provider comes from the broker, and the wire is the connector's RFC transport,
  reached through an adapter that speaks the same request contract.

`jwt` and `saml` in the second landing reuse the HTTP wire with other providers.

A wire belongs to one `ADTClient` and lives as long as it does. Its SAP session is replaceable
underneath it (§8.4), so a cached client is never left holding a spent connection.

## 2. Components

All new code is plain CommonJS under `vscode/auth/`. No bundler.

| File | Responsibility |
|---|---|
| `auth/systems.js` | Reads a `vertex.systems` entry into a validated system (§3); computes the system's login identity (§4.1) and its connection key (§4.2). |
| `auth/stores.js` | `VertexServiceKeyStore` (`IServiceKeyStore`) and `VertexSessionStore` (`ISessionStore`) over `vscode.SecretStorage` (§5). |
| `auth/broker.js` | One `AuthBroker` per extension host, built from the two stores. `providerFor(system, signal)` returns `broker.getProvider(identity, { signal })` (§6). |
| `auth/http-wire.js` | `createHttpWire(system)` → `{ request(options), dispose() }`. The contract `sap-http.js` has today, driving the provider's moments (§7). |
| `auth/rfc-wire.js` | `createRfcWire(system)` → the same contract, carried over `@mcp-abap-adt/connection`'s RFC transport (§8). Required lazily, only for `snc`, and only after §9 allows it. |
| `auth/hosts.js` | `refusalFor(system)` → `null` or a sentence, decided before anything native is required (§9). |
| `auth/migrate.js` | Moves legacy `vertex.password.<name>` entries to the new store, once (§10). |
| `auth/clients.js` | `makeClient(system, role)` → an `ADTClient` on the right wire. It is the one place the repository, the debugger and the commands build clients (§11). |

`vscode/sap-http.js` is deleted. Its TLS policy, origin guard and keep-alive agent move into
`http-wire.js` unchanged.

## 3. Settings

`vertex.systems[]` gains:

| Field | Type | Meaning |
|---|---|---|
| `authType` | `"basic"` \| `"snc"` | Absent means `"basic"`. The second landing adds `"jwt"` and `"saml"`. |
| `snc` | object | Required when `authType` is `"snc"`: `partnerName` (required, the system's SNC name, e.g. `p:CN=SID, O=ACME`), `qop` (optional, `"1"`, `"2"`, `"3"`, `"8"` or `"9"`), `library` (optional path; discovered when absent), `myName` (optional). |
| `rfc` | object | Required when `authType` is `"snc"`: `ashost` (application server host), `sysnr` (two digits), `saprouter` (optional). Never derived from `url`. |

- `url` stays required for every type. For HTTP it is the ADT origin. For `snc` it names the
  system for identity and WebGUI.
- `client` keeps its meaning.
- `user` stays required for every type:
  - for `basic` it is the logon user;
  - for `snc` it is the ABAP user the debugger targets, since VERTEX's debugger identifies its
    debuggee by user. It is identification only and carries no password.
- Settings never hold a secret. The schema says so, and `systems.js` refuses an entry that has a
  `password` field.

`systems.js` answers `{ system }` or `{ error }`. The error is a sentence naming the missing or
wrong field. It replaces `missing()` in `extension.js`.

## 4. Identities

### 4.1 Login identity — where a system's credential is filed

```
loginIdentity = "vertex.auth.v1." + sha256(JSON.stringify([
  canonicalOrigin(url), client || "", authType, user.toUpperCase(),
])).slice(0, 32)
```

- `canonicalOrigin` lower-cases the scheme and host and makes the port explicit.
- The display name is not part of it, so renaming a system keeps its login.
- Changing the URL, client, type or user is a different login, by design.
- The login identity is the broker's destination name.

### 4.2 Connection key — when a cached client must be rebuilt

```
connectionKey = JSON.stringify([
  name, canonicalOrigin(url), client || "", user.toUpperCase(), authType,
  allowInsecureCertificate === true, snc || null, rfc || null,
])
```

The connection key replaces:

- `systemKey()` in `extension.js`, which the debugger uses to decide reuse;
- the repository cache key in `code-workbench.js`;
- the saved-editor key.

A changed RFC address, SNC setting or certificate policy is therefore a different client.

**Saved editors are restored against the current settings, never from a snapshot.**

- A saved editor stores the system's `name` and the connection key it was opened with.
- On restore, VERTEX picks the current system in this order:
  1. the one whose connection key equals the saved key;
  2. otherwise the one system with the saved name;
  3. if several systems have that name and none matches the key, nothing: the editor shows
     "several systems are named ‹name›; this tab cannot tell which one it belongs to".

  It builds the repository from that definition. The credential then comes from the current login identity,
  which is the only one the store answers (§5.1).
- If no system has that name, the editor shows "‹name› is no longer in vertex.systems" instead of
  content.
- If the current definition's connection key differs from the saved one, the editor re-reads its
  object from the current system, because the source may differ.
  - If that read fails, for example because the object does not exist there, or the system cannot
    be reached or refuses the login, the editor shows the failure instead of content.
  - The saved content is discarded in that case, never shown or saved against the new system.
    This replaces `code-workbench.js`'s fallback to the saved data when a read fails
    (`:423–439`), for the changed-key case.
  - With an unchanged key, the existing fallback stays as it is.

This replaces `code-workbench.js`'s rebuild of a system from the saved key (`:362–366`).

## 5. Stores

Both stores implement the contracts of `@mcp-abap-adt/interfaces-auth-broker`. Every secret goes
to `context.secrets`; nothing goes to settings, `globalState` or a file.

### 5.1 `VertexServiceKeyStore` — the means

| Method | Answer |
|---|---|
| `getConnectionConfig(identity)` | The record described below, composed from two sources. `null` when no system in the current settings has that identity. |
| `getServiceKey(identity)` | The same record as `getConnectionConfig`. |
| `getAuthorizationConfig(identity)` | `null` — no OAuth client in this landing. |
| `getClientCertificate` | not implemented |

The record has:

- **non-secret fields from settings:** `serviceUrl`, `sapClient`, `authType`, and for `snc` also
  `sncPartnerName`, `sncQop`, `sncLib` and `sncMyName`;
- **secret means from SecretStorage key `<identity>.means`:** for `basic`, `{ username, password }`.

### 5.2 `VertexSessionStore` — the secret a session holds

The secret lives under `<identity>.session` as JSON. In this landing the broker writes nothing
here, because `basic` and `snc` obtain no session secret. The store is still complete now, so that
the second landing only uses it. Its write rules are exactly those of the reference store
(`auth-stores/src/session/sessionSecret.ts`, `applySecret`):

- **Writing a credential.**
  - A token or cookies written replaces the other kind.
  - Its `expiresAt` is what the write gives: none given, none kept.
  - Writing `""` clears that kind and its expiry. Clearing the kind not held changes nothing.
  - A write carrying a token and cookies together is refused.
- **`expiresAt` alone** updates the expiry of the credential held.
- **`refreshToken`:** a given value is kept, `""` clears it, and absent leaves it.
- **`issuedFor` and `issuedBy`.**
  - They go with the credential. A credential write takes the values it gives and clears the ones
    it omits.
  - Without a credential write, a given value is set, `""` clears it, and absent leaves it.
  - With no credential held after the write, neither is kept.
- **A stored record that is not the store's own format** is refused whole. Nothing is answered
  from it.

The methods:

| Method | Behaviour |
|---|---|
| `loadSession` | the stored secret, or `null` |
| `saveSession` | `applySecret` over the stored secret, then store the result |
| `deleteSession` | delete the key |
| `getConnectionConfig` | the secret's fields as `IConnectionConfig`: token or cookies, `expiresAt`, `issuedFor`, `issuedBy` |
| `setConnectionConfig` | like `saveSession` |
| `getAuthorizationConfig` | `null`, as the reference `SecretSessionStore` answers (`SecretSessionStore.ts:156–177`) |
| `setAuthorizationConfig` | refused, as the reference store refuses it |

The refresh token is written and read through `saveSession` and `loadSession` only.

Writes to one identity are serialized inside the extension host. Coordination across windows is
the second landing's.

### 5.3 Password entry and forgetting

- When a `basic` system's means lack a password, VERTEX asks for it, with the prompt naming the
  user and the system as today. It writes the password to `<identity>.means` before asking the
  broker for a provider.
- "Forget credentials" deletes `<identity>.means` and `<identity>.session`.

## 6. Broker

```js
const { AuthBroker } = require("@mcp-abap-adt/auth-broker");
new AuthBroker({ sessionStore, serviceKeyStore }, logger);
```

- Neither `renewal` nor `onWriteFailure` is needed: the broker requires them only for rows that
  write a secret. The second landing adds them.
- The logger is VERTEX's output channel, at debug level.
- **A provider is asked for, not kept.**
  - The broker rebuilds a provider when its means change, for example after a new or forgotten
    password, and leaves earlier holders on the old one.
  - So the HTTP wire calls `providerFor` before every request (§7). The broker answers its cached
    provider while the means are unchanged.
  - The RFC wire calls it when it opens a session (§8.4).
- **A change in another window** reaches this one the same way. The broker reads the means from
  the store, the store reads SecretStorage, and SecretStorage is shared by the windows of a
  profile.

## 7. HTTP wire

`createHttpWire(system)` returns `{ request(options), dispose() }`. This is the contract
`abap-adt-api` calls on its replaced `httpclient`:

- **in:** `options` = `{ url, method, qs, headers, body, timeout, auth }`;
- **out:** `{ body, status, statusText, headers }`.

For every request:

1. **Ask for the provider.** `provider = await providerFor(system, signal)`.
   - If it is a provider the wire has not seen before, call `await provider.prepare()` and
     `await provider.establish(httpLogonTarget)` once.
   - `httpLogonTarget.logonParameters()` and `.tlsMaterial()` both answer Oops `logon-target`:
     HTTP takes no RFC parameters, and nothing uses client certificates yet. The `basic`
     provider ignores both, and its header carries it.
   - An Oops from `prepare` fails the request with the refusal.
2. **Build the request.** Build the URL and apply the origin guard, as `sap-http.js` does today.
   Drop `options.auth`: the credential comes from the provider only.
3. **Authorize.** Call `provider.authorize(target)`, where the target is
   `{ header(name, value), cookies(value) }`:
   - `header` sets the outgoing header;
   - `cookies` merges with the `Cookie` header `abap-adt-api` put on the request, and the
     library's session cookies win on a name clash.

   An Oops does not send the request; it fails it with the refusal.
4. **Send.**
5. **On status 401, at most once per request:**
   - call `provider.rejected({ at: "request", status: 401, error: response })`;
   - on Ok, send once more from step 1;
   - on Oops, or on a second 401, return the 401 response unchanged and record the refusal for
     the caller (§12).

The wire never calls `login()` and never touches the library's cookies.

**What `abap-adt-api` is given.** Its constructor demands a password string or a token function.
VERTEX passes the constant `"-"`, which is no secret. The wire drops the `options.auth` it
produces.

**What the library does with a 401 the wire returns.**

- `_request` turns a returned error response into an exception through `fromResponse`
  (`AdtHTTP.js:225–226`, `AdtException.js:115–123`).
- **If the body contains `CSRF`,** the exception is an `AdtCsrfException`, whatever the status
  (`AdtException.js:118–119`).
- **Otherwise** it is an ADT-type exception: through `simpleError` when there is no body or no
  `exc:exception` root, or the parsed ADT error (`AdtException.js:112`, `:116–117`, `:120–121`).
- `isLoginError` matches an HTTP-type exception with status 401, or a CSRF exception
  (`AdtException.js:110`). Of the two, a returned response can only ever produce the CSRF
  exception.
- `request()` logs in again once, and retries once, only on a login error, when the request was
  not itself the auto-login, and when the client is stateless (`AdtHTTP.js:157–173`). That login
  clears the library's cookies.

So a request the provider refuses (`basic`: `rejected` answers Oops, so the wire never retries)
costs the following. The library's login calls `_request` directly (`AdtHTTP.js:121`), so it never
logs in again itself, and a refused login throws before the original request is retried
(`AdtHTTP.js:162–168`).

| Client state | Response body | Sends | The caller receives |
|---|---|---|---|
| not yet logged in (no CSRF token held) | any | 1: the auto-login itself, refused | the login's error |
| logged in, stateful | any | 1 | the 401 |
| logged in, stateless | no `CSRF` in it | 1 | the 401 |
| logged in, stateless | `CSRF` in it | 2: the request, then the library's login, refused the same way | the login's error |

With the second landing's token providers, the wire's own retry adds one send to each refused send.

VERTEX reports the final 401 and discards the refused password (§12). The test suite pins every
row of this table with the real `AdtHTTP` and `AdtException` (§14).

`dispose()` destroys the keep-alive agent.

## 8. RFC wire (`snc`)

`createRfcWire(system)` returns `{ request(options), dispose() }`, with the same request contract
as §7.

### 8.1 Construction and the native module

- `rfc-wire.js` requires `@mcp-abap-adt/sap-rfc-lite` inside a `try`.
- If the require fails, every request fails with VERTEX's sentence: "SNC needs the SAP NW RFC SDK:
  install it, put its lib directory on PATH (Windows) or DYLD_LIBRARY_PATH (macOS), and restart
  VS Code. The load failed with: ‹message›".
- VERTEX translates this itself. The connector's own SDK message lives in `rfcConversationFrom`,
  which this design does not use (`rfcConversation.ts:76`).
- A session (§8.4) is built as:
  - `new AdtOnPremConnector(config, provider, new RfcTransport(open, logger), logger)`;
  - `open` is `logon => new Client({ ashost, sysnr, ...(saprouter ? { saprouter } : {}), client,
    lang: "EN", ...logon })`, with the address from `system.rfc`;
  - `open` catches a throwing `new Client(...)` and rethrows it with VERTEX's sentence. A factory
    is called outside the transport's open-error handling (`RfcTransport.ts:525`).
- `rfcConversationFrom` and `SAP_SYSNR` are not used: they are derived, and `SAP_SYSNR` is
  process-wide.
- The connector calls the provider's `prepare` and `establish`. SNC's logon parameters reach the
  native client there.

### 8.2 Request mapping

- **In:** `method` becomes `options.method || "GET"`. `AdtHTTP.login()` and `dropSession()` pass
  no method (`AdtHTTP.js:121–123`, `:146`), and the connector upper-cases it at once
  (`AbstractAbapConnection.ts:1299`). `url` and `qs` become `{ url, params }`, `body` becomes
  `data`, `headers` pass on, and `timeout` passes on.
- **Out:** `{ data, status, statusText, headers }` becomes `{ body, status, statusText, headers }`.
- **Failures:**
  - A connector error that carries a response becomes that response, so `abap-adt-api` reads it
    like any other.
  - A failure without a response, i.e. an RFC failure, is thrown with its message.
- **Removed before RFC:** `Authorization`, `Cookie`, `x-csrf-token` and `X-sap-adt-sessiontype`.
  RFC has no cookies or CSRF, and the RFC transport forwards headers verbatim.

### 8.3 Session mode, and one request at a time

- **Mode.** The wire keeps the effective mode the same way `AdtHTTP` does (`AdtHTTP.js:16–20`,
  `:44–55`). An `X-sap-adt-sessiontype` header with value:
  - `stateful` sets the mode to stateful;
  - `stateless` sets it to stateless;
  - `""` (`keep`) leaves it as it was.
- **One request at a time.** An RFC wire sends one request at a time. A request waits for the
  previous one to settle, then calls `connection.setSessionType(mode)`, then
  `makeAdtRequest(...)`.
  - The connector's mode is mutable, and `makeAdtRequest` reads it only after authorization
    (`AbstractAbapConnection.ts:1408`). Overlapping requests on one connection could therefore
    pick up each other's mode.
  - The cost is that one client's requests do not overlap over RFC. Clients that must run
    concurrently get separate wires (§11).

### 8.4 Sessions under a wire

A wire holds at most one live connector, its **session**. A connector is spent after
`disconnect()` and cannot be connected again (`AbstractAbapConnection.ts:416`), so:

- **Opening.** The first request with no live session builds one, with the provider from
  `providerFor`, and `connect()`s it. If construction or `connect()` fails:
  - the request fails;
  - the wire stays without a session;
  - the next request tries again.
- **Ending.** When `abap-adt-api` sends `GET /sap/public/bc/icf/logoff`, from its `logout()`
  (`AdtHTTP.js:133–143`):
  - the wire answers it locally with 200 and an empty body;
  - it waits for the request in progress;
  - it calls `disconnect()`.

  The next request opens a fresh session. A cached client therefore survives
  `sap-code.js`'s `logout()` after every apply, and the debugger's release paths.
- **No mid-operation swap.** A session ends only at a logoff or a `dispose()`, and the wire's
  queue (§8.3) keeps both from overlapping a request.
- **`dropSession()`** sends a stateless `GET /sap/bc/adt/compatibility/graph`, which goes through
  as an ordinary request.
- **`dispose()`** ends the live session, if any, the same way as a logoff. The wire stays usable,
  so a later request opens a new session.
  - VERTEX calls it when a repository is dropped from the cache, on every debugger release path
    (`debugger.js:237`, `:729`, `:986`), and for every wire on deactivate.

### 8.5 CSRF — feasibility gate 3

`abap-adt-api` counts itself logged in only once a response carries `x-csrf-token`
(`AdtHTTP.js:63–65`, `:227–229`). Until then it calls `login()` before every request, at the cost
of an extra `GET /sap/bc/adt/compatibility/graph` each time.

**Before choosing an option, measure whether ADT over RFC returns `x-csrf-token`.**

- **(A) It does.** Nothing more is needed.
- **(B) It does not.** The RFC wire adds `x-csrf-token: rfc` to every response it returns to
  `abap-adt-api`.
  - The value never travels to SAP, because §8.2 strips the header on the way out.
  - It is a local marker on the library side, not a token presented to SAP. It only stops the
    library's login loop.

The choice is recorded with the measurement.

### 8.6 Listener shutdown — feasibility gate 4

- The listener's long poll occupies the `listener` wire's queue (§8.3).
- Shutdown deletes the listener through the `probe` wire. It then awaits the pending poll,
  bounded by the measured time.
- If SAP does not end the poll on deletion, the owner decides the outcome before work continues.

## 9. Hosts

`refusalFor(system)` runs before a client is built and before `rfc-wire.js` is required:

| Condition | Answer |
|---|---|
| `authType` is `"snc"` and `vscode.env.remoteName` is set | "SNC needs the local VS Code on Windows or macOS; this window runs on a remote host (‹remoteName›)." |
| `authType` is `"snc"` and `process.platform` / `process.arch` is neither `win32` / `x64` nor `darwin` / `arm64` | "SNC runs on Windows x64 and macOS on Apple silicon only." |
| `authType` is `"snc"` and `require.resolve("@mcp-abap-adt/sap-rfc-lite")` fails | "This VERTEX package has no SNC support; install the Windows or macOS package of VERTEX." |
| otherwise | `null` |

- `require.resolve` finds the module without loading it. A module that resolves but cannot load,
  for example because the SDK is not on `PATH`, is reported by §8.1.
- `basic` is never refused here. It works wherever it works today, remote hosts included.

## 10. Migration of Basic passwords

Migration runs **once**, on the first activation of the version that ships this. It is marked done
in `globalState` (`vertex.auth.migrated = 1`).

For every legacy key `vertex.password.<name>`:

1. **Exactly one system in settings has that name, and it is `basic`:**
   - copy the password to that system's `<identity>.means`;
   - read it back;
   - delete the legacy key.
2. **No system, or several systems, have that name:** the legacy key is left in place. When one
   of those systems first needs a password, VERTEX asks for it, as for any system without one.
   Once no system of that name lacks its own login, the legacy key is deleted.

This is GOAL criterion 6 as decided:

- The legacy key records nothing but the name.
- At the moment of migration, the system of that name is the definition the password has been
  used with, because until this version every request read the password by that name.
- From then on, the password is filed under the login identity. Any later change of URL, client,
  type or user is a different identity and asks.

The one case this cannot see is a definition edited and never used again before the upgrade.
There the password is attributed to the edited definition, which is what VERTEX does today. The
GOAL accepts this limit.

## 11. Integration points in `vscode/`

| Where | Change |
|---|---|
| `extension.js` `secretKey`, `password` | replaced by `stores.js` + §5.3 prompt + §10 |
| `extension.js` `request`, `csrf`, `fetch` (the own HTTP path) | `request` sends through the system's wire (`http-wire.js`, or `rfc-wire.js` for `snc`) instead of its own `http.request`; `csrf` stays for HTTP and is skipped for `snc` (no CSRF over RFC); the 401 branch discards a refused password through the store |
| `extension.js` `systemKey` | replaced by the connection key (§4.2) |
| `extension.js` `debuggerFor` → `connect` / `make` / `open` | `makeClient(system, "listener")`, `makeClient(system, "probe")`, and per stopped program `makeClient(system, "debuggee")` with `stateful` + `login()` as today |
| `debugger.js` operations that use `listener` besides the poll — breakpoint sync (`:268`), source reads (`:1147`), class-component reads (`:1161`), listener takeover delete (`:620`) | move to `probe`, for every authentication type. Over RFC the listener's queue is held by the poll (§8.3); over HTTP the move changes nothing. |
| `debugger.js` release paths (`:237`, `:729`, `:986`) | each ends its clients' sessions (`logout`, or `dispose()` for a client that is dropped) |
| failure paths: the debuggee's failed `login()` in `open` (`extension.js:790–794`), a failed attach or first snapshot (`debugger.js:642`, `:653–677`), a listener/probe pair replaced on a system switch (`debugger.js:220`) | each calls `dispose()` on every client it built and does not keep, before rethrowing or replacing it. A client that is dropped without `dispose()` would hold its RFC conversation until deactivate. |
| `extension.js` test-connection, forget-password commands | test sends a discovery GET through the system's wire; forget becomes "Forget credentials" (§5.3) |
| `code-workbench.js` `repository()` and saved-editor keys | `makeClient(system, "repository")`; restore per §4.2 against current settings |
| `sap-code.js` `logout()` calls | unchanged; the wire handles the logoff (§8.4) |
| `system-setup.js` import probes | unchanged; they probe HTTP reachability without credentials and never claim authentication |
| `package.json` `vertex.systems` schema | §3 fields; `user` description updated; no `password` |

Every client built anywhere goes through `makeClient`. A `grep` for `new ADTClient` outside
`auth/clients.js` must come back empty.

## 12. Errors the user sees

- **A provider refusal** shows its `reason` and `hint` as they come. The auth stack writes them for
  people.
- **A lost stateful session** is reported with what was lost, and the operation is never replayed:
  - "the lock on ‹object› was lost";
  - "the debugging session on ‹program› ended".
- **An RFC failure** shows the connector's message. A failure to load the native module shows
  §8.1's sentence.

## 13. Packaging

- **New runtime dependencies, from the npm registry:**
  - `@mcp-abap-adt/auth-broker`, `@mcp-abap-adt/auth-providers`, `@mcp-abap-adt/auth-stores`;
  - `@mcp-abap-adt/connection`. Its optional dependency `@mcp-abap-adt/sap-rfc-lite` 0.2.3 ships
    prebuilt bindings under `prebuilds/<platform>-<arch>/` for `win32-x64`, `darwin-arm64` and
    `linux-x64`, loaded by `node-gyp-build`.
- **Targets:**

  | Target | Built on | `sap-rfc-lite` |
  |---|---|---|
  | `win32-x64` | any machine; prebuilt binding from sap-rfc-lite; no SDK at install | own prebuilt binding only |
  | `darwin-arm64` | any machine; prebuilt binding from sap-rfc-lite; no SDK at install | own prebuilt binding only |
  | universal (no target) | any, `npm ci --omit=optional` | absent |

  SNC supports Windows x64 and macOS on Apple silicon only. `darwin-x64` is no longer supported
  by the vendor; `win32-arm64` is not available to test. Neither is supported by VERTEX.
- **`package.ps1`** gains `-Target <target>`. For a native target, after `npm ci` it fails if its
  own prebuilt binding (`prebuilds/<target>/*.node`) is missing. It removes the other platforms'
  prebuilds and any `build/` directory, then runs `vsce package --target <target>`. No SDK or
  toolchain is needed at install; the SDK is needed only at run time.
- **After packaging,** the script lists the archive and fails on any of these:
  - a native target without its own prebuilt `+sap-rfc-lite` `.node` binding or with another
    platform's binding (including `sapnwrfc.node` from a local build);
  - the universal package with any `sap-rfc-lite` binding (`+sap-rfc-lite` `.node` files or
    `sapnwrfc.node`);
  - any package with an SAP SDK file (`sapnwrfc*`, `libsapnwrfc*`, `libsapucum*`, `icu*` from the
    SDK; binding names are checked separately).
- **The SAP NW RFC SDK** is never shipped. The README tells SNC users to install it and put its
  `lib` on `PATH` (Windows) or `DYLD_LIBRARY_PATH` (macOS) before starting VS Code.
- **`engines.vscode`** stays `^1.85.0`, as upstream (owner's decision after gate 2, recorded in
  `GATES.md`). The auth stack declares Node 22+, so its use on the older extension hosts this
  admits (Node 18 from 1.85) is verified for `basic`; where it does not work, VERTEX refuses with
  a message rather than crashing.
- **Licences:** the auth packages' LGPL-3.0-only texts ship in `node_modules`, and the VSIX's
  third-party notice lists them.

## 14. Tests

**Unit** (`node --test`, no SAP):

- `systems.js`:
  - validation, including the refused `password` field;
  - login identity and connection key.
- **Stores:** every rule of §5.2, each method of §5.1 and §5.2, and a malformed record refused.
- **Migration:** unique name, missing name, duplicate names, and the deletion of a legacy key that
  is no longer needed.
- **`http-wire.js`**, with a fake provider and a local HTTP server:
  - header and cookie writing;
  - an Oops before sending;
  - 401 → `rejected` → one retry;
  - Oops → no retry;
  - `options.auth` dropped;
  - a new provider instance after the means change.
- **The wire under the real `abap-adt-api`:** an `ADTClient` on `http-wire.js` against the local
  server, pinning every row of §7's table: a client not yet logged in, and logged-in stateful and
  stateless clients with bodies with and without `CSRF`.
- **`rfc-wire.js`**, with a fake connector:
  - mapping;
  - stripped headers;
  - mode `stateful` → `keep` → `stateless`;
  - two overlapping requests with different modes, serialized;
  - logoff ends the session, and the next request opens a new one;
  - a request without `method` goes as GET;
  - a failed open, retried on the next request;
  - read, apply (logoff), read, apply on one cached client.
- **`hosts.js`:** every row of §9.

**Integration** — against real systems, by hand, recorded in `dev_history.md`:

| Operation | `basic` (on-premise, HTTP) | `snc` (Windows, RFC) |
|---|---|---|
| browse, search, read source | ✓ | ✓ |
| edit: lock, write, unlock, activate — twice on one cached client | ✓ | ✓ |
| ABAP Unit, ATC, data preview | ✓ | ✓ |
| debugger: attach, step, stack, variables, detach, attach again | ✓ | ✓ |
| debugger: a failed attach leaves no RFC conversation open (SM04 / SMGW) | — | ✓ |
| restore a saved editor after its system's URL changed and the object is absent there: failure shown, no old source | ✓ | ✓ |
| breakpoint change and source read while the listener polls | ✓ | ✓ |
| listener shutdown time | ✓ | ✓ (gate 4) |
| password changed in window A is used by window B | ✓ | — |
| migration of an existing password | ✓ | — |
| refusal on Linux / remote host | — | ✓ |

macOS (Apple silicon) SNC is run once a macOS (Apple silicon) machine with Secure Login Client
is available. Until then the `darwin-arm64` target is built and marked unverified in `history.md`.

## 15. Documentation

Per `AGENTS.md`, in the same landing:

- `README.md` and `vscode/README.md`: the `authType`, `snc` and `rfc` settings, the SNC
  prerequisites, and which package to install.
- `history.md` and `dev_history.md`: the change.
- `docs/index.html` and `eclipse/README.md` are untouched; the Eclipse host is unchanged.

## 16. Feasibility gates this spec depends on

| Gate | Decides | Section |
|---|---|---|
| 1. SNC reaches the system (`probe/snc`) | that §8 works at all | §8 |
| 2. Extension host runs Node 22+ and loads `sap-rfc-lite` | `engines.vscode`; whether §8 runs in-process | §13 |
| 3. ADT over RFC and `x-csrf-token` | option A or B | §8.5 |
| 4. Listener deletion ends the long poll over RFC | shutdown design | §8.6 |

Every gate is a step of the plan and a stop point: work that depends on a gate does not start
before the gate's result is in. Gate 1 runs first, on the owner's Windows machine.

## 17. Not in this landing

- `jwt`, `saml`, their collaborators, renewal, and the cross-window refresh coordination. The
  second landing's spec covers them. This landing's stores already satisfy the contract they
  need.
- The standalone MCP in `mcp/`.
