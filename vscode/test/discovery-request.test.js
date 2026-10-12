"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

test("discovery negotiates Atom service XML for connection checks and CSRF", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
  const calls = [];
  const http = { request(options, callback) {
    calls.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = options.headers.Accept === "application/atomsvc+xml" ? 200 : 406;
      res.headers = {};
      res.setEncoding = () => {};
      callback(res);
      res.emit("end");
    };
    return req;
  } };
  const context = vm.createContext({ URL, Buffer, http, https: http });
  vm.runInContext(source.slice(source.indexOf("function request(system"), source.indexOf("/* A write needs a CSRF")), context);
  const system = { url: "http://sap.example", user: "TEST" };
  const request = context.request;
  assert.equal((await request(system, "password", "/sap/bc/adt/discovery?sap-client=100")).status, 200);
  assert.equal((await request(system, "password", "/sap/bc/adt/discovery", { headers: { "x-csrf-token": "fetch" } })).status, 200);
  assert.equal(calls[1].headers["x-csrf-token"], "fetch");
  await request(system, "password", "/sap/bc/adt/vertex/about");
  assert.equal(calls[2].headers.Accept, "application/json");
});
