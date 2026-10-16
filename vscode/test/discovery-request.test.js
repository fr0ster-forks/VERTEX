"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("discovery negotiates Atom service XML for connection checks and CSRF", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
  const calls = [];
  const auth = { commandWire: async () => ({ request: async options => {
    calls.push(options);
    return { status: options.headers.Accept === "application/atomsvc+xml" ? 200 : 406, headers: {}, body: "" };
  } }) };
  const context = vm.createContext({ Buffer, auth, withClient: (_system, requestPath) => requestPath });
  vm.runInContext(source.slice(source.indexOf("async function request(system"), source.indexOf("/* A write needs a CSRF")), context);
  const system = { url: "http://sap.example", user: "TEST" };
  const request = context.request;
  assert.equal((await request(system, "/sap/bc/adt/discovery?sap-client=100")).status, 200);
  assert.equal((await request(system, "/sap/bc/adt/discovery", { headers: { "x-csrf-token": "fetch" } })).status, 200);
  assert.equal(calls[1].headers["x-csrf-token"], "fetch");
  await request(system, "/sap/bc/adt/vertex/about");
  assert.equal(calls[2].headers.Accept, "application/json");
});
