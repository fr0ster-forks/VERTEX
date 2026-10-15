"use strict";
/* A program of an SAP system run with the ABAP transpiler: its active source and every customer class, interface and
   include it names, read through ADT, written as an abapGit folder with its own abap_transpile.json. Whatever cannot
   be read stops the run: a missing dependency is never left out of it. Function modules are not read
   yet, and a program that calls one is refused by name; a name after REF TO that is no class or interface is left to
   the dictionary (sap-ddic.js). The transpiler writes a program's INCLUDE as a comment and runs
   on without it, so the program is given to it with its includes written in, and the map of what it made is pointed
   back at the program and the includes as SAP holds them: a step into an include stands in the include. */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { tokenize } = require("./value-origin-tokens");
const { customerObject } = require("./value-origin-model");

const up = value => String(value || "").toUpperCase();
// The class includes a run needs; test classes are not run.
const CLASS_PARTS = { definitions: "locals_def", implementations: "locals_imp", macros: "macros" };

/* The objects a source names, with the kind the name stands for there. A name after TYPE alone may be a class or a
   DDIC type, and is left to the transpiler, which reports what it cannot resolve. */
function namedObjects(text) {
  const tokens = tokenize(text), found = new Map(), functions = new Set();
  const word = i => tokens[i] && tokens[i].kind === "word" ? up(tokens[i].value) : "";
  const at = i => up(tokens[i] && tokens[i].value);
  for (let i = 0; i < tokens.length; i++) {
    const current = at(i);
    if (current === "NEW" && word(i + 1)) found.set(word(i + 1), "CLAS");
    if (tokens[i].kind === "word" && at(i + 1) === "=>") found.set(current, "CLAS");
    if (current === "INTERFACES" && word(i + 1)) found.set(word(i + 1), "INTF");
    // REF TO names a class, an interface or a dictionary type: "REF" is tried as a class, then left to the dictionary.
    if (current === "REF" && at(i + 1) === "TO" && word(i + 2) && !found.has(word(i + 2))) found.set(word(i + 2), "REF");
    if (current === "INHERITING" && at(i + 1) === "FROM" && word(i + 2)) found.set(word(i + 2), "CLAS");
    if (current === "CAST" && word(i + 1)) found.set(word(i + 1), "CLAS");
    if (current === "RAISING" || current === "CATCH") {
      for (let j = i + 1; word(j) && !["INTO", "RESUMABLE", "BEFORE"].includes(word(j)); j++) found.set(word(j), "CLAS");
    }
    if (current === "INCLUDE" && word(i + 1) && !["TYPE", "STRUCTURE"].includes(word(i + 1))) found.set(word(i + 1), "INCL");
    if (current === "CALL" && at(i + 1) === "FUNCTION" && tokens[i + 2] && tokens[i + 2].kind === "literal")
      functions.add(up(tokens[i + 2].value.slice(1, -1)));
  }
  for (const name of [...found.keys()]) if (!customerObject(name)) found.delete(name);
  return { objects: found, functions: [...functions].filter(customerObject) };
}

/* Every source of the run, read with read({ object_name, object_type, include }) - ADT's active version. */
async function collect(read, root, { progress = () => {}, cancelled = () => false } = {}) {
  const loaded = [], seen = new Set([up(root.name)]), queue = [{ name: up(root.name), type: up(root.type) }];
  const take = (owner, text) => {
    const named = namedObjects(text);
    if (named.functions.length) throw new Error(owner + " calls function module " + named.functions.join(", ") +
      ": function modules are not read for a transpiler run yet.");
    for (const [name, type] of named.objects) if (!seen.has(name)) { seen.add(name); queue.push({ name, type }); }
  };
  while (queue.length) {
    if (cancelled()) throw new Error("Transpiler run cancelled.");
    const next = queue.shift();
    progress(next.name);
    let data;
    const asClass = next.type === "REF" ? "CLAS" : next.type;
    try { data = await read({ object_name: next.name, object_type: asClass }); }
    catch (error) {
      if (asClass !== "CLAS" || !/was not found/.test(error.message)) throw new Error(next.name + ": " + error.message);
      try { data = await read({ object_name: next.name, object_type: "INTF" }); }
      catch (second) {
        if (next.type === "REF" && /was not found/.test(second.message)) continue;
        throw new Error(next.name + " is neither a class nor an interface in SAP (" + second.message + ").");
      }
    }
    const type = up(data.object_type);
    const text = data.source;
    loaded.push({ name: next.name, type, include: "main", text });
    take(next.name, text);
    if (type === "CLAS") for (const include of Object.keys(CLASS_PARTS)) {
      if (!(data.includes || []).includes(include)) continue;
      let part;
      try { part = await read({ object_name: next.name, object_type: "CLAS", include }); }
      catch (error) { throw new Error(next.name + "." + include + ": " + error.message); }
      loaded.push({ name: next.name, type, include, text: part.source });
      take(next.name, part.source);
    }
  }
  return loaded;
}

/* abapGit's file name of an object: lower case, a namespace's slashes as #. */
function fileName(name, type, include = "main") {
  const base = name.toLowerCase().replace(/\//g, "#");
  if (type === "CLAS") return base + ".clas." + (include === "main" ? "" : CLASS_PARTS[include] + ".") + "abap";
  if (type === "INTF") return base + ".intf.abap";
  return base + ".prog.abap";
}

const progXml = (name, kind) => `<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="LCL_OBJECT_PROG" serializer_version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><PROGDIR><NAME>${name}</NAME><SUBC>${kind}</SUBC></PROGDIR></asx:values></asx:abap></abapGit>\n`;

/* A program with its INCLUDEs written in, as SAP compiles it: its lines, and for each the file and line it comes from
   (an index into files, a 1-based line). An INCLUDE statement must stand on lines of its own; an include met again
   inside itself is refused. */
function expandIncludes(name, texts) {
  const files = [], lines = [], places = [];
  const put = (current, chain) => {
    const text = texts.get(current);
    if (text == null) throw new Error("Include " + current + " was not read.");
    if (chain.includes(current)) throw new Error("Include " + current + " includes itself: " + chain.concat(current).join(" > ") + ".");
    const index = files.push(current) - 1, own = text.split(/\r?\n/), tokens = tokenize(text), statements = new Map();
    for (let i = 0; i < tokens.length; i++) {
      const next = tokens[i + 1];
      if (up(tokens[i].value) !== "INCLUDE" || !next || next.kind !== "word" || ["TYPE", "STRUCTURE"].includes(up(next.value))) continue;
      if (i > 0 && tokens[i - 1].line === tokens[i].line) {
        throw new Error(current + " line " + tokens[i].line + ": an INCLUDE shares its line with another statement.");
      }
      let end = i;
      while (tokens[end] && tokens[end].value !== ".") end++;
      if (!tokens[end]) throw new Error(current + " line " + tokens[i].line + ": INCLUDE without its period.");
      if (tokens[end + 1] && tokens[end + 1].line === tokens[end].line) {
        throw new Error(current + " line " + tokens[end].line + ": an INCLUDE shares its line with another statement.");
      }
      statements.set(tokens[i].line, { last: tokens[end].line, include: up(next.value) });
    }
    for (let line = 1; line <= own.length; line++) {
      const statement = statements.get(line);
      if (!statement) { lines.push(own[line - 1]); places.push([index, line]); continue; }
      put(statement.include, chain.concat(current));
      line = statement.last;
    }
  };
  put(up(name), []);
  return { files, lines, places };
}

/* The folder of a run, written fresh. src holds what the transpiler reads: the classes and interfaces, the dictionary
   objects as abapGit XML, and each program with its includes written in. sap holds the programs and includes as SAP holds them, which the reader opens, steps
   through and sets breakpoints in; vertex-includes.json says which line of a written-in program is which line there.
   The program run is returned; the transpiler's project is found from it. */
function writeProject(system, sources, dictionary = [], folder = path.join(os.tmpdir(), "vertex-sap-abap",
  String(system || "SAP").replace(/[^A-Za-z0-9_-]/g, "_") + "-" + process.pid)) {
  fs.rmSync(folder, { recursive: true, force: true });
  const src = path.join(folder, "src"), sap = path.join(folder, "sap");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(sap, { recursive: true });
  const written = [], programs = [], texts = new Map();
  let shown = null;
  for (const source of sources) {
    if (source.type === "PROG" || source.type === "INCL") {
      const file = path.join(sap, fileName(source.name, "PROG"));
      fs.writeFileSync(file, source.text);
      texts.set(source.name, source.text);
      if (source.type === "PROG") programs.push(source.name);
      if (!shown) shown = file;
      continue;
    }
    const file = path.join(src, fileName(source.name, source.type, source.include));
    fs.writeFileSync(file, source.text);
    written.push(file);
  }
  const maps = [];
  for (const name of programs) {
    const expanded = expandIncludes(name, texts), file = path.join(src, fileName(name, "PROG"));
    fs.writeFileSync(file, expanded.lines.join("\n"));
    fs.writeFileSync(file.replace(/\.abap$/, ".xml"), progXml(name, "1"));
    written.push(file, file.replace(/\.abap$/, ".xml"));
    maps.push({ program: path.basename(file), files: expanded.files.map(include => path.join(sap, fileName(include, "PROG"))),
      places: expanded.places });
  }
  fs.writeFileSync(path.join(folder, "vertex-includes.json"), JSON.stringify(maps));
  for (const object of dictionary) {
    const { file, xml } = require("./sap-ddic").objectXml(object);
    fs.writeFileSync(path.join(src, file), xml);
    written.push(path.join(src, file));
  }
  const core = path.join(__dirname, "vendor", "open-abap-core", "src", "ddic");
  const inputs = ["src"], filters = written.map(file =>
    "(?:^|[/\\\\])" + path.basename(file).replace(/[.*+?^${}()|[\]\\#]/g, "\\$&") + "$");
  if (fs.existsSync(core)) { inputs.push(core); filters.push("(?:^|[/\\\\])[^/\\\\]+\\.(?:dtel|doma)\\.xml$"); }
  // Data elements such as CHAR12 that open-abap-core lacks, made as a local file's run makes them.
  const { localDdicAliases, coreDdicNames } = require("./local-run");
  const aliases = localDdicAliases(written, path.join(folder, "ddic"),
    fs.existsSync(core) ? coreDdicNames(path.dirname(path.dirname(core))) : new Set());
  if (aliases.length) {
    inputs.push("ddic");
    filters.push(...aliases.map(name => "(?:^|[/\\\\])" + name.toLowerCase() + "\\.dtel\\.xml$"));
  }
  fs.writeFileSync(path.join(folder, "abap_transpile.json"), JSON.stringify({ input_folder: inputs, input_filter: filters,
    output_folder: "output", write_unit_tests: true, write_source_map: true, options: { addFilenames: true, addCommonJS: true } }));
  return shown || written[0];
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeVlq(segment) {
  const values = [];
  let value = 0, shift = 0;
  for (const letter of segment) {
    const digit = BASE64.indexOf(letter);
    if (digit < 0) throw new Error("Invalid source map mapping.");
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) shift += 5;
    else { values.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0; }
  }
  return values;
}
function encodeVlq(values) {
  let text = "";
  for (const number of values) {
    let value = number < 0 ? (-number << 1) | 1 : number << 1;
    do { let digit = value & 31; value >>>= 5; if (value) digit |= 32; text += BASE64[digit]; } while (value);
  }
  return text;
}

/* After the transpiler: the map of each written-in program pointed at the program and its includes in sap, so a step,
   a breakpoint and the record stand in the file the line came from. A mapped line with no place is an error. */
function remapIncludes(root, outputRoot) {
  const maps = JSON.parse(fs.readFileSync(path.join(root, "vertex-includes.json"), "utf8"));
  const generated = new Map();
  const visit = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, item.name);
    if (item.isDirectory()) { if (item.name !== "node_modules") visit(at); }
    else if (item.name.endsWith(".mjs.map")) generated.set(item.name.toLowerCase(), at);
  } };
  visit(outputRoot);
  for (const spec of maps) {
    const file = generated.get(spec.program.replace(/\.abap$/i, ".mjs.map").toLowerCase());
    if (!file) throw new Error("The transpiler wrote no map for " + spec.program + ".");
    const map = JSON.parse(fs.readFileSync(file, "utf8"));
    if ((map.sources || []).length !== 1) throw new Error(spec.program + ": its map has " + (map.sources || []).length + " sources, not one.");
    let source = 0, line = 0, column = 0, outSource = 0, outLine = 0, outColumn = 0;
    map.mappings = map.mappings.split(";").map(row => {
      let generatedColumn = 0;
      return row.split(",").filter(Boolean).map(segment => {
        const fields = decodeVlq(segment);
        generatedColumn += fields[0];
        if (fields.length < 4) return encodeVlq([fields[0]]);
        source += fields[1]; line += fields[2]; column += fields[3];
        const place = spec.places[line];
        if (!place) throw new Error(spec.program + ": generated code maps to line " + (line + 1) + ", which the program written in does not have.");
        const out = [fields[0], place[0] - outSource, place[1] - 1 - outLine, column - outColumn];
        outSource = place[0]; outLine = place[1] - 1; outColumn = column;
        if (fields.length >= 5) out.push(fields[4]);
        return encodeVlq(out);
      }).join(",");
    }).join(";");
    map.sources = spec.files;
    delete map.sourcesContent;
    fs.writeFileSync(file, JSON.stringify(map));
  }
}

module.exports = { namedObjects, collect, fileName, expandIncludes, writeProject, remapIncludes };
