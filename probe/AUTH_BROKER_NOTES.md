# Auth broker in VERTEX — working notes

Working notes for the `feat/auth-broker` branch: what was read from the code so far, what is
decided, and what still needs measuring. Not user documentation; it goes once the work lands.

## Direction (decided)

- **Path a:** keep `abap-adt-api` for the ADT operations; credentials come from
  `@mcp-abap-adt/auth-broker`.
- **VERTEX implements its own stores** over `vscode.SecretStorage`. The packaged file stores
  (`AbapSessionStore`, `AbapServiceKeyStore`) are not used.
- **SNC is RFC only**, and only on Windows and macOS. It needs `@mcp-abap-adt/sap-rfc-lite` plus a
  user-installed SAP NW RFC SDK. Over HTTP there is nothing to inject for SNC.
- **Several VS Code windows share one refresh token** per destination.

## What the code says

- `abap-adt-api` 8.4.3 accepts a bearer fetcher in place of the password. Its cookie, CSRF and
  login/reset internals have not been read yet; read them before the HTTP design is final.
- Both VERTEX request paths need one auth boundary: `vscode/sap-http.js` (the replaced
  `httpclient`) and `request()` in `vscode/extension.js`.
- **Broker:** `new AuthBroker({ sessionStore, serviceKeyStore, renewal, onWriteFailure })`.
  - The provider is chosen by `authType` / `grantType`: basic, jwt, saml, snc.
  - `getToken` and `refreshToken` work for token rows only. Basic and SNC go through `getProvider`.
  - `saml2_pure` yields cookies, not a bearer token.
- **SNC:** `SncLogonProvider` returns RFC logon parameters only (`snc_mode`, `snc_partnername`,
  `snc_qop`, `snc_lib`, `snc_myname`). The connector feeds them to `sap-rfc-lite`, and ADT goes
  through `SADT_REST_RFC_ENDPOINT`.
  - For SNC, VERTEX needs an adapter under `abap-adt-api` that sends its requests through
    `@mcp-abap-adt/connection` over RFC.
  - For per-destination addresses, compose `AdtOnPremConnector` with an `RfcTransport` built on an
    explicit `ashost` / `sysnr`. `createConnection` derives the address from the URL and
    `SAP_SYSNR`.
  - RFC has no cookies and no CSRF. The adapter strips them.
  - Stateful work holds one RFC conversation. A context reset kills its locks.
  - The debugger's long poll cannot be cancelled natively. Delete the listener from another
    conversation, and measure whether SAP accepts that.
- **Stores to implement:**

  ```ts
  // ISessionStore
  loadSession(d)
  saveSession(d, cfg)
  deleteSession?(d)
  getAuthorizationConfig(d)
  getConnectionConfig(d)
  setAuthorizationConfig(d, a)
  setConnectionConfig(d, c)

  // IServiceKeyStore
  getServiceKey(d)
  getAuthorizationConfig(d)
  getConnectionConfig(d)
  getClientCertificate?(d)
  ```

  A session store must persist `issuedFor` / `issuedBy` beside the secret. Without them the broker
  never reuses a session.
- **Shared refresh token across windows:** each window is its own extension-host process.
  - SecretStorage is shared, and `onDidChange` signals changes, but nothing in it is atomic.
  - The broker keeps the refresh token in its provider's memory, and it joins renewals only within
    one process.
  - `refreshThenLogin()` falls back to a login on any refresh failure, including `invalid_grant`.
  - Recommended: a per-destination lock across processes (a lock file under the shared
    `globalStorageUri`) covering re-read → renew or log in → persist. Use a freshly seeded provider
    inside the lock.
  - A renewal-lock port in the auth stack would be the cleaner long-term fix.
  - Only the token envelope is shared between windows. SAP cookies and CSRF stay per window and
    per session.
- **Runtime:** broker, providers and stores need Node 22+. VERTEX declares VS Code `^1.85`, so
  verify the extension host's Node before choosing a minimum VS Code. `sap-rfc-lite` is N-API 8,
  so ship one platform-specific VSIX per OS and architecture, without the SDK.
- **Licences:** VERTEX is MIT; the auth stack is LGPL-3.0-only. They are compatible, provided the
  libraries stay separate, replaceable modules and their notices ship.

## Measurements, in order

1. `probe/snc`: broker + SNC + RFC outside VS Code: provider, connect, discovery, source,
   LOCK/UNLOCK.
2. The same stack inside the VS Code extension host: its Node version, and whether `sap-rfc-lite`
   loads under Electron.
3. HTTP paths:
   - concurrent 401s;
   - expiry;
   - refresh between LOCK and UNLOCK, and at a debugger stop;
   - two windows racing one refresh token.
4. SNC in VERTEX:
   - locks and writes;
   - debugger attach, step, variables and detach;
   - listener long poll and deleting it from another conversation;
   - shutdown time.
