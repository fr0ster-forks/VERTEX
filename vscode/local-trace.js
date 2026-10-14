"use strict";

const fs = require("fs");
const path = require("path");

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(segment) {
  const result = [];
  let value = 0, shift = 0;
  for (const letter of segment) {
    const digit = alphabet.indexOf(letter);
    if (digit < 0) throw new Error("Invalid source map mapping.");
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) shift += 5;
    else { result.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0; }
  }
  return result;
}
function mappedLines(map) {
  let source = 0, original = 0;
  return map.mappings.split(";").map(line => {
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields = vlq(segment);
      if (fields.length >= 4) { source += fields[1]; original += fields[2]; return source === 0 ? original + 1 : 0; }
    }
    return 0;
  });
}
/* Each generated line's place: [source index, 1-based line], or null. A function group's module maps several
   sources - its includes and its modules - into one file. */
function mappedPlaces(map) {
  let source = 0, original = 0;
  return map.mappings.split(";").map(line => {
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields = vlq(segment);
      if (fields.length >= 4) { source += fields[1]; original += fields[2]; return [source, original + 1]; }
    }
    return null;
  });
}
/* What a source contributes: its lines, the names whose values are recorded, its owner and the routine of each line. */
function sourceContext(sourceFile, source) {
  const original = source.split(/\r?\n/);
  const interfaceTexts = [...source.matchAll(/\bINTERFACES\s+([A-Za-z_]\w*)/gi)].map(match => {
    const file = path.join(path.dirname(sourceFile), match[1].toLowerCase() + ".intf.abap");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  });
  const signatures = [source, ...interfaceTexts].join("\n");
  const methodParameters = [...signatures.matchAll(/\bMETHODS\s+[\w~]+([^.]*?)\./gi)].flatMap(match =>
    [...match[1].matchAll(/\b(?:VALUE\s*\(\s*)?([A-Za-z_]\w*)\s*\)?\s+(?:TYPE|LIKE)\b/gi)].map(entry => entry[1].toLowerCase()));
  // A function module's parameters are in its group's XML; its Local Interface comment names them.
  const moduleParameters = [...source.matchAll(/^\*"\s+(?:REFERENCE|VALUE)\(\s*([A-Za-z_]\w*)\s*\)/gim)].map(match => match[1].toLowerCase());
  const names = [...new Set([
    ...[...source.matchAll(/\b(?:DATA|PARAMETERS)\s+([A-Za-z_]\w*)\b/gi)].map(match => match[1].toLowerCase()),
    ...[...source.matchAll(/\bDATA\s*\(\s*([A-Za-z_]\w*)\s*\)/gi)].map(match => match[1].toLowerCase()),
    ...methodParameters, ...moduleParameters
  ])];
  const values = names.map(name => `${JSON.stringify(name)}:globalThis.__vertexTrace.read(` +
    `typeof ${name} === 'undefined' ? undefined : ${name})`).join(",");
  const owner = path.basename(sourceFile).split(".")[0].toUpperCase();
  let routine = owner;
  const routines = original.map(line => {
    const start = /^\s*(?:METHOD|FORM|FUNCTION)\s+([A-Za-z_\/]\w*(?:~[A-Za-z_]\w*)?)\b/i.exec(line);
    if (start) routine = start[1].toUpperCase();
    const current = routine;
    if (/^\s*(?:ENDMETHOD|ENDFORM|ENDFUNCTION)\b/i.test(line)) routine = owner;
    return current;
  });
  return { sourceFile, original, values, owner, routines };
}
/* sources: [{ index, file, text }] - the sources of the map to record, by their index in it. */
function instrumentSources(file, sources, live = false) {
  const map = JSON.parse(fs.readFileSync(file + ".map", "utf8"));
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const places = mappedPlaces(map);
  const contexts = new Map(sources.map(source => [source.index, sourceContext(source.file, source.text)]));
  const executable = line => line && !/^\s*(?:\*|"|REPORT\b|PROGRAM\b|FUNCTION-POOL\b|DATA\b(?!\s*\()|PARAMETERS\b|ENDDO\b|ENDMETHOD\b|ENDCLASS\b|ENDFUNCTION\b)/i.test(line);
  const output = [];
  for (let index = 0; index < lines.length; index++) {
    const place = places[index], context = place && contexts.get(place[0]), at = place && place[1];
    if (context && executable(context.original[at - 1]) &&
        /^\s*(?:abap\.|[A-Za-z_]\w*\.|await\b|return\b|if\s*\(|for\s*\(|while\s*\(|throw\b)/.test(lines[index])) {
      const indent = /^\s*/.exec(lines[index])[0];
      output.push(`${indent}${live ? "await " : ""}globalThis.__vertexTrace?.capture(${JSON.stringify(context.sourceFile)},${at},{${context.values}},` +
        `${JSON.stringify(context.owner)},${JSON.stringify(context.routines[at - 1])});`);
    }
    output.push(lines[index]);
  }
  fs.writeFileSync(file, output.join("\n"));
}
function instrument(file, sourceFile, source, live = false) {
  return instrumentSources(file, [{ index: 0, file: sourceFile, text: source }], live);
}
/* skip: sources not recorded - the program VERTEX writes to call a method or function module, so a run shows only
   the code it calls. */
function instrumentProject(outputRoot, live = false, skip = []) {
  let count = 0;
  function visit(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) { if (item.name !== "node_modules") visit(file); continue; }
      if (!item.name.endsWith(".mjs") || !fs.existsSync(file + ".map")) continue;
      const map = JSON.parse(fs.readFileSync(file + ".map", "utf8"));
      // Every ABAP source of the map: a function group's file holds its includes and modules together.
      const sources = (map.sources || []).map((name, index) => ({ index, file: path.resolve(path.dirname(file), name) }))
        .filter(source => /\.abap$/i.test(source.file) && fs.existsSync(source.file)
          && !skip.some(name => path.basename(source.file).toLowerCase() === name.toLowerCase()))
        .map(source => ({ ...source, text: fs.readFileSync(source.file, "utf8") }));
      if (!sources.length) continue;
      instrumentSources(file, sources, live); count++;
    }
  }
  visit(outputRoot);
  return count;
}
function traceBootstrap(outputRoot, entry, traceFile, live = false) {
  const wrapper = path.join(outputRoot, "vertex-local-trace.mjs");
  const relative = "./" + path.relative(outputRoot, entry).replaceAll("\\", "/");
  fs.writeFileSync(wrapper, `import fs from 'node:fs';\n` +
    (live ? `import readline from 'node:readline';\nlet resumeTrace;\n` +
      `readline.createInterface({input:process.stdin}).on('line',line=>{try{if(JSON.parse(line).vertexTrace==='resume'){const done=resumeTrace;resumeTrace=null;done?.();}}catch{}});\n` : "") +
    `const records=[]; const last=new Map();\n` +
    `function safe(value){try {const seen=new WeakSet();const json=JSON.stringify(value,(_key,item)=>{\n` +
    ` if(typeof item==='bigint')return item.toString();\n` +
    ` if(item&&typeof item==='object'){if(seen.has(item))return '[circular]';seen.add(item);}\n` +
    ` return item;});return json===undefined?['undefined',undefined]:[json,JSON.parse(json)];}\n` +
    ` catch(error){return [String(value),String(value)];}}\n` +
    `globalThis.__vertexTrace={read(value,depth=0){\n` +
    ` if(depth>5)return '[nested]';\n` +
    ` try{if(value&&typeof value.array==='function')return value.array().map(row=>this.read(row,depth+1));\n` +
    ` if(value&&typeof value.get==='function')return this.read(value.get(),depth+1);\n` +
    ` if(Array.isArray(value))return value.map(row=>this.read(row,depth+1));\n` +
    ` if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,100).map(([k,v])=>[k,this.read(v,depth+1)]));\n` +
    ` return value;}catch(error){return '[unavailable: '+error.message+']';}\n` +
    ` },${live ? "async " : ""}capture(file,line,values,owner,routine){const changed={};\n` +
    ` for(const [name,value] of Object.entries(values)){const [signature,plain]=safe(value);\n` +
    ` if(last.get(name)!==signature){changed[name]=plain;last.set(name,signature);}}\n` +
    ` const stack=String(new Error().stack||'').split('\\n').slice(2).map(frame=>{\n` +
    ` const found=/[\\\\/]([^\\\\/]+)\\.(?:prog|clas|intf|fugr)\\.mjs(?::\\d+)?/.exec(frame);\n` +
    ` if(!found)return null;const fn=/^\\s*at (?:async )?([^\\s(]+)\\s*\\(/.exec(frame);\n` +
    ` return {owner:found[1].toUpperCase(),unit:fn?fn[1].split('.').pop().replaceAll('$','~').toUpperCase():found[1].toUpperCase()};\n` +
    ` }).filter(Boolean).filter((item,index,list)=>index===0||item.owner!==list[index-1].owner||item.unit!==list[index-1].unit);\n` +
    ` const record={file,line,owner,routine,stack:stack.length?stack:[{owner,unit:routine}],changed};records.push(record);\n` +
    (live ? ` process.stdout.write('VERTEX_TRACE_RECORD:'+JSON.stringify(record)+'\\n');await new Promise(resolve=>{resumeTrace=resolve;});` : "") +
    `}};\n` +
    `try { await import(${JSON.stringify(relative)}); } finally {\n` +
    ` fs.writeFileSync(${JSON.stringify(traceFile)},JSON.stringify(records)); process.stdin.destroy(); }\n`);
  return wrapper;
}

module.exports = { mappedLines, instrument, instrumentProject, traceBootstrap };
