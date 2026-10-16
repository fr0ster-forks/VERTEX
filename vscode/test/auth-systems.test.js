"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readSystem, canonicalOrigin, loginIdentity, connectionKey } = require("../auth/systems");

const base = { name: "DEV", url: "https://Host.Example.com", client: "100", user: "dev" };

test("a system without authType is basic", () => {
  assert.equal(readSystem(base).system.authType, "basic");
});
test("url and user are required for every type", () => {
  assert.match(readSystem({ ...base, url: "" }).error, /url/);
  assert.match(readSystem({ ...base, user: "" }).error, /user/);
  assert.match(readSystem({ ...base, authType: "snc", user: "", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "00" } }).error, /user/);
});
test("a password in settings is refused", () => {
  assert.match(readSystem({ ...base, password: "x" }).error, /password/);
});
test("snc needs snc.partnerName and rfc.ashost/sysnr", () => {
  assert.match(readSystem({ ...base, authType: "snc" }).error, /snc\.partnerName/);
  assert.match(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X" } }).error, /rfc\.ashost/);
  assert.match(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "0" } }).error, /rfc\.sysnr/);
  assert.match(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X", qop: "5" }, rfc: { ashost: "h", sysnr: "00" } }).error, /snc\.qop/);
  assert.ok(readSystem({ ...base, authType: "snc", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "00" } }).system);
});
test("an unknown authType is refused", () => {
  assert.match(readSystem({ ...base, authType: "jwt" }).error, /authType/);
});
test("canonicalOrigin lower-cases and makes the port explicit", () => {
  assert.equal(canonicalOrigin("HTTPS://Host.Example.com/sap/bc"), "https://host.example.com:443");
  assert.equal(canonicalOrigin("http://h:8000"), "http://h:8000");
});
test("login identity ignores the name and follows url, client, type, user", () => {
  const a = readSystem(base).system;
  assert.match(loginIdentity(a), /^vertex\.auth\.v1\.[0-9a-f]{32}$/);
  assert.equal(loginIdentity(a), loginIdentity(readSystem({ ...base, name: "OTHER" }).system));
  assert.equal(loginIdentity(a), loginIdentity(readSystem({ ...base, user: "DEV", url: "https://host.example.com:443" }).system));
  assert.notEqual(loginIdentity(a), loginIdentity(readSystem({ ...base, client: "200" }).system));
  assert.notEqual(loginIdentity(a), loginIdentity(readSystem({ ...base, user: "other" }).system));
});
test("connection key changes with snc, rfc and certificate policy", () => {
  const snc = { ...base, authType: "snc", snc: { partnerName: "p:CN=X" }, rfc: { ashost: "h", sysnr: "00" } };
  const k = connectionKey(readSystem(snc).system);
  assert.notEqual(k, connectionKey(readSystem({ ...snc, rfc: { ashost: "h2", sysnr: "00" } }).system));
  assert.notEqual(k, connectionKey(readSystem({ ...snc, snc: { partnerName: "p:CN=Y" } }).system));
  assert.notEqual(connectionKey(readSystem(base).system), connectionKey(readSystem({ ...base, allowInsecureCertificate: true }).system));
});
