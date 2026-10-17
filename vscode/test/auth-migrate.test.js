"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { migrateOnce, retireLegacy } = require("../auth/migrate");
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
  assert.equal(await createStores({ secrets, currentSystems: () => [a, b] }).means.password(loginIdentity(a)), undefined);
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

test("recorded legacy names include missing systems and override current-name discovery", async () => {
  const state = memoryState();
  await state.update("vertex.auth.legacyNames", ["GONE", "DEV", "DEV"]);
  const dev = sys({ name: "DEV" }), other = sys({ name: "OTHER", client: "200" });
  const secrets = memorySecrets({ "vertex.password.GONE": "old", "vertex.password.DEV": "pw", "vertex.password.OTHER": "other" });
  const r = await migrateOnce({ secrets, globalState: state, currentSystems: () => [dev, other] });
  assert.deepEqual(r, { migrated: ["DEV"], kept: ["GONE"] });
  assert.equal(secrets.m.get("vertex.password.GONE"), "old");
  assert.equal(secrets.m.get("vertex.password.OTHER"), "other");
  assert.equal(await createStores({ secrets, currentSystems: () => [dev, other] }).means.password(loginIdentity(other)), undefined);
  const gets = [];
  const get = secrets.get;
  secrets.get = async key => { gets.push(key); return get(key); };
  assert.deepEqual(await migrateOnce({ secrets, globalState: state, currentSystems: () => [sys({ name: "GONE" })] }), { migrated: [], kept: [] });
  assert.deepEqual(gets, []);
});

test("an explicitly empty legacy name list does not fall back to current names", async () => {
  const state = memoryState();
  await state.update("vertex.auth.legacyNames", []);
  const secrets = memorySecrets({ "vertex.password.DEV": "pw" });
  assert.deepEqual(await migrateOnce({ secrets, globalState: state, currentSystems: () => [sys({ name: "DEV" })] }), { migrated: [], kept: [] });
  assert.equal(secrets.m.get("vertex.password.DEV"), "pw");
});
