"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const http = require("http");

let selectorQuery;
function setSelectorQuery(query) { selectorQuery = query; }
function selectorSql(input) {
  if (!input || typeof input.select !== "string") throw new Error("Unsupported Open SQL request.");
  const sql = input.select.trim().replace(/~/g, ".")
    .replace(/"([A-Za-z_]\w*)"AS\b/gi, '"$1" AS')
    .replace(/"([A-Za-z_]\w*)"/g, "$1");
  if (!/^SELECT\s/i.test(sql) || /;|--|\/\*/.test(sql)) throw new Error("Unsupported Open SQL SELECT syntax.");
  return sql.replace(/\s+ORDER BY PRIMARY KEY\b/gi,
    input.primaryKey?.length ? " ORDER BY " + input.primaryKey.join(", ") : "")
    .replace(/\s+UP TO\s+\d+\s+ROWS\b/gi, "");
}
async function startSelectorBridge(query = selectorQuery) {
  if (!query) throw new Error("SAP SelecTor is unavailable in this VS Code window.");
  const token = crypto.randomBytes(24).toString("hex");
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/select" || request.headers.authorization !== "Bearer " + token) {
      response.writeHead(403).end(); return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error("SELECT request is too large.");
      }
      const input = JSON.parse(body);
      const limit = /\bUP TO\s+(\d+)\s+ROWS\b/i.exec(input.select || "");
      const sql = selectorSql(input);
      const data = await query(sql, limit ? Number(limit[1]) : 10000);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ rows: (data.values || []).map(row =>
        Object.fromEntries(Object.entries(row).map(([name, value]) => [name.toLowerCase(), value]))) }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { env: { VERTEX_SELECTOR_PORT: String(server.address().port), VERTEX_SELECTOR_TOKEN: token },
    close: () => server.close() };
}

function modulePath(root, name) { return path.join(root, "node_modules", ...name.split("/")); }
function scenariosFor(document) {
  return require("./value-origin-model").radioGroups([{ id: document.uri.fsPath, text: document.getText() }]);
}

function automaticInputFilter(file, inputRoot) {
  const candidates = new Map();
  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const location = path.join(dir, item.name);
      if (item.isDirectory()) scan(location);
      else if (/\.(?:(?:clas|intf)\.abap|(?:tabl|dtel|doma)\.xml)$/i.test(item.name)) {
        candidates.set(item.name.split(".")[0].toLowerCase(), location);
      }
    }
  }
  scan(inputRoot);
  const selected = new Set();
  function include(sourceFile) {
    if (selected.has(sourceFile)) return;
    selected.add(sourceFile);
    if (/\.(?:clas|intf|prog)\.abap$/i.test(sourceFile)) {
      const metadata = sourceFile.replace(/\.abap$/i, ".xml");
      if (fs.existsSync(metadata)) selected.add(metadata);
    }
    const source = fs.readFileSync(sourceFile, "utf8").replace(/^\s*\*.*$/gm, "");
    for (const [name, location] of candidates) {
      if (!selected.has(location) && new RegExp("\\b" + name + "\\b", "i").test(source)) include(location);
    }
  }
  include(file);
  const filters = [...selected].map(sourceFile => {
    const escaped = path.basename(sourceFile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return "(?:^|[/\\\\])" + escaped + "$";
  });
  const classes = [...selected].filter(sourceFile => /\.(?:clas|intf)\.abap$/i.test(sourceFile))
    .map(sourceFile => path.basename(sourceFile).replace(/\.(?:clas|intf)\.abap$/i, "").toUpperCase());
  return { filters, classes, files: [...selected] };
}

function coreDdicNames(core) {
  const names = new Set();
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else if (/\.dtel\.xml$/i.test(item.name)) names.add(item.name.replace(/\.dtel\.xml$/i, "").toUpperCase());
    }
  }
  if (fs.existsSync(path.join(core, "src", "ddic"))) visit(path.join(core, "src", "ddic"));
  return names;
}

function localDdicAliases(files, folder, known = new Set()) {
  const names = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bCHAR(\d{1,4})\b/gi)) names.add("CHAR" + Number(match[1]));
    for (const alias of ["XFELD", "WERTV8", "LAND1", "WAERS", "DATS", "MANDT", "INT4"]) {
      if (new RegExp("\\b" + alias + "\\b", "i").test(source)) names.add(alias);
    }
  }
  if (!names.size) return [];
  fs.mkdirSync(folder, { recursive: true });
  const created = [];
  for (const name of names) {
    if (known.has(name) || files.some(file => path.basename(file).toUpperCase() === name + ".DTEL.XML")) continue;
    const length = name.startsWith("CHAR") ? Number(name.slice(4)) :
      ({ XFELD: 1, LAND1: 3, WAERS: 5, WERTV8: 15, DATS: 8, MANDT: 3, INT4: 10 })[name];
    const datatype = name === "WERTV8" ? "CURR" : name === "DATS" ? "DATS" : name === "INT4" ? "INT4" : "CHAR";
    const decimals = name === "WERTV8" ? "<DECIMALS>2</DECIMALS>" : "";
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="LCL_OBJECT_DTEL" serializer_version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DD04V><ROLLNAME>${name}</ROLLNAME><DATATYPE>${datatype}</DATATYPE><LENG>${length}</LENG>${decimals}</DD04V></asx:values></asx:abap></abapGit>`;
    fs.writeFileSync(path.join(folder, name.toLowerCase() + ".dtel.xml"), xml);
    created.push(name);
  }
  return created;
}

async function flowClasses(file, inputRoot) {
  const classFiles = [];
  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const location = path.join(dir, item.name);
      if (item.isDirectory()) scan(location);
      else if (/\.(?:clas|intf)\.abap$/i.test(item.name)) classFiles.push(location);
    }
  }
  scan(inputRoot);
  const { createParser } = require("./value-origin-linter");
  const { buildIndex } = require("./value-origin-model");
  const { analysisUnits } = require("./frontend-analysis");
  const callGraph = require("./call-graph");
  const parser = createParser();
  try {
    const sources = [];
    for (const location of [file, ...classFiles]) {
      const filename = path.basename(location);
      const objectType = /\.clas\.abap$/i.test(filename) ? "CLAS" : /\.intf\.abap$/i.test(filename) ? "INTF" : "PROG";
      const source = { id: location, name: filename, objectName: filename.split(".")[0].toUpperCase(),
        objectType, text: fs.readFileSync(location, "utf8") };
      sources.push((await parser.parse(source)).source);
    }
    const index = buildIndex(sources), units = analysisUnits(index), graph = callGraph.create(index, units);
    const rootName = path.basename(file).split(".")[0].toUpperCase();
    const entries = units.filter(unit => unit.source.objectName === rootName && unit.unitType === "EVENT");
    const used = new Set();
    await callGraph.walk(entries, { calls: async (procedure, statement) => graph.calls(procedure, statement),
      onCall: (_procedure, _statement, record) => {
        for (const target of record.targets) if (["CLAS", "INTF"].includes(target.source.objectType))
          used.add(target.source.objectName);
      } });
    return [...used].sort();
  } finally { await parser.close(); }
}

async function prepareFlow(project, document, output) {
  if (!project.automatic) return;
  const config = JSON.parse(fs.readFileSync(project.configFile, "utf8"));
  const inputRoot = path.resolve(project.root,
    Array.isArray(config.input_folder) ? config.input_folder[0] : config.input_folder);
  try {
    const names = await flowClasses(document.uri.fsPath, inputRoot);
    const filenames = new Map();
    function scan(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const location = path.join(dir, item.name);
        if (item.isDirectory()) scan(location);
        else if (/\.(?:clas|intf)\.abap$/i.test(item.name)) filenames.set(item.name.split(".")[0].toUpperCase(), location);
      }
    }
    scan(inputRoot);
    for (const name of names) {
      const location = filenames.get(name);
      if (!location) continue;
      const dependency = automaticInputFilter(location, inputRoot);
      config.input_filter.push(...dependency.filters);
      project.includedClasses.push(...dependency.classes);
    }
    config.input_filter = [...new Set(config.input_filter)];
    project.includedClasses = [...new Set(project.includedClasses)].sort();
    fs.writeFileSync(project.configFile, JSON.stringify(config));
    output.appendLine("Flow classes: " + (names.join(", ") || "none"));
  } catch (error) { output.appendLine("Flow analysis unavailable: " + error.message); }
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
  const dependencyList = automaticInputFilter(file, path.join(root, input));
  const key = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const temporary = path.join(os.tmpdir(), "vertex-local-abap", key + "-" + process.pid);
  fs.mkdirSync(temporary, { recursive: true });
  const configFile = path.join(temporary, "abap_transpile.json");
  const outputFolder = path.join(temporary, "output");
  const core = path.join(__dirname, "vendor", "open-abap-core");
  const hasCore = fs.existsSync(path.join(core, "src"));
  const aliases = localDdicAliases(dependencyList.files, path.join(temporary, "ddic"),
    hasCore ? coreDdicNames(core) : new Set());
  const filters = dependencyList.filters.concat(aliases.map(name =>
    "(?:^|[/\\\\])" + name.toLowerCase() + "\\.dtel\\.xml$"));
  if (hasCore) filters.push("(?:^|[/\\\\])[^/\\\\]+\\.(?:dtel|doma)\\.xml$");
  const inputs = [input];
  if (hasCore) inputs.push(path.join(core, "src", "ddic"));
  if (aliases.length) inputs.push(path.join(temporary, "ddic"));
  fs.writeFileSync(configFile, JSON.stringify({ input_folder: inputs.length > 1 ? inputs : input,
    input_filter: filters, output_folder: outputFolder,
    write_unit_tests: true, write_source_map: true, options: { addFilenames: true } }));
  const cli = path.join(modulePath(__dirname, "@abaplint/transpiler-cli"), "abap_transpile");
  if (!fs.existsSync(cli)) throw new Error("The VERTEX transpiler is missing. Reinstall the VS Code extension.");
  return { root, configFile, cli, entry: path.join(outputFolder, "index.mjs"), automatic: true,
    includedClasses: dependencyList.classes };
}

function stageRuntime(project) {
  const outputRoot = path.dirname(project.entry);
  const visited = new Set();
  function stripMissingMaps(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const location = path.join(dir, item.name);
      if (item.isDirectory()) stripMissingMaps(location);
      else if (item.name.endsWith(".js")) {
        const contents = fs.readFileSync(location, "utf8");
        const cleaned = contents.replace(/^\/\/# sourceMappingURL=([^\r\n]+\.map)\r?$/gm,
          (line, mapName) => fs.existsSync(path.join(dir, mapName)) ? line : "");
        if (cleaned !== contents) fs.writeFileSync(location, cleaned);
      }
    }
  }
  function stage(name) {
    if (visited.has(name)) return;
    visited.add(name);
    if (fs.existsSync(modulePath(outputRoot, name))) return;
    const source = modulePath(__dirname, name);
    if (!fs.existsSync(source)) throw new Error("Bundled " + name + " is missing. Reinstall the VS Code extension.");
    const target = modulePath(outputRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
    if (name === "@abaplint/runtime") stripMissingMaps(target);
    const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys(metadata.dependencies || {})) stage(dependency);
  }
  stage("@abaplint/runtime");
}

function initializeSelectorDatabase(project) {
  const init = path.join(path.dirname(project.entry), "_init.mjs");
  if (!fs.existsSync(init)) return;
  const source = fs.readFileSync(init, "utf8");
  if (source.includes("VERTEX SAP SelecTor")) return;
  const anchor = "  const insert = [];";
  if (!source.includes(anchor)) return;
  const setup = "  // VERTEX SAP SelecTor\n" +
    "  const selectorPending = new Map(); let selectorNext = 0;\n" +
    "  if (process.env.VERTEX_SELECTOR_PIPE) {\n" +
    "    const readline = await import('node:readline');\n" +
    "    readline.createInterface({ input: process.stdin }).on('line', line => {\n" +
    "      try { const reply = JSON.parse(line); const pending = selectorPending.get(reply.id);\n" +
    "        if (pending) { selectorPending.delete(reply.id); reply.error ? pending.reject(new Error(reply.error)) : pending.resolve(reply.result); }\n" +
    "      } catch (_) {}\n" +
    "    });\n" +
    "  }\n" +
    "  abap.context.databaseConnections.DEFAULT = { async select(input) {\n" +
    "    if (process.env.VERTEX_SELECTOR_PIPE) return await new Promise((resolve, reject) => {\n" +
    "      const id = ++selectorNext; selectorPending.set(id, { resolve, reject });\n" +
    "      process.stdout.write('VERTEX_SELECTOR_REQUEST:' + JSON.stringify({ id, input }) + '\\n');\n" +
    "    });\n" +
    "    const port = process.env.VERTEX_SELECTOR_PORT;\n" +
    "    if (!port) throw new Error('SAP SelecTor is required for Open SQL SELECT.');\n" +
    "    const response = await fetch('http://127.0.0.1:' + port + '/select', { method: 'POST',\n" +
    "      headers: { authorization: 'Bearer ' + process.env.VERTEX_SELECTOR_TOKEN, 'content-type': 'application/json' },\n" +
    "      body: JSON.stringify(input) });\n" +
    "    const data = await response.json();\n" +
    "    if (!response.ok) throw new Error(data.error || 'SAP SelecTor SELECT failed.');\n" +
    "    return data;\n" +
    "  } };\n";
  fs.writeFileSync(init, source.replace(anchor, setup + anchor));
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

function repairInlineProgramDeclarations(source, lines) {
  const declarations = [];
  for (const match of source.matchAll(/\bDATA\s*\(\s*([A-Za-z_]\w*)\s*\)\s*=\s*([\s\S]*?)\./gi)) {
    const name = match[1].toLowerCase();
    if (lines.some(line => new RegExp("\\blet\\s+" + name + "\\s*=", "i").test(line))) continue;
    const rhs = match[2];
    const conditional = /^\s*COND\s+CHAR(\d+)\s*\(/i.exec(rhs);
    const method = /^\s*NEW\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*->\s*([A-Za-z_]\w*)/i.exec(rhs);
    if (conditional) {
      declarations.push("let " + name + " = new abap.types.Character(" + Number(conditional[1]) + ");");
    } else if (method) {
      declarations.push("let " + name + " = abap.Classes[" + JSON.stringify(method[1].toUpperCase()) +
        "].METHODS[" + JSON.stringify(method[2].toUpperCase()) +
        "].parameters && Object.values(abap.Classes[" + JSON.stringify(method[1].toUpperCase()) +
        "].METHODS[" + JSON.stringify(method[2].toUpperCase()) +
        "].parameters).find(p => p.parm_kind === 'R').type();");
    } else {
      throw new Error("The transpiler omitted inline declaration " + match[1] + "; its type could not be inferred safely.");
    }
  }
  if (declarations.length) lines[0] += " " + declarations.join(" ");
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
    repairInlineProgramDeclarations(source, lines);
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
  if (!groups.some(group => selection[group.group])) {
    const lines = fs.readFileSync(candidates[0], "utf8").split(/\r?\n/);
    repairInlineProgramDeclarations(source, lines);
    fs.writeFileSync(candidates[0], lines.join("\n"));
  }
  const wrapper = path.join(outputRoot, "vertex-local-entry.mjs");
  const relative = "./" + path.relative(outputRoot, candidates[0]).replaceAll("\\", "/");
  fs.writeFileSync(wrapper, "await import(" + JSON.stringify(relative) + ");\n" +
    "if (globalThis.abap?.console?.get) { const text = abap.console.get(); process.stdout.write(text + '\\n');" +
    " if (process.env.VERTEX_LOCAL_OUTPUT_FILE) (await import('node:fs')).writeFileSync(process.env.VERTEX_LOCAL_OUTPUT_FILE, text); }\n");
  return wrapper;
}

function debugConfiguration(project, entry, outputFile = "", bridgeEnv = {}) {
  return { type: "node", request: "launch", name: "VERTEX Local ABAP", program: entry,
    cwd: project.root, sourceMaps: true, smartStep: true, internalConsoleOptions: "neverOpen",
    outFiles: [path.dirname(project.entry) + "/**/*.mjs"],
    skipFiles: ["<node_internals>/**", "**/node_modules/**", "**/_init.mjs", "**/vertex-local-entry.mjs"],
    env: { ...bridgeEnv, ...(outputFile ? { VERTEX_LOCAL_OUTPUT_FILE: outputFile } : {}) } };
}

function repairSelectLoops(outputRoot) {
  let repaired = 0;
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { if (item.name !== "node_modules") visit(file); continue; }
      if (!item.name.endsWith(".mjs")) continue;
      const original = fs.readFileSync(file, "utf8");
      const fixed = original.replace(
        /(await abap\.statements\.select\((\w+), \{select: "SELECT ([\s\S]*?) FROM "[\s\S]*?\}\);\s*for \(const (\w+) of \2\.array\(\)\) \{\s*)(\w+)\.set\(\4\);/g,
        (all, prefix, table, columns, row, target) => {
          const declaration = new RegExp("\\blet " + target + " = new abap\\.types\\.(\\w+)\\b").exec(original);
          if (!declaration) return all;
          if (declaration[1] === "Structure") {
            repaired++;
            return prefix + "abap.statements.moveCorresponding(" + row + ", " + target + ");";
          }
          const column = /^\\?"(\w+)\\?"$/.exec(columns);
          if (!column) return all;
          repaired++;
          return prefix + target + ".set(" + row + ".get()." + column[1].toLowerCase() + ");";
        });
      if (fixed !== original) fs.writeFileSync(file, fixed);
    }
  }
  visit(outputRoot);
  return repaired;
}

async function launch(vscode, debug, options = {}) {
  const document = options.document || vscode.window.activeTextEditor?.document;
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document?.uri)?.uri.fsPath;
  const project = projectFor(document, workspaceRoot);
  if (document.isDirty) await document.save();
  const output = vscode.window.createOutputChannel("VERTEX Local ABAP");
  output.appendLine("Transpiling " + project.root);
  try {
    await prepareFlow(project, document, output);
    if (project.automatic) output.appendLine("Included classes/interfaces: " +
      (project.includedClasses.length ? project.includedClasses.join(", ") : "none"));
    await transpile(project, output);
    output.appendLine("Transpilation complete; staging runtime.");
    stageRuntime(project);
    output.appendLine("Runtime staged; preparing local execution.");
    initializeSelectorDatabase(project);
    output.hide?.();
  } catch (error) {
    output.show(true);
    throw error;
  }
  const selection = { ...(options.selection || {}) };
  if (!options.selection) for (const group of scenariosFor(document)) {
    const choices = group.choices.map(choice => ({ label: choice.name, description: choice.name === group.default ? "default" : "" }));
    const picked = await vscode.window.showQuickPick(choices, { title: "Local ABAP · radio group " + group.group, placeHolder: "Choose the value for this run" });
    if (!picked) return;
    selection[group.group] = picked.label;
  }
  const entry = entryFor(project, document, selection);
  const repairedSelects = repairSelectLoops(path.dirname(project.entry));
  if (repairedSelects) output.appendLine("Repaired " + repairedSelects + " SELECT work-area assignments.");
  output.appendLine("Entry ready.");
  const bridge = !options.trace && !options.live && project.automatic && selectorQuery ? await startSelectorBridge() : null;
  if (options.trace || options.live) {
    const outputRoot = path.dirname(project.entry);
    const traceFile = path.join(outputRoot, "vertex-local-trace.json");
    const instrumented = require("./local-trace").instrumentProject(outputRoot, !!options.live);
    if (!instrumented) throw new Error("No generated ABAP source maps were found for tracing.");
    output.appendLine("Instrumented " + instrumented + " ABAP modules.");
    const traceEntry = require("./local-trace").traceBootstrap(outputRoot, entry, traceFile, !!options.live);
    output.appendLine("Trace ready; executing.");
    if (options.live) {
      const child = spawn(process.execPath, [traceEntry], { cwd: project.root, windowsHide: true,
        env: { ...process.env, VERTEX_SELECTOR_PIPE: "1" } });
      const records = []; let pending = null, initial, firstResolve, firstReject, closed = false;
      let stdout = "", stderr = "", buffer = "";
      const first = new Promise((resolve, reject) => { firstResolve = resolve; firstReject = reject; });
      const fail = error => {
        if (initial === undefined) firstReject(error);
        if (pending) { pending.reject(error); pending = null; }
        output.appendLine(error.message); output.show(true);
      };
      const resume = () => { if (!closed) child.stdin.write('{"vertexTrace":"resume"}\n'); };
      child.stdout.on("data", chunk => {
        buffer += chunk.toString(); let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
          // WRITE leaves its text without a newline, so a record can follow program output on the same line.
          const recordAt = line.indexOf("VERTEX_TRACE_RECORD:");
          if (recordAt >= 0) {
            stdout += line.slice(0, recordAt);
            const record = JSON.parse(line.slice(recordAt + "VERTEX_TRACE_RECORD:".length)); records.push(record);
            if (initial === undefined) { initial = record; firstResolve(record); }
            else if (pending) {
              pending.records.push(record);
              const depth = record.stack?.length || 1;
              const hit = pending.breakpoints.some(bp => bp.active && bp.line === record.line &&
                bp.url.toLowerCase() === record.file.toLowerCase());
              const stop = pending.kind === "into" || pending.kind === "continue" && hit ||
                pending.kind === "over" && depth <= pending.depth || pending.kind === "out" && depth < pending.depth;
              if (stop) { const done = pending; pending = null; done.resolve({ records: done.records, ended: false }); }
              else resume();
            }
            continue;
          }
          const marker = line.indexOf("VERTEX_SELECTOR_REQUEST:");
          if (marker >= 0) {
            stdout += line.slice(0, marker);
            const requestText = line.slice(marker + "VERTEX_SELECTOR_REQUEST:".length);
            Promise.resolve().then(async () => {
              const request = JSON.parse(requestText);
              if (!selectorQuery) throw new Error("Configure and select an SAP system for Open SQL SELECT.");
              const input = request.input, limit = /\bUP TO\s+(\d+)\s+ROWS\b/i.exec(input.select || "");
              const data = await selectorQuery(selectorSql(input), limit ? Number(limit[1]) : 10000);
              return { id: request.id, result: { rows: (data.values || []).map(row =>
                Object.fromEntries(Object.entries(row).map(([name, value]) => [name.toLowerCase(), value]))) } };
            }).then(reply => child.stdin.write(JSON.stringify(reply) + "\n"), error => {
              // The program gets the failure as an empty result, so the reason is said where the reader looks: the
              // output of the run and the VERTEX Local ABAP channel.
              const said = "[VERTEX] SELECT failed: " + error.message;
              stdout += "\n" + said + "\n"; output.appendLine(said); output.show(true);
              child.stdin.write(JSON.stringify({ id: JSON.parse(requestText).id, error: error.message }) + "\n");
            });
          } else stdout += line + "\n";
        }
      });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", fail);
      child.on("close", code => {
        closed = true; bridge?.close();
        // The last WRITE ends without a line break: what is left in the buffer is output too.
        if (buffer) { const at = buffer.indexOf("VERTEX_TRACE_RECORD:"); stdout += at >= 0 ? buffer.slice(0, at) : buffer; buffer = ""; }
        if (code !== 0) { fail(new Error(stderr || "Local ABAP exited with code " + code)); return; }
        if (initial === undefined) firstReject(new Error("Local ABAP completed without a recorded statement."));
        if (pending) { const done = pending; pending = null; done.resolve({ records: done.records, ended: true }); }
      });
      await first;
      return { records: [initial], live: {
        next(kind, breakpoints = []) {
          if (closed) return Promise.resolve({ records: [], ended: true });
          if (pending) return Promise.reject(new Error("A local step is already running."));
          return new Promise((resolve, reject) => {
            pending = { resolve, reject, records: [], kind, breakpoints,
              depth: records.at(-1)?.stack?.length || 1 };
            resume();
          });
        }, stop() { if (!closed) child.kill(); }, get output() { return stdout; }
      } };
    }
    try {
      const startedAt = Date.now();
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [traceEntry], { cwd: project.root, windowsHide: true,
          env: { ...process.env, VERTEX_SELECTOR_PIPE: "1" } });
        let stdout = "", stderr = "", pending = "";
        child.stdout.on("data", chunk => {
          pending += chunk.toString();
          let end;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1);
            const marker = line.indexOf("VERTEX_SELECTOR_REQUEST:");
            if (marker < 0) { stdout += line + "\n"; continue; }
            stdout += line.slice(0, marker);
            const requestText = line.slice(marker + "VERTEX_SELECTOR_REQUEST:".length);
            Promise.resolve().then(async () => {
              const request = JSON.parse(requestText);
              if (!selectorQuery) throw new Error("Configure and select an SAP system for Open SQL SELECT.");
              const input = request.input, limit = /\bUP TO\s+(\d+)\s+ROWS\b/i.exec(input.select || "");
              const data = await selectorQuery(selectorSql(input), limit ? Number(limit[1]) : 10000);
              return { id: request.id, result: { rows: (data.values || []).map(row =>
                Object.fromEntries(Object.entries(row).map(([name, value]) => [name.toLowerCase(), value]))) } };
            }).then(reply => child.stdin.write(JSON.stringify(reply) + "\n"), error => {
              const request = JSON.parse(requestText);
              child.stdin.write(JSON.stringify({ id: request.id, error: error.message }) + "\n");
            });
          }
        });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve({ stdout: stdout + pending, stderr }) : reject(new Error(stderr || "Local ABAP exited with code " + code)));
      });
      return { records: JSON.parse(fs.readFileSync(traceFile, "utf8")), output: result.stdout,
        durationMs: Date.now() - startedAt };
    } finally { bridge?.close(); }
  }
  if (debug) {
    const outputFile = options.onOutput ? path.join(path.dirname(project.entry), "vertex-local-result.txt") : "";
    if (outputFile) fs.rmSync(outputFile, { force: true });
    if (outputFile) {
      const subscription = vscode.debug.onDidTerminateDebugSession(session => {
        if (session.name !== "VERTEX Local ABAP") return;
        if (fs.existsSync(outputFile)) options.onOutput(fs.readFileSync(outputFile, "utf8") + "\n");
        bridge?.close();
        subscription.dispose();
      });
    }
    const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri),
      debugConfiguration(project, entry, outputFile, bridge?.env));
    if (!started) { bridge?.close(); throw new Error("The VS Code Node debugger could not start."); }
    if (!outputFile && bridge) vscode.debug.onDidTerminateDebugSession(session => {
      if (session.name === "VERTEX Local ABAP") bridge.close();
    });
    await vscode.commands?.executeCommand("workbench.view.explorer");
  } else {
    if (options.onOutput || bridge) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry], { cwd: project.root, windowsHide: true,
          env: { ...process.env, ...bridge?.env } });
        child.stdout.on("data", chunk => options.onOutput ? options.onOutput(chunk.toString()) : output.append(chunk.toString()));
        child.stderr.on("data", chunk => options.onOutput ? options.onOutput(chunk.toString()) : output.append(chunk.toString()));
        child.on("error", reject);
        child.on("close", code => { bridge?.close(); code === 0 ? resolve() : reject(new Error("Local ABAP exited with code " + code + ".")); });
      });
      if (!options.onOutput) output.show(true);
      return;
    }
    const terminal = vscode.window.createTerminal({ name: "VERTEX Local ABAP", cwd: project.root });
    terminal.show();
    bridge?.close();
    terminal.sendText('node "' + entry.replaceAll('"', '""') + '"');
  }
}

function register(vscode, context) {
  for (const [command, debug] of [["vertex.localRun", false], ["vertex.localDebug", true]]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      try { if (debug) await vscode.commands.executeCommand("vertex.openVisualDebug");
        else await launch(vscode, false); }
      catch (error) { vscode.window.showErrorMessage("VERTEX Local ABAP: " + error.message); }
    }));
  }
}

module.exports = { projectFor, scenariosFor, transpile, stageRuntime, initializeSelectorDatabase, startSelectorBridge,
  selectorSql, setSelectorQuery, entryFor, debugConfiguration,
  flowClasses, prepareFlow, repairSelectLoops, launch, register };
