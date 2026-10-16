"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const adt = require("../sap-adt-extension");
const { landscape } = require("../system-setup");

function tempFile(name, text) {
  const file = path.join(os.tmpdir(), "vertex-" + process.pid + "-" + name);
  fs.writeFileSync(file, text);
  return file;
}

test("the SAP ADT extension's destinations are read with their properties; a missing file is none", () => {
  const file = tempFile("destinations.json", JSON.stringify({ formatVersion: "1.0", destinations: [
    { id: "A4H_001_DEVELOPER_EN", protocol: "rfc", properties: { systemId: "A4H", client: "001", sncType: "9", partnerName: "p:CN=A4H", ssoEnabled: "true" } },
    { protocol: "rfc", properties: {} }] }));
  try {
    assert.deepEqual(adt.destinations(file).map(d => d.id), ["A4H_001_DEVELOPER_EN"]);
    assert.deepEqual(adt.destinations(file + ".missing"), []);
  } finally { fs.unlinkSync(file); }
});

test("a destinations file that is not JSON is said, not read as empty", () => {
  const file = tempFile("broken.json", "{ not json");
  try { assert.throws(() => adt.destinations(file), /is not valid JSON/); }
  finally { fs.unlinkSync(file); }
});

test("a system through the extension refuses what needs VERTEX's own HTTP connection, naming why", () => {
  const system = { name: "A4H_SNC", connection: "sap-adt-extension", destination: "A4H_001_DEVELOPER_EN" };
  assert.equal(adt.viaExtension(system), true);
  assert.equal(adt.viaExtension({ name: "A4H", url: "https://a4h:44300", user: "DEVELOPER" }), false);
  assert.match(adt.httpRefusal(system), /only with SAP ADT extension \(destination A4H_001_DEVELOPER_EN\)/);
});

test("SAP Logon entries with SNC single sign-on are set apart; SNC with user and password stays an HTTP candidate", () => {
  const file = tempFile("landscape.xml", '<Landscape><Services>'
    + '<Service type="SAPGUI" name="Snc" systemid="SNC" server="snchost:3200" sncname="p:CN=SNC" sncop="9"/>'
    + '<Service type="SAPGUI" name="SncPw" systemid="SPW" server="spwhost:3201" sncname="p:CN=SPW" sncnosso="1"/>'
    + '<Service type="SAPGUI" name="Dev" systemid="DEV" server="devhost:3205"/></Services></Landscape>');
  try {
    const { systems, snc } = landscape([file]);
    assert.deepEqual(systems.map(s => s.id), ["SPW", "DEV"]);
    assert.deepEqual(snc, ["Snc"]);
  } finally { fs.unlinkSync(file); }
});

function fakeVscode({ installed = true, top = [], picked = items => items } = {}) {
  const updates = [], messages = [];
  const extension = { id: "SAPSE.adt-vscode", isActive: true, activate: async () => {} };
  let systems = [{ name: "A4H", url: "https://a4h:44300", user: "DEVELOPER" }];
  return { updates, messages, get systems() { return systems; },
    extensions: { getExtension: id => installed && id === "SAPSE.adt-vscode" ? extension : undefined, all: installed ? [extension] : [] },
    Uri: { from: parts => ({ ...parts, toString: () => parts.scheme + ":" + parts.path }) },
    workspace: {
      fs: { readDirectory: async () => top },
      getConfiguration: () => ({ get: () => systems, update: async (key, value) => { updates.push(value); systems = value; } })
    },
    ConfigurationTarget: { Global: 1 },
    window: { showQuickPick: async items => picked(items), showInformationMessage: text => messages.push(text) }
  };
}

test("Get Connections adds the picked destinations as systems with no url, user or password", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-home-"));
  fs.mkdirSync(path.join(home, ".adtls"));
  fs.writeFileSync(path.join(home, ".adtls", "destinations.json"), JSON.stringify({ destinations: [
    { id: "A4H", protocol: "rfc", properties: { systemId: "A4H", client: "001", user: "DEVELOPER" } }] }));
  t.mock.method(os, "homedir", () => home);
  try {
    const vscode = fakeVscode();
    await adt.importConnections(vscode);
    // The destination's id is already a system's name: the added one is told apart, the HTTP one is kept.
    assert.deepEqual(vscode.systems, [{ name: "A4H", url: "https://a4h:44300", user: "DEVELOPER" },
      { name: "A4H_2", connection: "sap-adt-extension", destination: "A4H", client: "001" }]);
    await adt.importConnections(vscode);
    assert.equal(vscode.updates.length, 1, "a destination already in vertex.systems is not added twice");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("without the SAP extension there is nothing to take, and that is said", async () => {
  await assert.rejects(adt.importConnections(fakeVscode({ installed: false })), /is not installed/);
});

test("the state tells not installed, unknown destination, not logged on and logged on apart", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-home-"));
  fs.mkdirSync(path.join(home, ".adtls"));
  fs.writeFileSync(path.join(home, ".adtls", "destinations.json"), JSON.stringify({ destinations: [{ id: "A4H", protocol: "rfc" }] }));
  t.mock.method(os, "homedir", () => home);
  const system = { name: "A4H_2", connection: "sap-adt-extension", destination: "A4H" };
  try {
    assert.match((await adt.state(fakeVscode({ installed: false }), system)).text, /not installed/);
    assert.match((await adt.state(fakeVscode(), { ...system, destination: "B4H" })).text, /has no destination B4H/);
    assert.deepEqual(await adt.state(fakeVscode(), system), { ok: false,
      text: "not logged on - log on to A4H in SAP ADT extension (ABAP: Logon to Destination)" });
    assert.equal((await adt.state(fakeVscode({ top: [["Local Objects ($TMP)", 2], ["System Library", 2]] }), system)).ok, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
