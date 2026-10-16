"use strict";
const { loginIdentity } = require("./systems");
const { applySecret } = require("./session-secret");
const FIELDS = ["authorizationToken", "sessionCookies", "expiresAt", "refreshToken", "issuedFor", "issuedBy"];

function createStores({ secrets, currentSystems }) {
  const chains = new Map();
  const serial = (id, work) => { const run = (chains.get(id) || Promise.resolve()).then(work, work); chains.set(id, run.catch(() => {})); return run; };
  const systemOf = id => currentSystems().find(s => loginIdentity(s) === id);
  // Mirrors the reference takeSecret (auth-stores src/session/sessionSecret.ts): strings are
  // strings, expiresAt a non-negative safe integer, one credential kind at most, no other field.
  function validSecret(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    for (const [k, val] of Object.entries(v)) {
      if (!FIELDS.includes(k)) return false;
      if (k === "expiresAt") { if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 0) return false; }
      else if (typeof val !== "string") return false;
    }
    return !(v.authorizationToken && v.sessionCookies);
  }
  async function readJson(key, what) {
    const raw = await secrets.get(key);
    if (raw === undefined || raw === null || raw === "") return null;
    let v; try { v = JSON.parse(raw); } catch (_) { v = undefined; }
    const ok = what === FIELDS ? validSecret(v)
      : !!v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, x]) => what.includes(k) && typeof x === "string");
    if (!ok) throw new Error("The stored " + key.split(".").pop() + " record is not this store's format; it was not used.");
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
      if (!config || typeof config !== "object") throw new Error("The session store write is not an object.");
      const current = (await readJson(id + ".session", FIELDS)) || {};
      const unknown = Object.keys(config || {}).filter(k => !FIELDS.includes(k) && config[k] !== undefined).sort();
      if (unknown.length) throw new Error("The session store holds no " + unknown.join(", ") + " (unknown field).");
      const write = {}; for (const f of FIELDS) if (config && config[f] !== undefined) write[f] = config[f];
      if (write.expiresAt !== undefined && (!Number.isSafeInteger(write.expiresAt) || write.expiresAt < 0)) throw new Error("expiresAt must be a non-negative whole number (epoch milliseconds).");
      for (const [k, v] of Object.entries(write)) if (k !== "expiresAt" && typeof v !== "string") throw new Error(k + " must be a string.");
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
