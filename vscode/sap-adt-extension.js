"use strict";
/* Systems VERTEX reaches through SAP's own ABAP Development Tools for VS Code instead of its own HTTP connection.

   That extension logs on by itself - over RFC, with SNC where SAP Logon says so - and shows the repository as a file
   system under the abap: scheme. A system of vertex.systems with "connection": "sap-adt-extension" names one of its
   destinations; VERTEX then never holds a user or a password for it. What the extension knows of its destinations
   is in ~/.adtls/destinations.json. */
const fs = require("fs"), os = require("os"), path = require("path");

const EXTENSION_ID = "SAPSE.adt-vscode";
const CONNECTION = "sap-adt-extension";
const LABEL = "only with SAP ADT extension";

function viaExtension(system) { return !!system && system.connection === CONNECTION; }

/* VS Code compares extension ids as written; the case of the publisher is SAP's, so a lower-case lookup misses it. */
function find(vscode) {
  return vscode.extensions.getExtension(EXTENSION_ID)
    || vscode.extensions.all.find(e => e.id.toLowerCase() === EXTENSION_ID.toLowerCase());
}

function destinationsFile() { return path.join(os.homedir(), ".adtls", "destinations.json"); }

function destinations(file = destinationsFile()) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") { return []; }
    throw new Error("Cannot read " + file + ": " + error.message);
  }
  let data;
  try { data = JSON.parse(text); }
  catch (error) { throw new Error(file + " is not valid JSON: " + error.message); }
  return (Array.isArray(data.destinations) ? data.destinations : []).filter(d => d && d.id);
}

function rootUri(vscode, destination) {
  return vscode.Uri.from({ scheme: "abap", path: "/repotree-v1/" + destination });
}

/* The sentence a function that needs VERTEX's own HTTP connection answers with on such a system. */
function httpRefusal(system) {
  return "System " + system.name + " is connected " + LABEL + " (destination " + system.destination
    + "). This needs VERTEX's own HTTP connection to SAP, which this system does not have.";
}

/* Installed, logged on, or neither. Logged on is seen from the repository root: the extension lists its two top
   folders once a destination is logged on, and nothing before. */
async function state(vscode, system) {
  const extension = find(vscode);
  if (!destinations().some(d => d.id === system.destination)) {
    return { ok: false, text: "SAP ADT extension has no destination " + system.destination };
  }
  try {
    // Reading abap: also activates SAP ADT through its onFileSystem event. An extension
    // running in another host may be absent from this host's extensions list.
    if (extension && !extension.isActive) { await extension.activate(); }
    const top = await vscode.workspace.fs.readDirectory(rootUri(vscode, system.destination));
    return top.length ? { ok: true, text: "logged on through SAP ADT extension (" + system.destination + ")" }
      : { ok: false, text: "not logged on - log on to " + system.destination + " in SAP ADT extension (ABAP: Logon to Destination)" };
  } catch (error) {
    if (!extension) return { ok: false, text: "SAP ADT extension is not available in this VS Code window for "
      + system.destination + ": " + error.message };
    return { ok: false, text: "SAP ADT extension did not answer for " + system.destination + ": " + error.message };
  }
}

/* The command behind "Get Connections from SAP ADT for VS Code". Nothing is written until the reader has picked. */
async function importConnections(vscode) {
  const list = destinations();
  if (!list.length) {
    throw new Error("SAP ADT extension has no destinations in " + destinationsFile()
      + ". Install or enable it in this VS Code window and create one (ABAP: New ABAP Destination).");
  }
  const config = vscode.workspace.getConfiguration("vertex");
  const existing = (config.get("systems") || []).filter(s => s && s.name);
  const taken = new Set(existing.filter(viaExtension).map(s => s.destination));
  const names = new Set(existing.map(s => String(s.name).toUpperCase()));
  const items = list.map(d => {
    const p = d.properties || {};
    return {
      label: d.id,
      description: [p.systemId, p.client ? "client " + p.client : "", p.user, d.protocol === "http" ? p.systemUrl : p.applicationServer].filter(Boolean).join(" · "),
      detail: [d.protocol ? d.protocol.toUpperCase() : "", p.ssoEnabled === "true" ? "single sign-on" : "", taken.has(d.id) ? "already in vertex.systems" : ""].filter(Boolean).join(" · "),
      picked: !taken.has(d.id), destination: d
    };
  });
  const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, ignoreFocusOut: true,
    title: "VERTEX: SAP ADT extension connections to add to vertex.systems" });
  if (!chosen || !chosen.length) { return; }
  const added = [];
  for (const { destination: d } of chosen) {
    if (taken.has(d.id)) { continue; }
    let name = d.id;
    for (let n = 2; names.has(name.toUpperCase()); n++) { name = d.id + "_" + n; }
    const p = d.properties || {};
    added.push({ name, connection: CONNECTION, destination: d.id, ...(p.client ? { client: p.client } : {}) });
    names.add(name.toUpperCase());
    taken.add(d.id);
  }
  if (!added.length) { vscode.window.showInformationMessage("VERTEX: the chosen connections are already in vertex.systems."); return; }
  await config.update("systems", [...existing, ...added], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("VERTEX: added " + added.map(s => s.name).join(", ")
    + " to vertex.systems, " + LABEL + ". Log on to them in SAP ADT extension before use; VERTEX: Test SAP Systems tells whether they are.");
}

/* The context key the command's menu entries are shown by: true while the SAP extension is installed. */
function trackInstalled(vscode, context) {
  const update = () => vscode.commands.executeCommand("setContext", "vertex.sapAdtExtension",
    !!find(vscode) || fs.existsSync(destinationsFile()));
  update();
  context.subscriptions.push(vscode.extensions.onDidChange(update));
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/* What VS Code does for the repository of such a system (sap-adt-extension-repository.js). A path is the list of
   folder names under the destination, as the extension's tree shows them.

   The extension's ways, found on its 1.1.2 and kept to here:
   - deep folders are known to it only once walked from the root: before that VS Code takes the folder of a file for
     missing, and a write tries to create it, which the extension cannot. A write walks the path first.
   - a write of a file that is open and unchanged is dropped by the extension without a word, so an open file is
     written through its document and saved.
   - checking and activating act on the active editor, and their findings come as the editor's diagnostics.
   - the active version is shown by toggling the editor's version, and toggled back. */
function host(vscode, destination, progress = () => {}) {
  const uri = segments => vscode.Uri.joinPath(rootUri(vscode, destination), ...segments.slice(1));
  const decode = bytes => Buffer.from(bytes).toString("utf8");
  const openDocument = target => vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString());
  async function walk(segments) {
    for (let i = 1; i < segments.length; i++) { await vscode.workspace.fs.readDirectory(uri(segments.slice(0, i))); }
  }
  async function show(segments) {
    const document = await vscode.workspace.openTextDocument(uri(segments));
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    return document;
  }
  // The extension saves every unsaved file of the object before it activates; none may be an edit the reader has not saved.
  function refuseUnsaved(segments) {
    const folder = uri(segments.slice(0, -1)).toString() + "/";
    const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.toString().startsWith(folder));
    if (dirty.length) {
      throw new Error("Unsaved changes in " + dirty.map(d => d.uri.path.split("/").pop()).join(", ")
        + " - SAP ADT extension would save them with this change. Save or revert them first.");
    }
  }
  return {
    progress,
    async readDirectory(segments) { return vscode.workspace.fs.readDirectory(uri(segments)); },
    async readFile(segments) { return decode(await vscode.workspace.fs.readFile(uri(segments))); },
    async write(segments, text) {
      refuseUnsaved(segments);
      await walk(segments);
      const target = uri(segments), document = openDocument(target);
      if (!document) { await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8")); return; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(target, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
        throw new Error("SAP ADT extension did not save " + segments.at(-1) + ".");
      }
    },
    async check(segments) {
      await show(segments);
      await vscode.commands.executeCommand("adt-vscode.checkObject");
      await pause(1000);
      return vscode.languages.getDiagnostics(uri(segments)).map(d => ({
        severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : d.severity === vscode.DiagnosticSeverity.Warning ? "warning" : "info",
        line: d.range.start.line + 1, message: d.message }));
    },
    async activate(segments) {
      refuseUnsaved(segments);
      await show(segments);
      await vscode.commands.executeCommand("adt-vscode.activate");
    },
    async activeText(segments) {
      const document = await show(segments), before = document.getText();
      await vscode.commands.executeCommand("adt-vscode.toggleVersion");
      await pause(1500);
      const active = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.getText() : "";
      await vscode.commands.executeCommand("adt-vscode.toggleVersion");
      await pause(1500);
      if (document.getText() !== before) { throw new Error("SAP ADT extension's editor did not come back to the inactive version of " + segments.at(-1) + "."); }
      return active;
    }
  };
}

module.exports = { host, EXTENSION_ID, CONNECTION, LABEL, viaExtension, find, destinations, destinationsFile, rootUri,
  httpRefusal, state, importConnections, trackInstalled };
