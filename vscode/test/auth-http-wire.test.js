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
test("ensureMeans false sends nothing", async () => {
  const { s, seen, url } = await server((req, res) => res.end("ok"));
  const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, { providerFor: async () => provider(), onRefusal() {}, ensureMeans: async () => false });
  await assert.rejects(wire.request({ url: "/x" }), /No password was entered/);
  assert.equal(seen.length, 0);
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
  const wire = createHttpWire(system, { providerFor: async () => provider(), onRefusal() {} });
  client.httpClient.httpclient = wire;
  if (loggedIn) await client.login();
  if (stateful) client.stateful = "stateful";
  const before = seen.length;
  await client.httpClient.request("/sap/bc/adt/repository/nodestructure", {}).catch(() => {});
  wire.dispose(); s.close();
  return seen.length - before;
}
test("§7: not yet logged in → 1 send", async () => assert.equal(await refusedCount({ body: "", loggedIn: false }), 1));
test("§7: logged in, stateful → 1 send", async () => assert.equal(await refusedCount({ body: "CSRF", stateful: true, loggedIn: true }), 1));
test("§7: logged in, stateless, no CSRF in body → 1 send", async () => assert.equal(await refusedCount({ body: "nope", loggedIn: true }), 1));
test("§7: logged in, stateless, CSRF in body → 2 sends", async () => assert.equal(await refusedCount({ body: "CSRF token required", loggedIn: true }), 2));


test("concurrent first requests share prepare and establish", async t => {
  const { s, seen, url } = await server((req, res) => res.end("ok"));
  const p = provider();
  const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, { providerFor: async () => p, onRefusal() {} });
  t.after(() => { wire.dispose(); s.close(); });
  const responses = await Promise.all([wire.request({ url: "/a" }), wire.request({ url: "/b" })]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(seen.length, 2);
  assert.equal(p.calls.filter(c => c === "prepare").length, 1);
  assert.equal(p.calls.filter(c => c === "establish").length, 1);
});

for (const moment of ["prepare", "establish"]) {
  for (const failure of ["Oops", "throw"]) {
    test(`concurrent ${moment} ${failure} is shared and initialization can retry`, async t => {
      const { s, seen, url } = await server((req, res) => res.end("ok"));
      const p = provider(), refusals = [];
      const refusal = authError["logon-target"]({ wire: "http", refused: "tls-material" });
      const error = new Error("initialization failed");
      const original = p[moment]; let fail = true;
      p[moment] = function (...args) {
        if (!fail) return original.apply(this, args);
        p.calls.push(moment);
        if (failure === "throw") throw error;
        return { ok: false, refusal };
      };
      const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, {
        providerFor: async () => p, onRefusal: (_, r, at) => refusals.push({ refusal: r, moment: at }),
      });
      t.after(() => { wire.dispose(); s.close(); });
      const results = await Promise.allSettled([wire.request({ url: "/a" }), wire.request({ url: "/b" })]);
      for (const result of results) {
        assert.equal(result.status, "rejected");
        if (failure === "Oops") assert.equal(result.reason.refusal, refusal);
        else assert.equal(result.reason, error);
      }
      assert.equal(results[0].reason, results[1].reason);
      assert.equal(seen.length, 0);
      assert.equal(p.calls.filter(c => c === moment).length, 1);
      assert.deepEqual(refusals, failure === "Oops" ? [{ refusal, moment }] : []);
      fail = false;
      assert.equal((await wire.request({ url: "/retry" })).status, 200);
      assert.equal(p.calls.filter(c => c === "prepare").length, 2);
      assert.equal(p.calls.filter(c => c === "establish").length, moment === "prepare" ? 1 : 2);
    });
  }
}

for (const moment of ["prepare", "establish", "authorize", "rejected"]) {
  for (const callback of ["throws", "rejects", "delays"]) {
    test(`${moment} refusal preserves its outcome when onRefusal ${callback}`, async t => {
      const { s, seen, url } = await server((req, res) => { res.statusCode = 401; res.end("refused"); });
      const p = provider();
      const refusal = authError["logon-target"]({ wire: "http", refused: "tls-material" });
      let rejectedResponse, completed = false;
      const reports = [];
      p[moment] = async target => {
        if (moment === "rejected") rejectedResponse = target.error;
        return { ok: false, refusal };
      };
      const wire = createHttpWire(readSystem({ name: "D", url, user: "u" }).system, {
        providerFor: async () => p,
        onRefusal(_, r, at) {
          reports.push({ refusal: r, moment: at });
          if (callback === "throws") throw new Error("callback failed");
          if (callback === "rejects") return Promise.reject(new Error("callback failed"));
          return new Promise(resolve => setTimeout(() => { completed = true; resolve(); }, 20));
        },
      });
      t.after(() => { wire.dispose(); s.close(); });
      if (moment === "rejected") {
        const response = await wire.request({ url: "/x" });
        assert.equal(response, rejectedResponse);
        assert.equal(response.status, 401); assert.equal(response.body, "refused");
      } else {
        await assert.rejects(wire.request({ url: "/x" }), e => {
          assert.equal(e.refusal, refusal);
          return true;
        });
      }
      assert.deepEqual(reports, [{ refusal, moment }]);
      assert.equal(seen.length, moment === "rejected" ? 1 : 0);
      if (callback === "delays") assert.equal(completed, true);
    });
  }
}
