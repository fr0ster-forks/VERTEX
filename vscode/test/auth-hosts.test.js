"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { refusalFor } = require("../auth/hosts");
const snc = { name: "S", authType: "snc" }, basic = { name: "B", authType: "basic" };
const ok = () => "/x/sap-rfc-lite";
const missing = () => { throw new Error("Cannot find module"); };
test("basic is never refused", () => {
  assert.equal(refusalFor(basic, { platform: "linux", remoteName: "wsl", resolve: missing }), null);
});
test("snc on a remote host", () => {
  assert.match(refusalFor(snc, { platform: "win32", remoteName: "ssh-remote", resolve: ok }), /remote host \(ssh-remote\)/);
});
test("snc on linux", () => {
  assert.match(refusalFor(snc, { platform: "linux", remoteName: undefined, resolve: ok }), /Windows and macOS only/);
});
test("snc without the native module in this package", () => {
  assert.match(refusalFor(snc, { platform: "win32", remoteName: undefined, resolve: missing }), /no SNC support/);
});
test("snc allowed on darwin and win32", () => {
  assert.equal(refusalFor(snc, { platform: "darwin", remoteName: undefined, resolve: ok }), null);
  assert.equal(refusalFor(snc, { platform: "win32", remoteName: undefined, resolve: ok }), null);
});
