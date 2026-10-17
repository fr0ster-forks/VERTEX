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
  const legacyNames = globalState.get("vertex.auth.legacyNames");
  const names = legacyNames === undefined ? systems.map(s => s.name) : legacyNames;
  for (const name of [...new Set(names)]) {
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

async function retireLegacy({ secrets, currentSystems, hasLogin }, name) {
  const same = currentSystems().filter(s => s.name === name && s.authType === "basic");
  for (const s of same) if (!(await hasLogin(loginIdentity(s)))) return;
  await secrets.delete(legacyKey(name));
}
module.exports = { migrateOnce, retireLegacy };
