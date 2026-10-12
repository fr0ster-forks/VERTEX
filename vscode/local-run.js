"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

function modulePath(root, name) { return path.join(root, "node_modules", ...name.split("/")); }
function scenariosFor(document) {
  return require("./value-origin-model").radioGroups([{ id: document.uri.fsPath, text: document.getText() }]);
}

function projectFor(document, workspaceRoot) {
  if (!document || document.uri.scheme !== "file" || !/\.abap$/i.test(document.uri.fsPath)) {
    throw new Error("Open a saved local .abap file first.");
  }
  let dir = path.dirname(document.uri.fsPath);
  while (true) {
    const configFile = path.join(dir, "abap_transpile.json");
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (!config.output_folder || typeof config.output_folder !== "string") {
        throw new Error("abap_transpile.json needs an output_folder.");
      }
      if (config.write_source_map !== true) {
        throw new Error("Set write_source_map to true in abap_transpile.json for ABAP source debugging.");
      }
      const localCli = path.join(modulePath(dir, "@abaplint/transpiler-cli"), "abap_transpile");
      const bundledCli = path.join(modulePath(__dirname, "@abaplint/transpiler-cli"), "abap_transpile");
      const cli = fs.existsSync(localCli) ? localCli : bundledCli;
      if (!fs.existsSync(cli)) {
        throw new Error("The VERTEX transpiler is missing. Reinstall the VS Code extension.");
      }
      return { root: dir, configFile, cli, entry: path.resolve(dir, config.output_folder, "index.mjs") };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const file = path.resolve(document.uri.fsPath);
  const workspace = workspaceRoot && path.resolve(workspaceRoot);
  const insideWorkspace = workspace && (file === workspace || file.startsWith(workspace + path.sep));
  const parent = path.dirname(file);
  const root = insideWorkspace ? workspace : path.basename(parent).toLowerCase() === "src" ? path.dirname(parent) : parent;
  const input = fs.existsSync(path.join(root, "src")) && file.startsWith(path.join(root, "src") + path.sep) ? "src" : ".";
  const key = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const temporary = path.join(os.tmpdir(), "vertex-local-abap", key + "-" + process.pid);
  fs.mkdirSync(temporary, { recursive: true });
  const configFile = path.join(temporary, "abap_transpile.json");
  const outputFolder = path.join(temporary, "output");
  fs.writeFileSync(configFile, JSON.stringify({ input_folder: input, input_filter: [], output_folder: outputFolder,
    write_unit_tests: true, write_source_map: true, options: { addFilenames: true } }));
  const cli = path.join(modulePath(__dirname, "@abaplint/transpiler-cli"), "abap_transpile");
  if (!fs.existsSync(cli)) throw new Error("The VERTEX transpiler is missing. Reinstall the VS Code extension.");
  return { root, configFile, cli, entry: path.join(outputFolder, "index.mjs"), automatic: true };
}

function stageRuntime(project) {
  const outputRoot = path.dirname(project.entry);
  const visited = new Set();
  function stage(name) {
    if (visited.has(name)) return;
    visited.add(name);
    if (fs.existsSync(modulePath(project.root, name))) return;
    const source = modulePath(__dirname, name);
    if (!fs.existsSync(source)) throw new Error("Bundled " + name + " is missing. Reinstall the VS Code extension.");
    const target = modulePath(outputRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
    const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys(metadata.dependencies || {})) stage(dependency);
  }
  stage("@abaplint/runtime");
}

function transpile(project, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [project.cli, project.configFile], { cwd: project.root, windowsHide: true });
    child.stdout.on("data", chunk => output.append(chunk.toString()));
    child.stderr.on("data", chunk => output.append(chunk.toString()));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("ABAP transpilation failed (exit " + code + "). See VERTEX Local ABAP output.")));
  });
}

function entryFor(project, document, selection = {}) {
  const filename = path.basename(document.uri.fsPath);
  const source = document.getText();
  const isProgram = /\.prog\.abap$/i.test(filename) || /^\s*(?:REPORT|PROGRAM)\s+/im.test(source);
  if (!isProgram) {
    if (!fs.existsSync(project.entry)) {
      throw new Error("No ABAP Unit entry point was generated. Set write_unit_tests to true and add a test class.");
    }
    return project.entry;
  }
  const outputRoot = path.dirname(project.entry);
  const generatedName = filename.replace(/\.abap$/i, ".mjs");
  const candidates = [];
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const itemPath = path.join(dir, item.name);
      if (item.isDirectory()) visit(itemPath);
      else if (item.name.toLowerCase() === generatedName.toLowerCase()) candidates.push(itemPath);
    }
  }
  visit(outputRoot);
  if (candidates.length !== 1) {
    throw new Error("Expected one generated program for " + filename + "; found " + candidates.length + ".");
  }
  const groups = scenariosFor(document);
  if (groups.some(group => selection[group.group])) {
    const lines = fs.readFileSync(candidates[0], "utf8").split(/\r?\n/);
    let anchor = -1, lastName = "";
    for (const group of groups) for (const choice of group.choices) {
      const name = choice.name.toLowerCase();
      const index = lines.findIndex(line => line.trimStart().startsWith("let " + name + " = "));
      if (index < 0) throw new Error("Generated parameter " + choice.name + " was not found.");
      if (index > anchor) { anchor = index; lastName = name; }
    }
    while (lines[anchor + 1]?.trimStart().startsWith(lastName + ".set(")) anchor++;
    const assignments = [];
    for (const group of groups) {
      const selected = selection[group.group] || group.default || group.choices[0]?.name;
      if (!group.choices.some(choice => choice.name === selected)) throw new Error("Unknown choice for radio group " + group.group + ".");
      for (const choice of group.choices) {
        assignments.push(choice.name.toLowerCase() + ".set(abap.CharacterFactory.get(1," + JSON.stringify(choice.name === selected ? "X" : "") + "));" );
      }
    }
    lines[anchor] += assignments.join("");
    fs.writeFileSync(candidates[0], lines.join("\n"));
  }
  const wrapper = path.join(outputRoot, "vertex-local-entry.mjs");
  const relative = "./" + path.relative(outputRoot, candidates[0]).replaceAll("\\", "/");
  fs.writeFileSync(wrapper, "await import(" + JSON.stringify(relative) + ");\n" +
    "if (globalThis.abap?.console?.get) { const text = abap.console.get(); process.stdout.write(text + '\\n');" +
    " if (process.env.VERTEX_LOCAL_OUTPUT_FILE) (await import('node:fs')).writeFileSync(process.env.VERTEX_LOCAL_OUTPUT_FILE, text); }\n");
  return wrapper;
}

async function launch(vscode, debug, options = {}) {
  const document = options.document || vscode.window.activeTextEditor?.document;
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document?.uri)?.uri.fsPath;
  const project = projectFor(document, workspaceRoot);
  if (document.isDirty) await document.save();
  const output = vscode.window.createOutputChannel("VERTEX Local ABAP");
  output.show(true);
  output.appendLine("Transpiling " + project.root);
  await transpile(project, output);
  stageRuntime(project);
  const selection = { ...(options.selection || {}) };
  if (!options.selection) for (const group of scenariosFor(document)) {
    const choices = group.choices.map(choice => ({ label: choice.name, description: choice.name === group.default ? "default" : "" }));
    const picked = await vscode.window.showQuickPick(choices, { title: "Local ABAP · radio group " + group.group, placeHolder: "Choose the value for this run" });
    if (!picked) return;
    selection[group.group] = picked.label;
  }
  const entry = entryFor(project, document, selection);
  if (debug) {
    const outputFile = options.onOutput ? path.join(path.dirname(project.entry), "vertex-local-result.txt") : "";
    if (outputFile) fs.rmSync(outputFile, { force: true });
    if (outputFile) {
      const subscription = vscode.debug.onDidTerminateDebugSession(session => {
        if (session.name !== "VERTEX Local ABAP") return;
        if (fs.existsSync(outputFile)) options.onOutput(fs.readFileSync(outputFile, "utf8") + "\n");
        subscription.dispose();
      });
    }
    const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), {
      type: "node", request: "launch", name: "VERTEX Local ABAP", program: entry,
      cwd: project.root, sourceMaps: true, outFiles: [path.dirname(project.entry) + "/**/*.mjs"],
      skipFiles: ["<node_internals>/**"], env: outputFile ? { VERTEX_LOCAL_OUTPUT_FILE: outputFile } : undefined
    });
    if (!started) throw new Error("The VS Code Node debugger could not start.");
  } else {
    if (options.onOutput) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry], { cwd: project.root, windowsHide: true });
        child.stdout.on("data", chunk => options.onOutput(chunk.toString()));
        child.stderr.on("data", chunk => options.onOutput(chunk.toString()));
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error("Local ABAP exited with code " + code + ".")));
      });
      return;
    }
    const terminal = vscode.window.createTerminal({ name: "VERTEX Local ABAP", cwd: project.root });
    terminal.show();
    terminal.sendText('node "' + entry.replaceAll('"', '""') + '"');
  }
}

function register(vscode, context) {
  for (const [command, debug] of [["vertex.localRun", false], ["vertex.localDebug", true]]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      try { await launch(vscode, debug); }
      catch (error) { vscode.window.showErrorMessage("VERTEX Local ABAP: " + error.message); }
    }));
  }
}

module.exports = { projectFor, scenariosFor, transpile, stageRuntime, entryFor, launch, register };
