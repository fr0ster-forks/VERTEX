# Auth broker in VERTEX — first landing (`basic` + `snc`) Implementation Plan

> **For agentic workers:** this plan is executed one task at a time by codex (the `codex:codex-rescue`
> subagent), each task reviewed before the next starts. Tasks marked **OWNER** are run by the owner
> on the Windows machine with SNC. A task marked **STOP** is a gate: no later task that depends on
> it starts before its result is recorded in `design/auth-broker/GATES.md`. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** VERTEX authenticates `basic` and `snc` systems through the `@mcp-abap-adt` auth broker,
with secrets in VS Code SecretStorage, Basic passwords migrated, and SNC over RFC on Windows/macOS.

**Architecture:** `abap-adt-api` stays. Its replaced HTTP client becomes a *wire* driving the
broker's `IAuthProvider` moments (`prepare`, `establish`, `authorize`, `rejected`): an HTTP wire
for `basic`, an RFC wire over `@mcp-abap-adt/connection` for `snc`. VERTEX implements the broker's
two store contracts over SecretStorage. One factory (`auth/clients.js`) builds every `ADTClient`.

**Tech Stack:** VS Code extension, plain CommonJS, `node --test`; `abap-adt-api` 8.4.3;
`@mcp-abap-adt/auth-broker` ^5.0.6, `auth-providers` ^6.0.2, `auth-stores` ^5.0.1,
`auth-errors` ^2.2.1, `connection` ^17.1.0 (optional native `sap-rfc-lite` ^0.2.2).

**Spec:** [`design/auth-broker/SPEC.md`](SPEC.md) (implements [`GOAL.md`](GOAL.md)). Every task
reads the spec section it names.

## Global Constraints

- Dependencies come from the npm registry only; after every install, `package-lock.json` has no
  `"link": true` and no `file:` / `link:` specifier.
- No change to the auth stack, the connector or `sap-rfc-lite`. No lock, no new port.
- No secret in settings, `globalState`, a file or a log. Only `context.secrets`.
- All new code is CommonJS under `vscode/auth/`, no bundler; modules take their VS Code objects as
  parameters so `node --test` runs them without VS Code.
- `basic` keeps working wherever it works today, remote extension hosts included.
- `snc` only on a local extension host on `win32` or `darwin` (SPEC §9).
- Documentation per `AGENTS.md`: `README.md`, `vscode/README.md`, `history.md`, `dev_history.md`.
- Every `ADTClient` is built in `vscode/auth/clients.js`; `grep -n "new ADTClient" vscode --include=*.js`
  outside that file returns nothing (test files excepted).
- Run tests from `vscode/`: `npm test`. All existing tests stay green.

## Review Focus

1. **Two systems with the same `name`** in `vertex.systems` — each keeps its own login; migration
   leaves the legacy key and asks (pinned in Task 4).
2. **A system edited in settings while its editor tab is open and restored later** — the tab shows
   the failure, never the old source against the new system (pinned in Task 10).
3. **A `basic` password typed wrong** — exactly one request per SPEC §7's table, the stored password
   discarded, no prompt loop (pinned in Task 5 and Task 8).
4. **The debugger switched to another system mid-session, or an attach that fails** — no RFC
   conversation left open (pinned in Task 9).
5. **The universal VSIX on Windows with an `snc` system** — a refusal naming the right package,
   before anything native loads (pinned in Task 6 and Task 12).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `probe/snc/probe.js` | gates 1, 3, 4 outside VS Code | 1 |
| `probe/host/` | gate 2: a minimal extension reporting the host runtime | 2 |
| `design/auth-broker/GATES.md` | recorded gate results and decisions | 1, 2 |
| `vscode/auth/systems.js` | settings → system; login identity; connection key | 3 |
| `vscode/auth/session-secret.js` | the session write rules (port of `applySecret`) | 4 |
| `vscode/auth/stores.js` | `IServiceKeyStore` + `ISessionStore` over SecretStorage; means | 4 |
| `vscode/auth/migrate.js` | one-time Basic password migration | 4 |
| `vscode/auth/broker.js` | the extension host's `AuthBroker`; `providerFor` | 5 |
| `vscode/auth/http-wire.js` | HTTP wire | 5 |
| `vscode/auth/hosts.js` | `refusalFor(system)` | 6 |
| `vscode/auth/rfc-wire.js` | RFC wire | 7 |
| `vscode/auth/clients.js` | `makeClient(system, role)` | 8 |
| `vscode/extension.js` | password, own request path, commands, debugger wiring | 8, 9 |
| `vscode/debugger.js` | listener→probe moves, failure-path cleanup | 9 |
| `vscode/code-workbench.js` | repository via `makeClient`; restore against current settings | 10 |
| `vscode/package.json` | dependencies; `vertex.systems` schema | 3, 11 |
| `vscode/sap-http.js` | deleted | 8 |
| `vscode/package.ps1` | `-Target`, native/SDK checks | 12 |
| `vscode/test/auth-*.test.js` | unit tests per module | 3–10 |
| docs | README, vscode/README, history, dev_history | 11 |

---

### Task 1 (OWNER, STOP): Gates 1, 3, 4 — SNC over RFC outside VS Code

**Files:**
- Modify: `probe/snc/probe.js`
- Create: `design/auth-broker/GATES.md`

**Interfaces:** Produces the gate results later tasks read: gate 1 (pass/fail), gate 3
(`csrf: "A"` or `"B"`), gate 4 (listener deletion ends the poll: yes/no, seconds).

- [ ] **Step 1 (codex): extend the probe with gate 3 and gate 4.** Add to `probe/snc/probe.js`, after
  `read source`, behind flags `--csrf` and `--listener`:

```js
    if (opts.csrf) {
      await step('csrf fetch over RFC', async () => {
        const r = await connection.makeAdtRequest({
          url: '/sap/bc/adt/discovery', method: 'GET', timeout: 60000,
          headers: { Accept: 'application/atomsvc+xml', 'x-csrf-token': 'fetch' },
        });
        const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
        return { status: r.status, csrfHeaderPresent: 'x-csrf-token' in h,
          csrfLooksLikeToken: typeof h['x-csrf-token'] === 'string' && h['x-csrf-token'].length > 8 };
      });
    }
    if (opts.listener) {
      // Gate 4: a listener long-poll on one connection, deleted from a second one.
      const user = String(opts.user || '').toUpperCase();
      if (!user) throw new Error('--listener needs --user <ABAP user>');
      const ide = 'VERTEXPROBE' + Date.now().toString(16).toUpperCase();
      const second = createConnection({ system: 'onprem', transport: 'rfc', config: connection.config ?? {
        url: means.serviceUrl, client: means.sapClient, authType: 'snc', sncPartnerName: means.sncPartnerName,
        sncQop: means.sncQop, sncLib: means.sncLib, sncMyName: means.sncMyName }, credential, logger });
      await second.connect();
      try {
        const listenUrl = `/sap/bc/adt/debugger/listeners?debuggingMode=user&requestUser=${user}`
          + `&terminalId=${ide}&ideId=${ide}&timeout=240&checkConflict=true&isNotifiedOnConflict=true`;
        const started = Date.now();
        const poll = connection.makeAdtRequest({ url: listenUrl, method: 'POST', timeout: 300000,
          headers: { Accept: 'application/xml' } })
          .then(r => ({ status: r.status }), e => ({ error: e && e.message, status: e && e.response && e.response.status }));
        await new Promise(r => setTimeout(r, 5000));
        await step('delete listener from second connection', async () => {
          const r = await second.makeAdtRequest({
            url: `/sap/bc/adt/debugger/listeners?debuggingMode=user&requestUser=${user}&terminalId=${ide}&ideId=${ide}&notifyConflict=true`,
            method: 'DELETE', timeout: 60000 });
          return { status: r.status };
        });
        const settled = await poll;
        report.steps.push({ name: 'listener poll ended', ok: true, ms: Date.now() - started, ...settled });
      } finally {
        await second.disconnect().catch(() => {});
      }
    }
```

  Add `--csrf`, `--listener` and `--user` to `args()` and to the usage comment and README. Run
  `node --check probe/snc/probe.js`. Commit:
  `git commit -m "probe: gate 3 (CSRF over RFC) and gate 4 (listener deletion over RFC)"`.

- [ ] **Step 2 (OWNER, Windows):** in `probe/snc`, with the SDK on `PATH` and `SAPNWRFC_HOME` set,
  `npm install`, then:

```
node probe.js --dir <dir> --destination <name> --program <PROG>
node probe.js --dir <dir> --destination <name> --program <Z_PROG> --lock --csrf
node probe.js --dir <dir> --destination <name> --program <PROG> --listener --user <ABAP user>
```

- [ ] **Step 3 (codex): record the results** in `design/auth-broker/GATES.md`, one section per
  gate: the command, the JSON report with nothing secret, the verdict, and for gate 3 the choice
  `A` (header present) or `B` (absent → SPEC §8.5 option B). Gate 4: whether the poll ended after
  the deletion, and how long it took. Commit.

- [ ] **Step 4 (STOP):** report to the owner. If gate 1 fails, or gate 4 shows the poll does not
  end, the owner decides before Task 7 starts.

### Task 2 (OWNER, STOP): Gate 2 — the extension host's runtime

**Files:**
- Create: `probe/host/package.json`, `probe/host/extension.js`, `probe/host/README.md`
- Modify: `design/auth-broker/GATES.md`

- [ ] **Step 1 (codex): write the host probe.**

`probe/host/package.json`:
```json
{
  "name": "vertex-host-probe",
  "version": "0.0.0",
  "private": true,
  "publisher": "vertex-probe",
  "engines": { "vscode": "^1.85.0" },
  "main": "./extension.js",
  "activationEvents": ["onCommand:vertexProbe.report"],
  "contributes": { "commands": [{ "command": "vertexProbe.report", "title": "VERTEX Probe: Report Host" }] },
  "dependencies": { "@mcp-abap-adt/connection": "^17.1.0", "@mcp-abap-adt/auth-broker": "^5.0.6" }
}
```

`probe/host/extension.js`:
```js
"use strict";
const vscode = require("vscode");
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("vertexProbe.report", async () => {
    const out = { vscode: vscode.version, node: process.versions.node, electron: process.versions.electron,
      napi: process.versions.napi, platform: process.platform, arch: process.arch,
      remoteName: vscode.env.remoteName || null };
    for (const name of ["@mcp-abap-adt/auth-broker", "@mcp-abap-adt/connection", "@mcp-abap-adt/sap-rfc-lite"]) {
      try { require(name); out[name] = "loaded"; } catch (e) { out[name] = "failed: " + e.message; }
    }
    const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(out, null, 2) });
    await vscode.window.showTextDocument(doc);
  }));
}
module.exports = { activate, deactivate() {} };
```

  `probe/host/README.md`: install with `SAPNWRFC_HOME` set, run
  `code --extensionDevelopmentPath=<abs path>/probe/host`, then the command "VERTEX Probe: Report
  Host". Commit.

- [ ] **Step 2 (OWNER):** run it in the VS Code release the owner uses, on Windows.
- [ ] **Step 3 (codex):** record the JSON in `GATES.md`, gate 2: Node ≥ 22? `sap-rfc-lite` loaded?
  The `engines.vscode` floor follows (the VS Code version reported, or the first release known to
  carry that Node). Commit.
- [ ] **Step 4 (STOP):** if Node < 22 or `sap-rfc-lite` fails to load, the owner decides before
  Task 7.

### Task 3: Dependencies and `auth/systems.js`

**Files:**
- Modify: `vscode/package.json` (dependencies), `vscode/package-lock.json`
- Create: `vscode/auth/systems.js`
- Test: `vscode/test/auth-systems.test.js`

**Interfaces — Produces:**
- `readSystem(entry) → { system } | { error: string }` — `system` has `name, url, client, user,
  authType ("basic"|"snc"), snc?, rfc?, webgui?, allowInsecureCertificate`.
- `canonicalOrigin(url) → string`
- `loginIdentity(system) → "vertex.auth.v1.<32 hex>"`
- `connectionKey(system) → string`

- [ ] **Step 1: add the dependencies.**

```
cd vscode
npm install --save-exact=false @mcp-abap-adt/auth-broker@^5.0.6 @mcp-abap-adt/auth-providers@^6.0.2 \
  @mcp-abap-adt/auth-stores@^5.0.1 @mcp-abap-adt/auth-errors@^2.2.1 @mcp-abap-adt/connection@^17.1.0
grep -n '"link": true\|"resolved": "file:' package-lock.json || echo clean
```
Expected: `clean`.

- [ ] **Step 2: write the failing test** `vscode/test/auth-systems.test.js`:

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readSystem, canonicalOrigin, loginIdentity, connectionKey } = require("../auth/systems");

const base = { name: "DEV", url: "https://Host.Example.com", client: "100", user: "dev" };

test("a system without authType is basic", () => {
  assert.equal(readSystem(base).system.authType, "basic");
});
test("url and user are required for every type", () => {
  assert.match(readSystem({ ...base, url: "" }).error, /url/);
  assert.match(readSystem({ ...base, user: "" }).error, /user/);
  assert.match(readSystem({ ...base, authType: "snc", user: "", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "00" } }).error, /user/);
});
test("a password in settings is refused", () => {
  assert.match(readSystem({ ...base, password: "x" }).error, /password/);
});
test("snc needs snc.partnerName and rfc.ashost/sysnr", () => {
  assert.match(readSystem({ ...base, authType: "snc" }).error, /snc\.partnerName/);
  assert.match(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X" } }).error, /rfc\.ashost/);
  assert.match(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "0" } }).error, /rfc\.sysnr/);
  assert.match(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X", qop: "5" }, rfc: { ashost: "h", sysnr: "00" } }).error, /snc\.qop/);
  assert.ok(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "00" } }).system);
});
test("an unknown authType is refused", () => {
  assert.match(readSystem({ ...base, authType: "jwt" }).error, /authType/);
});
test("canonicalOrigin lower-cases and makes the port explicit", () => {
  assert.equal(canonicalOrigin("HTTPS://Host.Example.com/sap/bc"), "https://host.example.com:443");
  assert.equal(canonicalOrigin("http://h:8000"), "http://h:8000");
});
test("login identity ignores the name and follows url, client, type, user", () => {
  const a = readSystem(base).system;
  assert.match(loginIdentity(a), /^vertex\.auth\.v1\.[0-9a-f]{32}$/);
  assert.equal(loginIdentity(a), loginIdentity(readSystem({ ...base, name: "OTHER" }).system));
  assert.equal(loginIdentity(a), loginIdentity(readSystem({ ...base, user: "DEV", url: "https://host.example.com:443" }).system));
  assert.notEqual(loginIdentity(a), loginIdentity(readSystem({ ...base, client: "200" }).system));
  assert.notEqual(loginIdentity(a), loginIdentity(readSystem({ ...base, user: "other" }).system));
});
test("connection key changes with snc, rfc and certificate policy", () => {
  const snc = { ...base, authType: "snc", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "00" } };
  const k = connectionKey(readSystem(snc).system);
  assert.notEqual(k, connectionKey(readSystem({ ...snc, rfc: { ashost: "h2", sysnr: "00" } }).system));
  assert.notEqual(k, connectionKey(readSystem({ ...snc, snc: { partnerName: "p:CN=Y" } }).system));
  assert.notEqual(connectionKey(readSystem(base).system), connectionKey(readSystem({ ...base, allowInsecureCertificate: true }).system));
});
```

- [ ] **Step 3: run it, expect failure.** `npm test -- --test-name-pattern="" test/auth-systems.test.js`
  → fails with `Cannot find module '../auth/systems'`.

- [ ] **Step 4: implement** `vscode/auth/systems.js`:

```js
"use strict";
const crypto = require("crypto");
const TYPES = ["basic", "snc"];
const QOPS = ["1", "2", "3", "8", "9"];

function canonicalOrigin(url) {
  const u = new URL(url);
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  return u.protocol.toLowerCase() + "//" + u.hostname.toLowerCase() + (port ? ":" + port : "");
}

/** One vertex.systems entry → a validated system, or a sentence naming what is wrong. */
function readSystem(entry) {
  const e = entry || {};
  const name = String(e.name || "").trim() || "(unnamed)";
  if (Object.prototype.hasOwnProperty.call(e, "password")) {
    return { error: "System " + name + " has a password in settings. Remove it: VERTEX keeps passwords in the OS credential store and asks for them." };
  }
  const authType = e.authType === undefined || e.authType === "" ? "basic" : e.authType;
  if (!TYPES.includes(authType)) return { error: "System " + name + " has authType " + JSON.stringify(e.authType) + "; this VERTEX knows " + TYPES.join(" and ") + "." };
  const gaps = [];
  if (!e.url) gaps.push("url");
  if (!e.user) gaps.push("user");
  if (gaps.length) return { error: "System " + name + " has no " + gaps.join(" and ") + "." };
  try { canonicalOrigin(e.url); } catch (_) { return { error: "The url of " + name + " is not a valid one: " + e.url }; }
  const system = { name, url: e.url, client: e.client || "", user: e.user, authType,
    webgui: e.webgui, allowInsecureCertificate: e.allowInsecureCertificate === true };
  if (authType === "snc") {
    const snc = e.snc || {}, rfc = e.rfc || {};
    if (!snc.partnerName) return { error: "System " + name + " is snc and has no snc.partnerName (the system's SNC name, e.g. p:CN=SID, O=ACME)." };
    if (snc.qop !== undefined && !QOPS.includes(String(snc.qop))) return { error: "System " + name + " has snc.qop " + snc.qop + "; use 1, 2, 3, 8 or 9." };
    if (!rfc.ashost) return { error: "System " + name + " is snc and has no rfc.ashost (the application server host)." };
    if (!/^\d\d$/.test(String(rfc.sysnr || ""))) return { error: "System " + name + " needs rfc.sysnr as two digits, e.g. 00." };
    system.snc = { partnerName: snc.partnerName, qop: snc.qop, library: snc.library, myName: snc.myName };
    system.rfc = { ashost: rfc.ashost, sysnr: String(rfc.sysnr), saprouter: rfc.saprouter };
  }
  return { system };
}

function loginIdentity(system) {
  const parts = [canonicalOrigin(system.url), system.client || "", system.authType, String(system.user).toUpperCase()];
  return "vertex.auth.v1." + crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function connectionKey(system) {
  return JSON.stringify([system.name, canonicalOrigin(system.url), system.client || "", String(system.user).toUpperCase(),
    system.authType, system.allowInsecureCertificate === true, system.snc || null, system.rfc || null]);
}

module.exports = { readSystem, canonicalOrigin, loginIdentity, connectionKey };
```

- [ ] **Step 5: run, expect pass.** `npm test` → all green.
- [ ] **Step 6: commit** `git add vscode/package.json vscode/package-lock.json vscode/auth/systems.js vscode/test/auth-systems.test.js && git commit -m "auth: dependencies, system reading, login identity, connection key"`.

### Task 4: Stores and migration

**Files:**
- Create: `vscode/auth/session-secret.js`, `vscode/auth/stores.js`, `vscode/auth/migrate.js`
- Test: `vscode/test/auth-stores.test.js`, `vscode/test/auth-migrate.test.js`

**Interfaces:**
- Consumes: `readSystem`, `loginIdentity` (Task 3).
- Produces:
  - `applySecret(current, write) → next` (throws on token + cookies together)
  - `createStores({ secrets, currentSystems }) → { serviceKeyStore, sessionStore, means }` where
    `secrets` is `{ get(key), store(key, value), delete(key) }` (VS Code `SecretStorage`),
    `currentSystems()` returns the validated systems from settings, and
    `means = { password(identity), setPassword(identity, value), forget(identity) }`.
  - `migrateOnce({ secrets, globalState, currentSystems }) → Promise<{ migrated: string[], kept: string[] }>`
  - `legacyPasswordFor({ secrets, currentSystems }, system) → Promise<string|undefined>` (used on
    the first need of a system whose legacy key could not be migrated: returns undefined when the
    name is ambiguous) and `retireLegacy({ secrets, currentSystems, hasLogin }, name)`.

- [ ] **Step 1: write the failing tests** `vscode/test/auth-stores.test.js`:

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { applySecret } = require("../auth/session-secret");
const { createStores } = require("../auth/stores");
const { readSystem, loginIdentity } = require("../auth/systems");

function memorySecrets() { const m = new Map(); return { m,
  async get(k) { return m.get(k); }, async store(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; }
const dev = readSystem({ name: "DEV", url: "https://h", client: "100", user: "dev" }).system;
const snc = readSystem({ name: "S", url: "https://s", user: "u", authType: "snc",
  snc: { partnerName: "p:CN=S", qop: "9" }, rfc: { ashost: "s", sysnr: "00" } }).system;

test("applySecret: a credential replaces the other kind and its expiry", () => {
  assert.deepEqual(applySecret({ sessionCookies: "c", expiresAt: 5 }, { authorizationToken: "t" }), { authorizationToken: "t" });
  assert.deepEqual(applySecret({ authorizationToken: "t", expiresAt: 5 }, { sessionCookies: "c", expiresAt: 9 }), { sessionCookies: "c", expiresAt: 9 });
});
test("applySecret: '' clears its kind and expiry; clearing the kind not held changes nothing", () => {
  assert.deepEqual(applySecret({ authorizationToken: "t", expiresAt: 5 }, { authorizationToken: "" }), {});
  assert.deepEqual(applySecret({ authorizationToken: "t", expiresAt: 5 }, { sessionCookies: "" }), { authorizationToken: "t", expiresAt: 5 });
});
test("applySecret: token and cookies together is refused", () => {
  assert.throws(() => applySecret({}, { authorizationToken: "t", sessionCookies: "c" }), /one/);
});
test("applySecret: expiresAt alone, refreshToken rules", () => {
  assert.deepEqual(applySecret({ authorizationToken: "t" }, { expiresAt: 7 }), { authorizationToken: "t", expiresAt: 7 });
  assert.deepEqual(applySecret({ refreshToken: "r" }, {}), { refreshToken: "r" });
  assert.deepEqual(applySecret({ refreshToken: "r" }, { refreshToken: "" }), {});
});
test("applySecret: bindings go with the credential", () => {
  assert.deepEqual(applySecret({ authorizationToken: "t", issuedFor: "a", issuedBy: "b" }, { authorizationToken: "u", issuedFor: "x" }),
    { authorizationToken: "u", issuedFor: "x" });
  assert.deepEqual(applySecret({ authorizationToken: "t", issuedFor: "a" }, { issuedBy: "b" }), { authorizationToken: "t", issuedFor: "a", issuedBy: "b" });
  assert.deepEqual(applySecret({ authorizationToken: "t", issuedFor: "a" }, { authorizationToken: "" }), {});
});
test("service key store composes settings and secret means; null for a system not in settings", async () => {
  const secrets = memorySecrets();
  const { serviceKeyStore, means } = createStores({ secrets, currentSystems: () => [dev, snc] });
  await means.setPassword(loginIdentity(dev), "pw");
  assert.deepEqual(await serviceKeyStore.getConnectionConfig(loginIdentity(dev)),
    { serviceUrl: "https://h", sapClient: "100", authType: "basic", username: "dev", password: "pw" });
  assert.deepEqual(await serviceKeyStore.getConnectionConfig(loginIdentity(snc)),
    { serviceUrl: "https://s", sapClient: "", authType: "snc", sncPartnerName: "p:CN=S", sncQop: "9" });
  assert.equal(await serviceKeyStore.getConnectionConfig("vertex.auth.v1.unknown"), null);
  assert.equal(await serviceKeyStore.getAuthorizationConfig(loginIdentity(dev)), null);
  assert.deepEqual(await serviceKeyStore.getServiceKey(loginIdentity(dev)), await serviceKeyStore.getConnectionConfig(loginIdentity(dev)));
});
test("session store: save/load/delete, authorization config null, set refused, malformed refused", async () => {
  const secrets = memorySecrets();
  const { sessionStore } = createStores({ secrets, currentSystems: () => [dev] });
  const id = loginIdentity(dev);
  assert.equal(await sessionStore.loadSession(id), null);
  await sessionStore.saveSession(id, { authorizationToken: "t", expiresAt: 1, refreshToken: "r", issuedFor: "f" });
  assert.deepEqual(await sessionStore.loadSession(id), { authorizationToken: "t", expiresAt: 1, refreshToken: "r", issuedFor: "f" });
  assert.deepEqual(await sessionStore.getConnectionConfig(id), { authorizationToken: "t", expiresAt: 1, issuedFor: "f" });
  assert.equal(await sessionStore.getAuthorizationConfig(id), null);
  await assert.rejects(sessionStore.setAuthorizationConfig(id, { uaaUrl: "u", uaaClientId: "c", uaaClientSecret: "s" }), /session store/);
  await sessionStore.deleteSession(id);
  assert.equal(await sessionStore.loadSession(id), null);
  secrets.m.set(id + ".session", "{not json");
  await assert.rejects(sessionStore.loadSession(id), /not this store's format/);
});
test("means: forget removes means and session", async () => {
  const secrets = memorySecrets();
  const { means, sessionStore } = createStores({ secrets, currentSystems: () => [dev] });
  const id = loginIdentity(dev);
  await means.setPassword(id, "pw"); await sessionStore.saveSession(id, { refreshToken: "r" });
  await means.forget(id);
  assert.equal(await means.password(id), undefined);
  assert.equal(await sessionStore.loadSession(id), null);
});
```

`vscode/test/auth-migrate.test.js`:

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { migrateOnce, legacyPasswordFor, retireLegacy } = require("../auth/migrate");
const { createStores } = require("../auth/stores");
const { readSystem, loginIdentity } = require("../auth/systems");
function memorySecrets(init) { const m = new Map(Object.entries(init || {})); return { m,
  async get(k) { return m.get(k); }, async store(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; }
function memoryState() { const m = new Map(); return { get: k => m.get(k), update: async (k, v) => { m.set(k, v); } }; }
const sys = o => readSystem({ url: "https://h", user: "u", ...o }).system;

test("a unique name migrates, is read back, and the legacy key goes", async () => {
  const secrets = memorySecrets({ "vertex.password.DEV": "pw" });
  const dev = sys({ name: "DEV" });
  const r = await migrateOnce({ secrets, globalState: memoryState(), currentSystems: () => [dev] });
  assert.deepEqual(r.migrated, ["DEV"]);
  assert.equal(await createStores({ secrets, currentSystems: () => [dev] }).means.password(loginIdentity(dev)), "pw");
  assert.equal(secrets.m.has("vertex.password.DEV"), false);
});
test("migration runs once", async () => {
  const state = memoryState();
  const secrets = memorySecrets({ "vertex.password.DEV": "pw" });
  await migrateOnce({ secrets, globalState: state, currentSystems: () => [] });
  secrets.m.set("vertex.password.DEV", "pw");
  const r = await migrateOnce({ secrets, globalState: state, currentSystems: () => [sys({ name: "DEV" })] });
  assert.deepEqual(r, { migrated: [], kept: [] });
});
test("a duplicate name keeps the legacy key and gives no password", async () => {
  const a = sys({ name: "DEV" }), b = sys({ name: "DEV", client: "200" });
  const secrets = memorySecrets({ "vertex.password.DEV": "pw" });
  const r = await migrateOnce({ secrets, globalState: memoryState(), currentSystems: () => [a, b] });
  assert.deepEqual(r.kept, ["DEV"]);
  assert.equal(secrets.m.get("vertex.password.DEV"), "pw");
  assert.equal(await legacyPasswordFor({ secrets, currentSystems: () => [a, b] }, a), undefined);
});
test("an snc system of that name does not take the password", async () => {
  const s = readSystem({ name: "DEV", url: "https://h", user: "u", authType: "snc", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "00" } }).system;
  const secrets = memorySecrets({ "vertex.password.DEV": "pw" });
  const r = await migrateOnce({ secrets, globalState: memoryState(), currentSystems: () => [s] });
  assert.deepEqual(r.kept, ["DEV"]);
});
test("the legacy key is retired once every system of that name has its own login", async () => {
  const a = sys({ name: "DEV" }), b = sys({ name: "DEV", client: "200" });
  const secrets = memorySecrets({ "vertex.password.DEV": "pw" });
  const has = new Set([loginIdentity(a)]);
  await retireLegacy({ secrets, currentSystems: () => [a, b], hasLogin: async id => has.has(id) }, "DEV");
  assert.equal(secrets.m.has("vertex.password.DEV"), true);
  has.add(loginIdentity(b));
  await retireLegacy({ secrets, currentSystems: () => [a, b], hasLogin: async id => has.has(id) }, "DEV");
  assert.equal(secrets.m.has("vertex.password.DEV"), false);
});
```

  Note: the legacy key's names are found through `globalState.get("vertex.auth.legacyNames")`
  if present, else by asking `secrets.get("vertex.password." + name)` for each current system
  name — SecretStorage cannot list keys. Names of systems no longer in settings cannot be
  found and are left.

- [ ] **Step 2: run, expect failure** (`Cannot find module`).

- [ ] **Step 3: implement** `vscode/auth/session-secret.js` (port of
  `@mcp-abap-adt/auth-stores` `src/session/sessionSecret.ts` `applySecret`, which that package
  does not export; same rules, SPEC §5.2):

```js
"use strict";
const BINDING = ["issuedFor", "issuedBy"];
function applySecret(current, write) {
  if (write.authorizationToken && write.sessionCookies) throw new Error("a write carries a token and cookies; a session holds one");
  const next = { ...current };
  const credentialGiven = write.authorizationToken !== undefined || write.sessionCookies !== undefined;
  if (credentialGiven) {
    if (write.authorizationToken) { next.authorizationToken = write.authorizationToken; delete next.sessionCookies; delete next.expiresAt; }
    else if (write.sessionCookies) { next.sessionCookies = write.sessionCookies; delete next.authorizationToken; delete next.expiresAt; }
    else {
      if (write.authorizationToken !== undefined) delete next.authorizationToken;
      if (write.sessionCookies !== undefined) delete next.sessionCookies;
      if (!next.authorizationToken && !next.sessionCookies) delete next.expiresAt;
    }
    if (write.expiresAt !== undefined && (next.authorizationToken || next.sessionCookies)) next.expiresAt = write.expiresAt;
  } else if (write.expiresAt !== undefined) { next.expiresAt = write.expiresAt; }
  if (write.refreshToken !== undefined) { if (write.refreshToken) next.refreshToken = write.refreshToken; else delete next.refreshToken; }
  const newCredential = !!(write.authorizationToken || write.sessionCookies);
  for (const f of BINDING) {
    if (newCredential || write[f] !== undefined) { if (write[f]) next[f] = write[f]; else delete next[f]; }
  }
  if (!next.authorizationToken && !next.sessionCookies) for (const f of BINDING) delete next[f];
  return next;
}
module.exports = { applySecret };
```

  Before committing, diff the rules once more against
  `/home/okyslytsia/prj/mcp-abap-adt-auth-stores/src/session/sessionSecret.ts` (or the published
  `node_modules/@mcp-abap-adt/auth-stores/dist/session/sessionSecret.js`) and align any difference
  in favour of the reference; add a test for it.

  `vscode/auth/stores.js`:

```js
"use strict";
const { loginIdentity } = require("./systems");
const { applySecret } = require("./session-secret");
const FIELDS = ["authorizationToken", "sessionCookies", "expiresAt", "refreshToken", "issuedFor", "issuedBy"];

function createStores({ secrets, currentSystems }) {
  const chains = new Map();
  const serial = (id, work) => { const run = (chains.get(id) || Promise.resolve()).then(work, work); chains.set(id, run.catch(() => {})); return run; };
  const systemOf = id => currentSystems().find(s => loginIdentity(s) === id);
  async function readJson(key, what) {
    const raw = await secrets.get(key);
    if (raw === undefined || raw === null || raw === "") return null;
    let v; try { v = JSON.parse(raw); } catch (_) { v = undefined; }
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !what.includes(k))) {
      throw new Error("The stored " + key.split(".").pop() + " record is not this store's format; it was not used.");
    }
    return v;
  }
  async function connectionConfig(id) {
    const s = systemOf(id); if (!s) return null;
    const out = { serviceUrl: s.url, sapClient: s.client || "", authType: s.authType };
    if (s.authType === "basic") {
      const m = await readJson(id + ".means", ["password"]);
      out.username = s.user; if (m && m.password) out.password = m.password;
    } else if (s.authType === "snc") {
      out.sncPartnerName = s.snc.partnerName;
      if (s.snc.qop) out.sncQop = String(s.snc.qop);
      if (s.snc.library) out.sncLib = s.snc.library;
      if (s.snc.myName) out.sncMyName = s.snc.myName;
    }
    return out;
  }
  const serviceKeyStore = {
    getConnectionConfig: connectionConfig,
    getServiceKey: connectionConfig,
    async getAuthorizationConfig() { return null; },
  };
  const sessionStore = {
    async loadSession(id) { return readJson(id + ".session", FIELDS); },
    saveSession(id, config) { return serial(id, async () => {
      const current = (await readJson(id + ".session", FIELDS)) || {};
      const write = {}; for (const f of FIELDS) if (config && config[f] !== undefined) write[f] = config[f];
      const next = applySecret(current, write);
      if (Object.keys(next).length) await secrets.store(id + ".session", JSON.stringify(next));
      else await secrets.delete(id + ".session");
    }); },
    deleteSession(id) { return serial(id, () => secrets.delete(id + ".session")); },
    async getConnectionConfig(id) {
      const s = await readJson(id + ".session", FIELDS); if (!s) return null;
      const out = {}; for (const f of ["authorizationToken", "sessionCookies", "expiresAt", "issuedFor", "issuedBy"]) if (s[f] !== undefined) out[f] = s[f];
      return out;
    },
    setConnectionConfig(id, config) { return sessionStore.saveSession(id, config); },
    async getAuthorizationConfig() { return null; },
    async setAuthorizationConfig() { throw new Error("The session store holds no client; the refresh token is written with saveSession."); },
  };
  const means = {
    async password(id) { const m = await readJson(id + ".means", ["password"]); return m ? m.password : undefined; },
    setPassword(id, value) { return serial(id, () => secrets.store(id + ".means", JSON.stringify({ password: value }))); },
    forget(id) { return serial(id, async () => { await secrets.delete(id + ".means"); await secrets.delete(id + ".session"); }); },
  };
  return { serviceKeyStore, sessionStore, means };
}
module.exports = { createStores };
```

  `vscode/auth/migrate.js`:

```js
"use strict";
const { loginIdentity } = require("./systems");
const { createStores } = require("./stores");
const DONE = "vertex.auth.migrated";
const legacyKey = name => "vertex.password." + name;

async function migrateOnce({ secrets, globalState, currentSystems }) {
  const out = { migrated: [], kept: [] };
  if (globalState.get(DONE) === 1) return out;
  const systems = currentSystems();
  const { means } = createStores({ secrets, currentSystems });
  for (const name of [...new Set(systems.map(s => s.name))]) {
    const legacy = await secrets.get(legacyKey(name));
    if (!legacy) continue;
    const same = systems.filter(s => s.name === name);
    if (same.length === 1 && same[0].authType === "basic") {
      const id = loginIdentity(same[0]);
      if (!(await means.password(id))) await means.setPassword(id, legacy);
      // Read back before the legacy key goes: a write that did not land must not lose the password.
      if (await means.password(id)) { await secrets.delete(legacyKey(name)); out.migrated.push(name); }
    } else { out.kept.push(name); }
  }
  await globalState.update(DONE, 1);
  return out;
}

async function legacyPasswordFor({ secrets, currentSystems }, system) {
  const same = currentSystems().filter(s => s.name === system.name);
  if (same.length !== 1 || system.authType !== "basic") return undefined;
  return (await secrets.get(legacyKey(system.name))) || undefined;
}

async function retireLegacy({ secrets, currentSystems, hasLogin }, name) {
  const same = currentSystems().filter(s => s.name === name && s.authType === "basic");
  for (const s of same) if (!(await hasLogin(loginIdentity(s)))) return;
  await secrets.delete(legacyKey(name));
}
module.exports = { migrateOnce, legacyPasswordFor, retireLegacy };
```

- [ ] **Step 4: run, expect pass.** `npm test`.
- [ ] **Step 5: commit** `git commit -m "auth: SecretStorage stores per the broker contracts, one-time Basic migration"`.

### Task 5: Broker and HTTP wire

**Files:**
- Create: `vscode/auth/broker.js`, `vscode/auth/http-wire.js`
- Test: `vscode/test/auth-http-wire.test.js`

**Interfaces:**
- Consumes: `createStores` (Task 4), `loginIdentity` (Task 3).
- Produces:
  - `createBroker({ serviceKeyStore, sessionStore, logger }) → { providerFor(system, signal) }`
  - `createHttpWire(system, { providerFor, onRefusal }) → { request(options), dispose() }` —
    `onRefusal(system, refusal)` is called when a provider's Oops ends a request (§7 step 5, or
    `prepare` / `authorize` Oops); the wire keeps no secret.

- [ ] **Step 1: write the failing test** `vscode/test/auth-http-wire.test.js`:

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http");
const { createHttpWire } = require("../auth/http-wire");
const { readSystem } = require("../auth/systems");
const { authError } = require("@mcp-abap-adt/auth-errors");

function server(handler) {
  return new Promise(resolve => { const seen = []; const s = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, seen.length); });
  }); s.listen(0, "127.0.0.1", () => resolve({ s, seen, url: "http://127.0.0.1:" + s.address().port })); });
}
const OK = { ok: true };
function provider({ rejected = () => ({ ok: false, refusal: authError["logon-target"]({ wire: "http", refused: "logon-parameters" }) }) } = {}) {
  const calls = [];
  return { calls, kind: "fake",
    async prepare() { calls.push("prepare"); return OK; },
    async establish(t) { calls.push("establish"); t.logonParameters({ user: "x" }); return OK; },
    async authorize(t) { calls.push("authorize"); t.header("Authorization", "Basic Zm9vOmJhcg=="); t.cookies("A=1"); return OK; },
    async rejected(r) { calls.push("rejected:" + r.status); return rejected(); } };
}

test("authorize writes the header and merges cookies; options.auth is dropped", async () => {
  const { s, seen, url } = await server((req, res) => res.end("ok"));
  const p = provider();
  const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, { providerFor: async () => p, onRefusal() {} });
  const r = await wire.request({ url: "/sap/bc/adt/discovery", headers: { Cookie: "A=lib; B=2" }, auth: { username: "u", password: "-" } });
  assert.equal(r.status, 200);
  assert.equal(seen[0].headers.authorization, "Basic Zm9vOmJhcg==");
  assert.match(seen[0].headers.cookie, /A=lib/); assert.match(seen[0].headers.cookie, /B=2/);
  assert.deepEqual(p.calls.slice(0, 2), ["prepare", "establish"]);
  wire.dispose(); s.close();
});
test("a 401 with an Oops from rejected is returned once, no retry, refusal reported", async () => {
  const { s, seen, url } = await server((req, res) => { res.statusCode = 401; res.end(""); });
  const refusals = [];
  const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, { providerFor: async () => provider(), onRefusal: (_, r) => refusals.push(r) });
  const r = await wire.request({ url: "/x" });
  assert.equal(r.status, 401); assert.equal(seen.length, 1); assert.equal(refusals.length, 1);
  wire.dispose(); s.close();
});
test("a 401 with Ok from rejected is retried exactly once", async () => {
  const { s, seen, url } = await server((req, res) => { res.statusCode = 401; res.end(""); });
  const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, { providerFor: async () => provider({ rejected: () => OK }), onRefusal() {} });
  const r = await wire.request({ url: "/x" });
  assert.equal(r.status, 401); assert.equal(seen.length, 2);
  wire.dispose(); s.close();
});
test("an authorize Oops sends nothing", async () => {
  const { s, seen, url } = await server((req, res) => res.end("ok"));
  const p = provider(); p.authorize = async () => ({ ok: false, refusal: authError["logon-target"]({ wire: "http", refused: "tls-material" }) });
  const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, { providerFor: async () => p, onRefusal() {} });
  await assert.rejects(wire.request({ url: "/x" }));
  assert.equal(seen.length, 0);
  wire.dispose(); s.close();
});
test("a new provider instance is prepared and established once", async () => {
  const { s, url } = await server((req, res) => res.end("ok"));
  let current = provider(); const first = current;
  const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, { providerFor: async () => current, onRefusal() {} });
  await wire.request({ url: "/a" }); await wire.request({ url: "/b" });
  current = provider(); await wire.request({ url: "/c" });
  assert.equal(first.calls.filter(c => c === "prepare").length, 1);
  assert.equal(current.calls.filter(c => c === "prepare").length, 1);
  wire.dispose(); s.close();
});
test("the origin guard refuses another host", async () => {
  const wire = createHttpWire(readSystem({ name: "D", url: "http://127.0.0.1:9", user: "u" }).system, { providerFor: async () => provider(), onRefusal() {} });
  await assert.rejects(wire.request({ url: "http://evil.example/x" }), /outside configured SAP system/);
  wire.dispose();
});

// SPEC §7 table, with the real abap-adt-api.
const { ADTClient } = require("abap-adt-api");
async function refusedCount({ body, stateful, loggedIn }) {
  const { s, seen, url } = await server((req, res, n) => {
    if (loggedIn && n === 1) { res.setHeader("x-csrf-token", "TOKEN"); res.end("ok"); return; }
    res.statusCode = 401; res.end(body);
  });
  const system = readSystem({ name: "D", url, user: "u" }).system;
  const client = new ADTClient(url, "u", "-", "", "EN");
  client.httpClient.httpclient = createHttpWire(system, { providerFor: async () => provider(), onRefusal() {} });
  if (loggedIn) await client.login();
  if (stateful) client.stateful = "stateful";
  const before = seen.length;
  await client.httpClient.request("/sap/bc/adt/repository/nodestructure", {}).catch(() => {});
  s.close();
  return seen.length - before;
}
test("§7: not yet logged in → 1 send", async () => assert.equal(await refusedCount({ body: "", loggedIn: false }), 1));
test("§7: logged in, stateful → 1 send", async () => assert.equal(await refusedCount({ body: "CSRF", stateful: true, loggedIn: true }), 1));
test("§7: logged in, stateless, no CSRF in body → 1 send", async () => assert.equal(await refusedCount({ body: "nope", loggedIn: true }), 1));
test("§7: logged in, stateless, CSRF in body → 2 sends", async () => assert.equal(await refusedCount({ body: "CSRF token required", loggedIn: true }), 2));
```

- [ ] **Step 2: run, expect failure.**

- [ ] **Step 3: implement** `vscode/auth/broker.js`:

```js
"use strict";
const { AuthBroker } = require("@mcp-abap-adt/auth-broker");
const { loginIdentity } = require("./systems");
function createBroker({ serviceKeyStore, sessionStore, logger }) {
  const broker = new AuthBroker({ sessionStore, serviceKeyStore }, logger);
  return { providerFor: (system, signal) => broker.getProvider(loginIdentity(system), signal ? { signal } : undefined) };
}
module.exports = { createBroker };
```

  `vscode/auth/http-wire.js`:

```js
"use strict";
const { authError } = require("@mcp-abap-adt/auth-errors");

function refusedError(refusal) {
  const e = new Error(refusal.reason + (refusal.hint ? " " + refusal.hint : ""));
  e.refusal = refusal; return e;
}
const httpLogonTarget = {
  logonParameters: () => ({ ok: false, refusal: authError["logon-target"]({ wire: "http", refused: "logon-parameters" }) }),
  tlsMaterial: () => ({ ok: false, refusal: authError["logon-target"]({ wire: "http", refused: "tls-material" }) }),
};

function createHttpWire(system, { providerFor, onRefusal }) {
  const base = new URL(system.url);
  const secure = base.protocol === "https:";
  if (!secure && base.protocol !== "http:") throw new Error("Unsupported SAP URL protocol");
  const http = require(secure ? "https" : "http");
  const rejectUnauthorized = system.allowInsecureCertificate !== true;
  const agent = new http.Agent(secure ? { rejectUnauthorized, keepAlive: true } : { keepAlive: true });
  const ready = new WeakSet();

  async function provider() {
    const p = await providerFor(system);
    if (!ready.has(p)) {
      const prepared = await p.prepare();
      if (!prepared.ok) { onRefusal(system, prepared.refusal); throw refusedError(prepared.refusal); }
      const established = await p.establish(httpLogonTarget);
      if (!established.ok) { onRefusal(system, established.refusal); throw refusedError(established.refusal); }
      ready.add(p);
    }
    return p;
  }

  function send(options, headers) {
    return new Promise((resolve, reject) => {
      const url = new URL(options.url, base);
      if (url.origin !== base.origin) { reject(new Error("ADT request outside configured SAP system")); return; }
      for (const [k, v] of Object.entries(options.qs || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      const body = options.body;
      if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
      const req = http.request(url, { method: options.method || "GET", headers, agent, rejectUnauthorized }, res => {
        let text = ""; res.setEncoding("utf8");
        res.on("data", c => { text += c; }); res.on("error", reject);
        res.on("end", () => resolve({ body: text, status: res.statusCode, statusText: res.statusMessage, headers: res.headers }));
      });
      req.setTimeout(options.timeout || 60000, () => req.destroy(new Error("SAP request timed out")));
      req.on("error", reject); req.end(body);
    });
  }

  async function attempt(options) {
    const p = await provider();
    const headers = { ...options.headers };
    const extraCookies = [];
    const outcome = await p.authorize({ header(name, value) { headers[name] = value; }, cookies(value) { extraCookies.push(value); } });
    if (!outcome.ok) { onRefusal(system, outcome.refusal); throw refusedError(outcome.refusal); }
    if (extraCookies.length) headers.Cookie = mergeCookies(extraCookies.join("; "), headers.Cookie || headers.cookie || "");
    return { p, response: await send(options, headers) };
  }

  return {
    async request(options) {
      const first = await attempt(options);
      if (first.response.status !== 401) return first.response;
      const verdict = await first.p.rejected({ at: "request", status: 401, error: first.response });
      if (!verdict.ok) { onRefusal(system, verdict.refusal); return first.response; }
      const second = await attempt(options);
      return second.response;
    },
    dispose() { agent.destroy(); },
  };
}

/** The provider's cookies under the library's: the library's session cookies win on a name clash. */
function mergeCookies(fromProvider, fromLibrary) {
  const jar = new Map();
  for (const part of String(fromProvider).split(";")) { const t = part.trim(); if (t) jar.set(t.split("=")[0], t); }
  for (const part of String(fromLibrary).split(";")) { const t = part.trim(); if (t) jar.set(t.split("=")[0], t); }
  return [...jar.values()].join("; ");
}
module.exports = { createHttpWire, mergeCookies };
```

- [ ] **Step 4: run, expect pass.** `npm test`. If a §7 count test disagrees, do not change the
  expectation: stop and report it with the trace — SPEC §7 is wrong or the wire is.
- [ ] **Step 5: commit** `git commit -m "auth: broker and HTTP wire driving the provider's moments"`.

### Task 6: Host refusals

**Files:**
- Create: `vscode/auth/hosts.js`
- Test: `vscode/test/auth-hosts.test.js`

**Interfaces — Produces:** `refusalFor(system, { platform, remoteName, resolve }) → string|null`
(defaults: `process.platform`, `vscode.env.remoteName` passed by the caller, `require.resolve`).

- [ ] **Step 1: failing test:**

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { refusalFor } = require("../auth/hosts");
const snc = { name: "S", authType: "snc" }, basic = { name: "B", authType: "basic" };
const ok = () => "/x/sap-rfc-lite";
const missing = () => { throw new Error("Cannot find module"); };
test("basic is never refused", () => {
  assert.equal(refusalFor(basic, { platform: "linux", remoteName: "wsl", resolve: missing }), null);
});
test("snc on a remote host", () => {
  assert.match(refusalFor(snc, { platform: "win32", remoteName: "ssh-remote", resolve: ok }), /remote host \(ssh-remote\)/);
});
test("snc on linux", () => {
  assert.match(refusalFor(snc, { platform: "linux", remoteName: undefined, resolve: ok }), /Windows and macOS only/);
});
test("snc without the native module in this package", () => {
  assert.match(refusalFor(snc, { platform: "win32", remoteName: undefined, resolve: missing }), /no SNC support/);
});
test("snc allowed on darwin and win32", () => {
  assert.equal(refusalFor(snc, { platform: "darwin", remoteName: undefined, resolve: ok }), null);
  assert.equal(refusalFor(snc, { platform: "win32", remoteName: undefined, resolve: ok }), null);
});
```

- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement** `vscode/auth/hosts.js`:

```js
"use strict";
function refusalFor(system, { platform = process.platform, remoteName, resolve = require.resolve } = {}) {
  if (system.authType !== "snc") return null;
  if (remoteName) return "SNC needs the local VS Code on Windows or macOS; this window runs on a remote host (" + remoteName + ").";
  if (platform !== "win32" && platform !== "darwin") return "SNC runs on Windows and macOS only.";
  try { resolve("@mcp-abap-adt/sap-rfc-lite"); }
  catch (_) { return "This VERTEX package has no SNC support; install the Windows or macOS package of VERTEX."; }
  return null;
}
module.exports = { refusalFor };
```

  Note: `sap-rfc-lite` is nested under `@mcp-abap-adt/connection/node_modules` when npm does not
  hoist it. `resolve` must be called as
  `require.resolve("@mcp-abap-adt/sap-rfc-lite", { paths: [path.dirname(require.resolve("@mcp-abap-adt/connection"))] })`
  by the caller in `clients.js` (Task 8); the default here is for tests.
- [ ] **Step 4: run, expect pass.** **Step 5: commit** `git commit -m "auth: host refusals for snc"`.

### Task 7: RFC wire (depends on Tasks 1 and 2 — do not start before both are recorded)

**Files:**
- Create: `vscode/auth/rfc-wire.js`
- Test: `vscode/test/auth-rfc-wire.test.js`

**Interfaces:**
- Consumes: `providerFor` (Task 5); gate 3's choice from `GATES.md`.
- Produces: `createRfcWire(system, { providerFor, logger, connector }) → { request(options), dispose() }`.
  `connector` is a factory for tests: `(system, provider, open, logger) => connection`; the default
  builds `new AdtOnPremConnector(config, provider, new RfcTransport(open, logger), logger)`.

- [ ] **Step 1: failing test** `vscode/test/auth-rfc-wire.test.js`:

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRfcWire } = require("../auth/rfc-wire");
const { readSystem } = require("../auth/systems");
const system = readSystem({ name: "S", url: "https://s", user: "u", authType: "snc", snc: { partnerName: "p:CN=S" }, rfc: { ashost: "s", sysnr: "00" } }).system;

function fakeFactory(log) {
  let n = 0;
  return () => {
    const id = ++n; let mode = "stateless"; let spent = false;
    const c = {
      id, async connect() { if (spent) throw new Error("spent"); log.push(["connect", id]); },
      setSessionType(m) { mode = m; },
      async makeAdtRequest(o) {
        log.push(["req", id, mode, o.method, o.url, Object.keys(o.headers || {}).map(h => h.toLowerCase()).sort().join(",")]);
        await new Promise(r => setTimeout(r, 5));
        if (o.url.includes("fail")) { const e = new Error("SAP said no"); e.response = { status: 400, statusText: "Bad", headers: {}, data: "<x/>" }; throw e; }
        return { status: 200, statusText: "OK", headers: {}, data: "body" + id };
      },
      async disconnect() { spent = true; log.push(["disconnect", id]); },
    };
    return c;
  };
}
const wireWith = log => createRfcWire(system, { providerFor: async () => ({}), logger: null, connector: fakeFactory(log) });

test("mapping: default GET, headers stripped, body/params mapped, response mapped", async () => {
  const log = []; const w = wireWith(log);
  const r = await w.request({ url: "/sap/bc/adt/discovery", headers: { Authorization: "x", Cookie: "c", "x-csrf-token": "fetch", "X-sap-adt-sessiontype": "stateless", Accept: "a" } });
  assert.equal(r.status, 200); assert.equal(r.body, "body1");
  const req = log.find(l => l[0] === "req");
  assert.equal(req[3], "GET"); assert.equal(req[5], "accept");
});
test("session mode: stateful, keep, stateless", async () => {
  const log = []; const w = wireWith(log);
  await w.request({ url: "/a", headers: { "X-sap-adt-sessiontype": "stateful" } });
  await w.request({ url: "/b", headers: { "X-sap-adt-sessiontype": "" } });
  await w.request({ url: "/c", headers: { "X-sap-adt-sessiontype": "stateless" } });
  assert.deepEqual(log.filter(l => l[0] === "req").map(l => l[2]), ["stateful", "stateful", "stateless"]);
});
test("overlapping requests are serialized with their own modes", async () => {
  const log = []; const w = wireWith(log);
  await Promise.all([w.request({ url: "/a", headers: { "X-sap-adt-sessiontype": "stateful" } }),
    w.request({ url: "/b", headers: { "X-sap-adt-sessiontype": "stateless" } })]);
  assert.deepEqual(log.filter(l => l[0] === "req").map(l => [l[4], l[2]]), [["/a", "stateful"], ["/b", "stateless"]]);
});
test("logoff is answered locally, ends the session; next request opens a new one", async () => {
  const log = []; const w = wireWith(log);
  await w.request({ url: "/read" });
  const r = await w.request({ url: "/sap/public/bc/icf/logoff" });
  assert.equal(r.status, 200);
  await w.request({ url: "/read" });
  assert.deepEqual(log.filter(l => l[0] !== "req"), [["connect", 1], ["disconnect", 1], ["connect", 2]]);
  assert.equal(log.filter(l => l[0] === "req" && l[4].includes("logoff")).length, 0);
});
test("read, apply (logoff), read, apply on one wire", async () => {
  const log = []; const w = wireWith(log);
  for (const u of ["/read", "/apply", "/sap/public/bc/icf/logoff", "/read", "/apply", "/sap/public/bc/icf/logoff"]) await w.request({ url: u });
  assert.equal(log.filter(l => l[0] === "connect").length, 2);
});
test("a response-bearing failure becomes the response", async () => {
  const log = []; const w = wireWith(log);
  const r = await w.request({ url: "/fail" });
  assert.equal(r.status, 400); assert.equal(r.body, "<x/>");
});
test("a failed open leaves no session and the next request tries again", async () => {
  let fail = true; const log = [];
  const factory = fakeFactory(log);
  const w = createRfcWire(system, { providerFor: async () => ({}), logger: null,
    connector: (...a) => { const c = factory(...a); if (fail) { fail = false; c.connect = async () => { throw new Error("no SNC"); }; } return c; } });
  await assert.rejects(w.request({ url: "/a" }), /no SNC/);
  const r = await w.request({ url: "/a" }); assert.equal(r.status, 200);
});
test("dispose ends the session and the wire stays usable", async () => {
  const log = []; const w = wireWith(log);
  await w.request({ url: "/a" }); await w.dispose(); await w.request({ url: "/b" });
  assert.equal(log.filter(l => l[0] === "connect").length, 2);
});
```

  Add, according to gate 3's recorded choice:
  - **A:** a test that a response's own `x-csrf-token` passes through unchanged;
  - **B:** a test that every returned response carries `x-csrf-token: rfc`, and that an outgoing
    `x-csrf-token` never reaches `makeAdtRequest` (already covered by the mapping test).

- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement** `vscode/auth/rfc-wire.js`:

```js
"use strict";
const path = require("path");
const LOGOFF = "/sap/public/bc/icf/logoff";
const STRIP = ["authorization", "cookie", "x-csrf-token", "x-sap-adt-sessiontype"];
const CSRF_MARKER = /* from GATES.md gate 3: "A" → null, "B" → "rfc" */ null;

function sdkSentence(error) {
  return "SNC needs the SAP NW RFC SDK: install it, put its lib directory on PATH (Windows) or "
    + "DYLD_LIBRARY_PATH (macOS), and restart VS Code. The load failed with: " + (error && error.message || error);
}
function loadClient() {
  const connectionDir = path.dirname(require.resolve("@mcp-abap-adt/connection/package.json"));
  try { return require(require.resolve("@mcp-abap-adt/sap-rfc-lite", { paths: [connectionDir] })).Client; }
  catch (e) { throw new Error(sdkSentence(e)); }
}
function defaultConnector(system, provider, open, logger) {
  const { AdtOnPremConnector, RfcTransport } = require("@mcp-abap-adt/connection");
  const config = { url: system.url, client: system.client || undefined, authType: "snc",
    sncPartnerName: system.snc.partnerName, sncQop: system.snc.qop, sncLib: system.snc.library, sncMyName: system.snc.myName };
  return new AdtOnPremConnector(config, provider, new RfcTransport(open, logger), logger);
}

function createRfcWire(system, { providerFor, logger = null, connector = defaultConnector }) {
  let session = null;          // the live connector, or null
  let queue = Promise.resolve();
  let mode = "stateless";
  const run = work => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };

  function open(logon) {
    const Client = loadClient();
    const address = { ashost: system.rfc.ashost, sysnr: system.rfc.sysnr, lang: "EN" };
    if (system.rfc.saprouter) address.saprouter = system.rfc.saprouter;
    if (system.client) address.client = system.client;
    try { return new Client({ ...address, ...logon }); } catch (e) { throw new Error(sdkSentence(e)); }
  }
  async function live() {
    if (session) return session;
    const provider = await providerFor(system);
    const c = connector(system, provider, open, logger);
    await c.connect();
    session = c;
    return c;
  }
  async function end() {
    const c = session; session = null;
    if (c) await c.disconnect().catch(() => {});
  }
  function respond(r) {
    const headers = { ...(r.headers || {}) };
    if (CSRF_MARKER && headers["x-csrf-token"] === undefined) headers["x-csrf-token"] = CSRF_MARKER;
    return { body: typeof r.data === "string" ? r.data : r.data == null ? "" : String(r.data), status: r.status, statusText: r.statusText || "", headers };
  }

  return {
    request(options) {
      return run(async () => {
        const url = new URL(options.url, "http://rfc.invalid");
        if (url.pathname === LOGOFF) { await end(); return respond({ status: 200, statusText: "OK", headers: {}, data: "" }); }
        const headers = {};
        for (const [k, v] of Object.entries(options.headers || {})) {
          if (k.toLowerCase() === "x-sap-adt-sessiontype") { if (v === "stateful" || v === "stateless") mode = v; continue; }
          if (!STRIP.includes(k.toLowerCase())) headers[k] = v;
        }
        const c = await live();
        c.setSessionType(mode);
        try {
          const r = await c.makeAdtRequest({ url: url.pathname + url.search, method: options.method || "GET",
            params: options.qs, data: options.body, headers, timeout: options.timeout || 60000 });
          return respond(r);
        } catch (e) {
          if (e && e.response) return respond(e.response);
          throw e;
        }
      });
    },
    dispose() { return run(end); },
  };
}
module.exports = { createRfcWire, sdkSentence };
```

  Set `CSRF_MARKER` from `GATES.md` gate 3 (`"A"` → `null`, `"B"` → `"rfc"`), with a comment
  pointing at `GATES.md`.
- [ ] **Step 4: run, expect pass.** **Step 5: commit** `git commit -m "auth: RFC wire for snc over the connector"`.

### Task 8: `clients.js` and the extension's own paths

**Files:**
- Create: `vscode/auth/clients.js`
- Modify: `vscode/extension.js` (`secretKey`, `password`, `missing`, `request`, `csrf`, `fetch`,
  test-connection and forget-password commands, activation), delete `vscode/sap-http.js`
- Test: `vscode/test/auth-clients.test.js`; update `vscode/test/extension.test.js` where it
  stubs `sap-http` or `context.secrets`

**Interfaces:**
- Consumes: Tasks 3–7.
- Produces: `createAuth({ vscode, context, logger }) → { systemOf(entry), makeClient(system, role),
  wireFor(system, role), password(system), forget(system), refusalFor(system) }`. `makeClient`
  returns an `ADTClient` with an added `dispose()` that disposes its wire. `role` ∈
  `"repository" | "listener" | "probe" | "debuggee" | "command"`.

- [ ] **Step 1: failing test** `vscode/test/auth-clients.test.js`:

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAuth } = require("../auth/clients");
function fakeVscode(systems, { remoteName } = {}) {
  const prompts = [];
  return { prompts, env: { remoteName }, window: { showInputBox: async o => { prompts.push(o.prompt); return "typed"; } },
    workspace: { getConfiguration: () => ({ get: k => (k === "systems" ? systems : "") }) } };
}
function fakeContext() { const m = new Map(), g = new Map(); return { m,
  secrets: { get: async k => m.get(k), store: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } },
  globalState: { get: k => g.get(k), update: async (k, v) => { g.set(k, v); } } }; }

test("makeClient builds an ADTClient on the HTTP wire with no secret in it", async () => {
  const auth = createAuth({ vscode: fakeVscode([{ name: "D", url: "http://127.0.0.1:9", user: "u" }]), context: fakeContext(), logger: null });
  const system = auth.systemOf({ name: "D", url: "http://127.0.0.1:9", user: "u" }).system;
  const client = await auth.makeClient(system, "repository");
  assert.equal(typeof client.dispose, "function");
  assert.equal(client.httpClient.password, "-");
});
test("password asks once, then reads the store", async () => {
  const v = fakeVscode([{ name: "D", url: "http://h", user: "u" }]), ctx = fakeContext();
  const auth = createAuth({ vscode: v, context: ctx, logger: null });
  const s = auth.systemOf({ name: "D", url: "http://h", user: "u" }).system;
  assert.equal(await auth.password(s), "typed"); assert.equal(await auth.password(s), "typed");
  assert.equal(v.prompts.length, 1);
});
test("snc on a remote host is refused before any client is built", async () => {
  const entry = { name: "S", url: "https://s", user: "u", authType: "snc", snc: { partnerName: "p:CN=S" }, rfc: { ashost: "s", sysnr: "00" } };
  const auth = createAuth({ vscode: fakeVscode([entry], { remoteName: "wsl" }), context: fakeContext(), logger: null });
  await assert.rejects(auth.makeClient(auth.systemOf(entry).system, "repository"), /remote host \(wsl\)/);
});
test("forget removes the stored password", async () => {
  const v = fakeVscode([{ name: "D", url: "http://h", user: "u" }]), ctx = fakeContext();
  const auth = createAuth({ vscode: v, context: ctx, logger: null });
  const s = auth.systemOf({ name: "D", url: "http://h", user: "u" }).system;
  await auth.password(s); await auth.forget(s); await auth.password(s);
  assert.equal(v.prompts.length, 2);
});
```

- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement** `vscode/auth/clients.js`:

```js
"use strict";
const path = require("path");
const { readSystem, loginIdentity } = require("./systems");
const { createStores } = require("./stores");
const { migrateOnce, legacyPasswordFor, retireLegacy } = require("./migrate");
const { createBroker } = require("./broker");
const { createHttpWire } = require("./http-wire");
const { refusalFor } = require("./hosts");

function createAuth({ vscode, context, logger }) {
  const currentSystems = () => (vscode.workspace.getConfiguration("vertex").get("systems") || [])
    .map(readSystem).filter(r => r.system).map(r => r.system);
  const secrets = context.secrets;
  const { serviceKeyStore, sessionStore, means } = createStores({ secrets, currentSystems });
  const broker = createBroker({ serviceKeyStore, sessionStore, logger });
  const migrated = migrateOnce({ secrets, globalState: context.globalState, currentSystems });
  const refusals = new Map();

  async function password(system) {
    await migrated;
    const id = loginIdentity(system);
    let pw = await means.password(id);
    if (pw) return pw;
    pw = await legacyPasswordFor({ secrets, currentSystems }, system);
    if (!pw) pw = await vscode.window.showInputBox({ prompt: "SAP password for " + system.user + " on " + system.name, password: true, ignoreFocusOut: true });
    if (pw) {
      await means.setPassword(id, pw);
      await retireLegacy({ secrets, currentSystems, hasLogin: async other => !!(await means.password(other)) }, system.name);
    }
    return pw;
  }
  function hostRefusal(system) {
    const connectionDir = (() => { try { return path.dirname(require.resolve("@mcp-abap-adt/connection/package.json")); } catch (_) { return undefined; } })();
    return refusalFor(system, { platform: process.platform, remoteName: vscode.env.remoteName,
      resolve: name => require.resolve(name, connectionDir ? { paths: [connectionDir] } : undefined) });
  }
  async function wireFor(system) {
    const refused = hostRefusal(system);
    if (refused) throw new Error(refused);
    if (system.authType === "basic" && !(await password(system))) throw new Error("No password was entered for " + system.name + ", so nothing was sent.");
    const providerFor = s => broker.providerFor(s);
    if (system.authType === "snc") return require("./rfc-wire").createRfcWire(system, { providerFor, logger });
    return createHttpWire(system, { providerFor, onRefusal: (s, refusal) => refusals.set(loginIdentity(s), refusal) });
  }
  async function makeClient(system, role) {
    const wire = await wireFor(system, role);
    const { ADTClient } = require("abap-adt-api");
    const client = new ADTClient(system.url, system.user, "-", system.client || "", "EN",
      { timeout: role === "listener" || role === "probe" || role === "debuggee" ? 300000 : 60000 });
    client.httpClient.httpclient = wire;
    client.dispose = () => Promise.resolve(wire.dispose());
    return client;
  }
  return {
    systemOf: readSystem, currentSystems, makeClient, wireFor, password, hostRefusal,
    lastRefusal: system => refusals.get(loginIdentity(system)),
    async forget(system) { await means.forget(loginIdentity(system)); },
  };
}
module.exports = { createAuth };
```

- [ ] **Step 4: integrate `extension.js`.** In `activate(context)` create
  `const auth = require("./auth/clients").createAuth({ vscode, context, logger })` (logger: the
  existing output channel wrapped as `{ debug, info, warn, error }` writing at those levels).
  Then:
  - Replace `secretKey` and `password(context, system)` with `auth.password(system)`; delete both.
  - Replace `missing(system)` and the `active()` validation with `auth.systemOf(entry)`: an `{ error }`
    becomes `"ERROR:" + error`.
  - Replace `request(system, pw, requestPath, extra)` so it sends through
    `await auth.wireFor(system, "command")` and its `request({ url: withClient(system, requestPath),
    method, headers, body })`, keeping the `Accept` defaults and `Content-Type` it sets today and
    dropping its `Authorization` header. Map the wire response `{ status, headers, body }` to the
    same shape callers use today.
  - `csrf(system)`: unchanged logic over the new `request`; for `system.authType === "snc"` return
    `{ token: "", cookies: "" }` and send no CSRF header.
  - `fetch`'s 401 branch: `await auth.forget(system)` instead of deleting `secretKey(system)`;
    keep the message; append `auth.lastRefusal(system)`'s `reason` if present.
  - The test-connection command: a discovery GET through `auth.wireFor(system, "command")`.
  - The forget-password command: rename its title to "VERTEX: Forget Credentials" in
    `package.json` (keep the command id), body `await auth.forget(system)`.
  - Delete `vscode/sap-http.js`; `grep -rn "sap-http" vscode --include=*.js` must return only test
    files that are updated in this step.
- [ ] **Step 5: run** `npm test`; fix `test/extension.test.js` stubs that relied on
  `secretKey`/`sap-http` so they inject `context.secrets` and a fake wire instead. All green.
- [ ] **Step 6: commit** `git commit -m "auth: one client factory; the extension's own requests through the wire"`.

### Task 9: Debugger wiring

**Files:**
- Modify: `vscode/extension.js` (`systemKey`, `debuggerFor`), `vscode/debugger.js`
- Test: `vscode/test/debugger.test.js` (extend)

**Interfaces:** Consumes `auth.makeClient`, `connectionKey`.

- [ ] **Step 1: failing tests** in `vscode/test/debugger.test.js` (using its existing fake `connect`):
  - `sync`, `source` and `classMethods` call the **probe** client, never the listener, while a
    `debuggerListen` promise is pending (fake listener whose `debuggerListen` never settles; assert
    the probe received `debuggerSetBreakpoints`, `getObjectSource`, `classComponents`).
  - `stop()` deletes the listener through the probe (`debuggerDeleteListener` on probe).
  - A failing `debuggerAttach` disposes the client `open()` returned (fake client counts
    `dispose()` calls → 1) and leaves `session` null.
  - A system switch with no live session disposes the old listener and probe (each `dispose()` → 1).
  - `release`, `end` and `stop` call `logout()` on the debuggee client (unchanged) and nothing
    else is left undisposed (fake counts).
- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement** in `vscode/debugger.js`:
  - In `sync` (`:268`), `source` (`:1147`), `classMethods` (`:1161`) and the takeover delete
    (`:620`): take `probe` from `system()` and call the same method on it instead of `listener`.
  - In `stop()` (`:992`): `const { probe, user } = sap; await probe.debuggerDeleteListener(...)`.
  - In `loop()`'s attach catch (`:653`): `await exclusive(() => attach(hit)).catch(async error => {
    problems.push(...); if (session && session.client && session.client.dispose) await session.client.dispose().catch(() => {}); session = null; })`.
    In `attach`, if `debuggerAttach` throws after `open()`, the catch above disposes it — set
    `session` before calling `debuggerAttach` (already the case at `:642`).
  - In `system()` (`:220`), before `sap = null`: `await Promise.all([sap.listener, sap.probe].map(c => c && c.dispose ? c.dispose() : null)).catch(() => {})`.

  In `vscode/extension.js` `debuggerFor`:
  - `systemKey(system)` → `require("./auth/systems").connectionKey(system)`.
  - `connect`: `const listener = await auth.makeClient(system, "listener"); const probe = await auth.makeClient(system, "probe");`
  - `open`: `const client = await auth.makeClient(system, "debuggee"); client.stateful = "stateful";
    try { await client.login(); } catch (e) { await client.dispose().catch(() => {}); throw e; } return client;`
  - Remove the password lookup in `connect` (`makeClient` asks when needed).
- [ ] **Step 4: run** `npm test`, all green. **Step 5: commit**
  `git commit -m "debugger: probe carries everything but the poll; every client is disposed on every path"`.

### Task 10: Repository and restore

**Files:**
- Modify: `vscode/code-workbench.js` (`repository()` `:361–390`, `rememberEditor`, `fileEntry` `:399–439`)
- Test: `vscode/test/code-workbench.test.js` (extend)

- [ ] **Step 1: failing tests** in `vscode/test/code-workbench.test.js` with its `host()` helper:
  - A saved editor whose system name exists in settings with the same connection key restores
    from the current definition (assert the repository was built for the current system).
  - A saved editor whose system name no longer exists shows "DEV is no longer in vertex.systems"
    and no content.
  - A saved editor whose system's connection key changed, and whose re-read fails, shows the
    failure and never the saved content (assert no write is possible on it).
  - A saved key without `authType` restores as `basic`.
- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement:**
  - `repository(savedKey)`: build `system` from the **current** settings by name
    (`auth.currentSystems().find(s => s.name === savedName)`), never from the saved key. If none:
    throw `new Error(savedName + " is no longer in vertex.systems")`. The cache key is
    `connectionKey(system)`. The client is `await auth.makeClient(system, "repository")`. When a
    repository is dropped from `repositories`, call its client's `dispose()`.
  - `rememberEditor`: store `{ key: connectionKey(system), name: system.name, data }`.
  - `fileEntry`: if the saved `key` differs from the current system's `connectionKey`, re-read the
    object; on a read failure throw `vscode.FileSystemError.Unavailable(<the failure>)` and drop
    `savedEntries[key]` — do not fall back to `saved.data`. With an unchanged key, the existing
    fallback (`:423–439`) stays.
  - A saved entry in the old format (an array key) is read as `{ name: key[3] }` and goes through
    the same path.
- [ ] **Step 4: run** `npm test`. **Step 5: commit**
  `git commit -m "workbench: restore against current settings, never old source after a key change"`.

### Task 11: Settings schema and documentation

**Files:**
- Modify: `vscode/package.json` (`vertex.systems` schema), `README.md`, `vscode/README.md`,
  `history.md`, `dev_history.md`
- Test: `vscode/test/abap-language.test.js`-style manifest test in `vscode/test/auth-manifest.test.js`

- [ ] **Step 1: failing test** `vscode/test/auth-manifest.test.js`:

```js
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const manifest = require("../package.json");
const item = manifest.contributes.configuration.properties["vertex.systems"].items;
test("vertex.systems declares authType, snc and rfc, and no password", () => {
  assert.deepEqual(item.properties.authType.enum, ["basic", "snc"]);
  assert.ok(item.properties.snc.properties.partnerName);
  assert.ok(item.properties.rfc.properties.ashost && item.properties.rfc.properties.sysnr);
  assert.equal(item.properties.password, undefined);
  assert.deepEqual(item.required, ["name", "url", "user"]);
});
test("the auth packages are registry dependencies", () => {
  for (const p of ["@mcp-abap-adt/auth-broker", "@mcp-abap-adt/auth-providers", "@mcp-abap-adt/auth-stores", "@mcp-abap-adt/auth-errors", "@mcp-abap-adt/connection"]) {
    assert.match(manifest.dependencies[p], /^\^\d/);
  }
});
```

  (If `contributes.configuration` is an array in this manifest, index the entry that holds
  `vertex.systems`.)
- [ ] **Step 2: run, expect failure.**
- [ ] **Step 3: implement** the schema per SPEC §3: `authType` (`enum ["basic","snc"]`, default
  `"basic"`, description), `snc` (object: `partnerName` string, `qop` enum `["1","2","3","8","9"]`,
  `library` string, `myName` string), `rfc` (object: `ashost`, `sysnr` pattern `^\d\d$`,
  `saprouter`); `user`'s description: "SAP user. For basic, the logon user — its password is asked
  once and kept in the OS credential store. For snc, the ABAP user the debugger targets; no
  password."; `name`'s description: drop "Also what its stored password is filed under".
- [ ] **Step 4: documentation**, per `AGENTS.md` (current capabilities only in READMEs; the change
  only in the histories):
  - `README.md` and `vscode/README.md`: a "Connecting" section — `basic` as before; `snc` with its
    settings, prerequisites (Windows/macOS, Secure Login Client, SAP NW RFC SDK installed by the
    user with its `lib` on `PATH`/`DYLD_LIBRARY_PATH` before starting VS Code, RFC authorization
    for `SADT_REST_RFC_ENDPOINT`), and which VSIX to install per platform; remote hosts: `snc` not
    supported.
  - `history.md`: the user-visible change for the next version (version left to the owner).
  - `dev_history.md`: a stage entry with the gate results from `GATES.md`.
- [ ] **Step 5: run** `npm test`. **Step 6: commit**
  `git commit -m "settings and docs: authType, snc, rfc"`.

### Task 12: Packaging per target

**Files:**
- Modify: `vscode/package.ps1`, `vscode/.vscodeignore`, `vscode/package.json` (`engines.vscode`
  from gate 2)

- [ ] **Step 1: implement `-Target`** in `package.ps1`:
  - `param([ValidateSet('universal','win32-x64','darwin-arm64','darwin-x64')][string]$Target = 'universal')`.
  - For `universal`: `npm ci --omit=optional`; for a native target: `npm ci` (the caller sets
    `SAPNWRFC_HOME` and the SDK `lib` on the path), then fail unless
    `node_modules/**/@mcp-abap-adt/sap-rfc-lite/build/Release/*.node` exists.
  - `vsce package --out $candidate` plus `--target $Target` for a native target.
  - After packaging, list the archive and fail on: a native target without
    `extension/node_modules/**/sap-rfc-lite/build/Release/*.node`; `universal` with one; any
    entry matching `sapnwrfc*`, `libsapnwrfc*`, `libsapucum*`, `libicu*`, `icudt*`, `icuin*`,
    `icuuc*`.
  - Add the auth packages' `package.json` and `LICENSE` entries to `$required`.
  - Output name: `<name>-<version>[-<target>].vsix`.
- [ ] **Step 2:** `engines.vscode` per `GATES.md` gate 2.
- [ ] **Step 3 (OWNER, Windows):** `.\package.ps1 -Target win32-x64` and `.\package.ps1`
  (universal); both succeed; install each in a clean profile; with the universal one an `snc`
  system is refused with "no SNC support".
- [ ] **Step 4: commit** `git commit -m "packaging: per-target VSIX with the RFC binding, never the SDK"`.

### Task 13 (OWNER): Integration matrix

- [ ] Run SPEC §14's integration table: `basic` against an on-premise system over HTTP (from any
  machine), `snc` on the Windows machine. For every row record pass/fail and timing in
  `dev_history.md`; the listener shutdown time against `GATES.md` gate 4.
- [ ] Two windows: change the password in window A, the next request in window B uses it.
- [ ] Fresh profile with a legacy `vertex.password.<name>`: migration, no prompt.
- [ ] codex reviews the whole branch against SPEC and GOAL; findings fixed in this PR.
