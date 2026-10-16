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
  for (const field of ["url", "webgui"]) {
    if (!e[field]) continue;
    let parsed;
    try { parsed = new URL(e[field]); } catch (_) { continue; }
    if (parsed.username || parsed.password) return { error: "System " + name + " has a user or password in its " + field + ". Remove it: VERTEX keeps passwords in the OS credential store and asks for them." };
  }
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
