"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const profiles = require("../key-profiles");

function secrets() {
  const values = new Map();
  return { values, get: async key => values.get(key), store: async (key, value) => { values.set(key, value); } };
}

test("named API keys stay separate and switching is manual", async () => {
  const vault = secrets();
  await profiles.save(vault, "groq-api", "work", "work-secret");
  await profiles.save(vault, "groq-api", "personal", "personal-secret");
  assert.deepEqual(await profiles.list(vault, "groq-api"), {
    names: ["work", "personal"], active: "personal"
  });
  await profiles.select(vault, "groq-api", "work");
  assert.deepEqual(await profiles.getActiveKey(vault, "groq-api"), { name: "work", key: "work-secret" });
  assert.equal([...vault.values.values()].includes("personal-secret"), true);
  await assert.rejects(profiles.select(vault, "groq-api", "unknown"), /Unknown key profile/);
});

test("existing one-key settings appear as DEFAULT without reentry", async () => {
  const vault = secrets();
  vault.values.set("vertex.provider.anthropic.apiKey", "old-secret");
  assert.deepEqual(await profiles.list(vault, "anthropic-api"), { names: ["DEFAULT"], active: "DEFAULT" });
  assert.deepEqual(await profiles.getActiveKey(vault, "anthropic-api"), { name: "DEFAULT", key: "old-secret" });
  await profiles.save(vault, "anthropic-api", "team", "team-secret");
  assert.deepEqual(await profiles.list(vault, "anthropic-api"), { names: ["DEFAULT", "team"], active: "team" });
  await profiles.select(vault, "anthropic-api", "DEFAULT");
  assert.equal((await profiles.getActiveKey(vault, "anthropic-api")).key, "old-secret");
});
