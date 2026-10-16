"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { authError } = require("@mcp-abap-adt/auth-errors");

function refusedError(refusal) {
  const e = new Error(refusal.reason + (refusal.hint ? " " + refusal.hint : ""));
  e.refusal = refusal; return e;
}
const httpLogonTarget = {
  logonParameters: () => ({ ok: false, refusal: authError["logon-target"]({ wire: "http", refused: "logon-parameters" }) }),
  tlsMaterial: () => ({ ok: false, refusal: authError["logon-target"]({ wire: "http", refused: "tls-material" }) }),
};

function createHttpWire(system, { providerFor, onRefusal, ensureMeans = async () => true }) {
  const base = new URL(system.url);
  const secure = base.protocol === "https:";
  if (!secure && base.protocol !== "http:") throw new Error("Unsupported SAP URL protocol");
  const http = require(secure ? "https" : "http");
  const rejectUnauthorized = system.allowInsecureCertificate !== true;
  const agent = new http.Agent(secure ? { rejectUnauthorized, keepAlive: true } : { keepAlive: true });
  const ready = new WeakMap();
  // Standalone wire calls start an operation; nested ADT login calls reuse it.
  const operations = new AsyncLocalStorage();
  const runOperation = action => operations.getStore() ? action() : operations.run({ refused: false }, action);

  async function reportRefusal(refusal, moment) {
    operations.getStore().refused = true;
    try { await onRefusal(system, refusal, moment); } catch (_) { /* Preserve the provider's outcome. */ }
  }

  async function provider() {
    const p = await providerFor(system);
    if (!ready.has(p)) {
      // Defer provider calls until the shared promise is in the map, including synchronous throws.
      const initialization = Promise.resolve().then(async () => {
        const prepared = await p.prepare();
        if (!prepared.ok) { await reportRefusal(prepared.refusal, "prepare"); throw refusedError(prepared.refusal); }
        const established = await p.establish(httpLogonTarget);
        if (!established.ok) { await reportRefusal(established.refusal, "establish"); throw refusedError(established.refusal); }
      }).catch(error => {
        ready.delete(p);
        throw error;
      });
      ready.set(p, initialization);
    }
    await ready.get(p);
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
    if (operations.getStore().refused || !(await ensureMeans(system))) throw new Error("No password was entered for " + system.name + ", so nothing was sent.");
    const p = await provider();
    const headers = { ...options.headers };
    const extraCookies = [];
    const outcome = await p.authorize({ header(name, value) { headers[name] = value; }, cookies(value) { extraCookies.push(value); } });
    if (!outcome.ok) { await reportRefusal(outcome.refusal, "authorize"); throw refusedError(outcome.refusal); }
    if (extraCookies.length) headers.Cookie = mergeCookies(extraCookies.join("; "), headers.Cookie || headers.cookie || "");
    return { p, response: await send(options, headers) };
  }

  return {
    runOperation,
    request(options) { return runOperation(async () => {
      const first = await attempt(options);
      if (first.response.status !== 401) return first.response;
      const verdict = await first.p.rejected({ at: "request", status: 401, error: first.response });
      if (!verdict.ok) { await reportRefusal(verdict.refusal, "rejected"); return first.response; }
      const second = await attempt(options);
      return second.response;
    }); },
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
