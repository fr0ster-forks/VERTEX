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
  for (const bad of ["{not json", JSON.stringify({ authorizationToken: 5 }), JSON.stringify({ authorizationToken: "t", sessionCookies: "c" }),
    JSON.stringify({ authorizationToken: "t", expiresAt: -1 }), JSON.stringify({ authorizationToken: "t", expiresAt: 1.5 }),
    JSON.stringify({ authorizationToken: "t", extra: "x" }), JSON.stringify(["t"])]) {
    secrets.m.set(id + ".session", bad);
    await assert.rejects(sessionStore.loadSession(id), /not this store's format/, bad);
  }
  secrets.m.delete(id + ".session");
  await assert.rejects(sessionStore.saveSession(id, { authorizationToken: "t", unknown: "x" }), /unknown/);
  await assert.rejects(sessionStore.saveSession(id, { authorizationToken: "t", expiresAt: "soon" }), /expiresAt/);
  await sessionStore.saveSession(id, { authorizationToken: "good" });
  for (const bad of [{ authorizationToken: 5 }, { refreshToken: {} }, { issuedFor: 7 }]) {
    await assert.rejects(sessionStore.saveSession(id, bad), /must be a string/);
    assert.deepEqual(await sessionStore.loadSession(id), { authorizationToken: "good" });
  }
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

test("takeSecret parity: non-object writes are refused without changing the session", async () => {
  const secrets = memorySecrets();
  const { sessionStore } = createStores({ secrets, currentSystems: () => [dev] });
  const id = loginIdentity(dev);
  await sessionStore.saveSession(id, { authorizationToken: "good" });
  for (const bad of [undefined, null, false, true, 0, 5, "", "token"]) {
    await assert.rejects(sessionStore.saveSession(id, bad), /not an object/);
    assert.deepEqual(await sessionStore.loadSession(id), { authorizationToken: "good" });
  }
});

test("takeSecret parity: refused carried fields are sorted and undefined fields are ignored", async () => {
  const { sessionStore } = createStores({ secrets: memorySecrets(), currentSystems: () => [dev] });
  const id = loginIdentity(dev);
  await assert.rejects(sessionStore.saveSession(id, { zebra: "private-z", alpha: "private-a", ignored: undefined }),
    { message: "The session store holds no alpha, zebra (unknown field)." });
  await sessionStore.saveSession(id, { authorizationToken: "t", extra: undefined, expiresAt: undefined });
  assert.deepEqual(await sessionStore.loadSession(id), { authorizationToken: "t" });
});

test("stored validation: every string field and safe expiry boundary is checked", async () => {
  const secrets = memorySecrets();
  const { sessionStore } = createStores({ secrets, currentSystems: () => [dev] });
  const id = loginIdentity(dev);
  for (const field of ["authorizationToken", "sessionCookies", "refreshToken", "issuedFor", "issuedBy"]) {
    for (const value of [null, 5, {}, []]) {
      secrets.m.set(id + ".session", JSON.stringify({ [field]: value }));
      await assert.rejects(sessionStore.loadSession(id), /not this store's format/);
    }
  }
  for (const expiresAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", null]) {
    secrets.m.set(id + ".session", JSON.stringify({ expiresAt }));
    await assert.rejects(sessionStore.loadSession(id), /not this store's format/);
  }
  for (const expiresAt of [0, Number.MAX_SAFE_INTEGER]) {
    secrets.m.set(id + ".session", JSON.stringify({ expiresAt }));
    assert.deepEqual(await sessionStore.loadSession(id), { expiresAt });
  }
});
