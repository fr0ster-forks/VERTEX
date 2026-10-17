"use strict";
/* The repository of a system reached through SAP's ADT extension (sap-adt-extension.js): the same operations and the
   same answers as sap-code.js's createRepository, read from and written to the extension's abap: file system.

   Objects keep their ADT addresses (/sap/bc/adt/oo/classes/zcl_x/includes/implementations ...): the rest of VERTEX
   knows an object by them, the debugger and the analysis included. Here an address is only turned into the file the
   extension shows for it.

   The extension finds no object by its name for anyone else, so the name of an object is looked up in an index made
   by walking the extension's tree: Local Objects ($TMP), the customer root packages (Z*, Y*, /namespace/) and the
   packages the system names in "packages". Standard SAP is not walked.

   What the extension does not give - ADT's search, navigation, where-used, ABAP Unit, ATC, data preview, versions and
   VERTEX's own resources - is refused with the reason, never answered with something else. */
const { randomUUID } = require("crypto");
const { TYPES, revision } = require("./sap-code");
const adt = require("./sap-adt-extension");

const CLASS_PARTS = ["main", "definitions", "implementations", "macros", "testclasses"];
// The folders of the extension's "Source Code Library", and the object type each holds.
const KINDS = { Programs: "PROG", Includes: "INCL", Classes: "CLAS", Interfaces: "INTF", "Function Groups": "FUGR" };
const LIBRARY = "Source Code Library";
// The folders of the extension's "Dictionary", and the dictionary kind each holds; a structure is a TABL as in DD02L.
const DICTIONARY = "Dictionary";
const DDIC_KINDS = { "Database Tables": "TABL", Structures: "TABL", "Data Elements": "DTEL", Domains: "DOMA", "Table Types": "TTYP" };
const SYSTEM_LIBRARY = "System Library", LOCAL = "Local Objects ($TMP)";
const lower = value => String(value).toLowerCase();
const adtName = value => encodeURIComponent(lower(value));
const fromAdtName = value => decodeURIComponent(value).toUpperCase();
// A package's folder is named as the package is; the extension's own folders under it are words, not SAP names.
const isPackageFolder = name => /^[A-Z0-9_/$-]+$/.test(name);
const isCustomerRoot = name => /^(Z|Y|\/)/.test(name);

function objectUrl(type, name, group) {
  if (type === "PROG") return "/sap/bc/adt/programs/programs/" + adtName(name);
  if (type === "INCL") return "/sap/bc/adt/programs/includes/" + adtName(name);
  if (type === "CLAS") return "/sap/bc/adt/oo/classes/" + adtName(name);
  if (type === "INTF") return "/sap/bc/adt/oo/interfaces/" + adtName(name);
  if (type === "FUNC") return "/sap/bc/adt/functions/groups/" + adtName(group) + "/fmodules/" + adtName(name);
  throw new Error("Unsupported object type " + type + ".");
}
function sourceUrl(type, name, group, include = "main") {
  return objectUrl(type, name, group) + (type === "CLAS" && include !== "main" ? "/includes/" + include : "/source/main");
}

/* An ADT source address as the object it names and the part of it. */
function parseSourceUrl(url) {
  const path = String(url).split(/[?#]/)[0];
  let m;
  if ((m = /^\/sap\/bc\/adt\/oo\/classes\/([^/]+)(?:\/source\/main|\/includes\/([a-z]+))?$/.exec(path))) {
    return { type: "CLAS", name: fromAdtName(m[1]), include: m[2] || "main" };
  }
  if ((m = /^\/sap\/bc\/adt\/oo\/interfaces\/([^/]+)(?:\/source\/main)?$/.exec(path))) return { type: "INTF", name: fromAdtName(m[1]) };
  if ((m = /^\/sap\/bc\/adt\/programs\/programs\/([^/]+)(?:\/source\/main)?$/.exec(path))) return { type: "PROG", name: fromAdtName(m[1]) };
  if ((m = /^\/sap\/bc\/adt\/programs\/includes\/([^/]+)(?:\/source\/main)?$/.exec(path))) return { type: "INCL", name: fromAdtName(m[1]) };
  if ((m = /^\/sap\/bc\/adt\/functions\/groups\/([^/]+)\/fmodules\/([^/]+)(?:\/source\/main)?$/.exec(path))) {
    return { type: "FUNC", group: fromAdtName(m[1]), name: fromAdtName(m[2]) };
  }
  if ((m = /^\/sap\/bc\/adt\/functions\/groups\/([^/]+)\/includes\/([^/]+)(?:\/source\/main)?$/.exec(path))) {
    return { type: "FUGR_INCLUDE", group: fromAdtName(m[1]), name: fromAdtName(m[2]) };
  }
  if ((m = /^\/sap\/bc\/adt\/functions\/groups\/([^/]+)(?:\/source\/main)?$/.exec(path))) return { type: "FUGR_MAIN", group: fromAdtName(m[1]) };
  return null;
}

/* The file of an object's part in its folder, as the extension names it (abapGit's names). */
function fileName(entry, part) {
  const base = lower(entry.name);
  if (entry.type === "CLAS") return base + ".clas" + (part === "main" ? "" : "." + part) + ".abap";
  if (entry.type === "INTF") return base + ".intf.abap";
  if (entry.type === "PROG" || entry.type === "INCL") return base + ".prog.abap";
  throw new Error("No file for " + entry.type + ".");
}

/* The index: the objects of the walked packages, by type and name, with the path of their folder. It is walked a
   package at a time, so finding one object stops at the package that holds it; search and a package's objects walk it
   to the end. A finished index is kept by the store between sessions; an object it does not hold makes it walk again,
   as the object may have been made since. */
function createIndex({ fs, destination, packages = [], progress = () => {}, store = null, user = "" }) {
  let objects = new Map(), problems = [], queue = null, complete = false, fromStore = false, building = false;
  // The packages of the objects being worked on, as paths of the tree. What they use is looked for nearest first: in the
  // same package, then in the parent's other subpackages, up to the root package - never in another root package.
  const preferred = [];
  const shared = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
  const closeness = item => item.segments[1] !== SYSTEM_LIBRARY ? 0 : Math.max(0, ...preferred.map(p => shared(item.segments, p)));
  const put = (type, name, entry) => objects.set(type + ":" + name, { type, name, ...entry });
  const root = [destination];
  const list = segments => fs.readDirectory(segments);
  const kept = store && store.load();
  // The namespaces (/ABC/) that have a root package in the tree: the customer's own. SAP's own namespaces sit under
  // structure packages such as (IWNGW)FRAMEWORK, not as roots of their own.
  // A kept index from before namespaces were kept: they are the roots its objects lie under.
  let namespaces = new Set((kept && (kept.namespaces || (kept.objects || []).map(o => o.path && o.path[1] === SYSTEM_LIBRARY ? o.path[2] : "")
    .filter(name => name && name.startsWith("/")).map(name => name.slice(0, name.indexOf("/", 1) + 1)))) || []);
  if (kept && Array.isArray(kept.objects)) {
    objects = new Map(kept.objects.map(e => [e.type + ":" + e.name, e]));
    problems = kept.problems || [];
    complete = fromStore = true;
  }
  // The packages to walk: the users of $TMP, the customer root packages, and those the system names.
  async function begin() {
    const top = (await list(root)).map(([n]) => n);
    if (!top.length) throw new Error("SAP ADT extension shows nothing for " + destination + ": log on to it there first (ABAP: Logon to Destination).");
    queue = [];
    if (top.includes(LOCAL)) {
      // The $TMP of the user logged on: another user's local objects are none of this user's code.
      for (const [owner, kind] of await list([...root, LOCAL])) {
        if (kind === 2 && (!user || owner.toUpperCase() === String(user).toUpperCase())) queue.push({ segments: [...root, LOCAL, owner], name: "$TMP" });
      }
    }
    const roots = top.includes(SYSTEM_LIBRARY) ? (await list([...root, SYSTEM_LIBRARY])).filter(([, k]) => k === 2).map(([n]) => n) : [];
    for (const name of roots.filter(isCustomerRoot)) queue.push({ segments: [...root, SYSTEM_LIBRARY, name], name });
    namespaces = new Set(roots.filter(name => name.startsWith("/")).map(name => name.slice(0, name.indexOf("/", 1) + 1)).filter(ns => ns.length > 2));
    // A package named by the system: a root package, or a path of packages from one (BASIS/SABAPDEMOS).
    for (const wanted of packages) {
      const parts = String(wanted).toUpperCase().split("/").filter(Boolean);
      if (!parts.length) continue;
      // A customer root package named: the one already in the queue is marked as named, not walked twice.
      const queued = parts.length === 1 && queue.find(item => item.segments.length === 3 && item.segments[2] === parts[0]);
      if (queued) { queued.named = true; continue; }
      if (!roots.includes(parts[0])) { problems.push("package " + wanted + " is not a root package of the System Library"); continue; }
      let segments = [...root, SYSTEM_LIBRARY, parts[0]], found = true;
      for (const part of parts.slice(1)) {
        const children = (await list(segments)).map(([n]) => n);
        if (!children.includes(part)) { problems.push("package " + wanted + ": " + part + " is not under " + segments.at(-1)); found = false; break; }
        segments = [...segments, part];
      }
      if (found) queue.push({ segments, name: parts.at(-1), named: true });
    }
  }
  // One package: its own objects under Source Code Library; its subpackages are walked next.
  async function step({ segments, name: packageName }, seeded = false) {
    progress(packageName);
    let children;
    try { children = await list(segments); }
    catch (error) { problems.push(packageName + ": " + error.message); return []; }
    const below = [];
    for (const [child, kind] of children) {
      if (kind !== 2) continue;
      if (child === LIBRARY) await walkLibrary([...segments, child], packageName, seeded);
      else if (child === DICTIONARY) await walkDictionary([...segments, child], packageName, seeded);
      else if (isPackageFolder(child)) below.push({ segments: [...segments, child], name: child });
    }
    return below;
  }
  async function walkDictionary(segments, packageName, seeded) {
    for (const [folder, kind] of await list(segments)) {
      if (kind !== 2 || !DDIC_KINDS[folder]) continue;
      for (const [name, isDir] of await list([...segments, folder])) {
        if (isDir !== 2) continue;
        // Kept apart from the sources' types: a table and a class may share no name, but a data element and a domain often do.
        objects.set("DDIC:" + DDIC_KINDS[folder] + ":" + name, { type: "DDIC:" + DDIC_KINDS[folder], kind: DDIC_KINDS[folder], name, path: [...segments, folder, name],
          package: packageName, ...(seeded ? { seeded: true } : {}) });
      }
    }
  }
  async function walkLibrary(segments, packageName, seeded) {
    const put = (type, name, entry) => objects.set(type + ":" + name, { type, name, ...entry, ...(seeded ? { seeded: true } : {}) });
    for (const [folder, kind] of await list(segments)) {
      if (kind !== 2 || !KINDS[folder]) continue;
      const type = KINDS[folder];
      for (const [name, isDir] of await list([...segments, folder])) {
        if (isDir !== 2) continue;
        const path = [...segments, folder, name];
        if (type !== "FUGR") { put(type, name, { path, package: packageName }); continue; }
        put("FUGR", name, { path, package: packageName });
        // A function group's modules are files of its folder: <group>.fugr.<module>.func.abap.
        const prefix = lower(name) + ".fugr.";
        for (const [file] of await list(path)) {
          const m = file.startsWith(prefix) && /^(.+)\.func\.abap$/.exec(file.slice(prefix.length));
          if (m) put("FUNC", m[1].toUpperCase(), { path, package: packageName, group: name, file });
        }
      }
    }
  }
  function finish() {
    complete = true;
    if (store) store.save({ builtAt: new Date().toISOString(), problems, namespaces: [...namespaces], objects: [...objects.values()] });
  }
  // Near: the user's $TMP, the packages the system names, and the root packages of the objects worked on (prefer). A
  // subpackage is near when its root is.
  const near = item => item.segments[1] === LOCAL || item.named || closeness(item) >= 3;
  // Walks on until `until` is met or nothing (near, or at all with full) is left. Only a full walk to the end completes it.
  async function walk(until = () => false, full = false) {
    if (complete) return;
    if (!queue) await begin();
    for (;;) {
      // The nearest package next: the most of its path shared with a package worked on; $TMP and named packages first.
      let at = -1, best = -1;
      if (full) at = queue.length ? 0 : -1;
      else queue.forEach((item, k) => { if (!near(item)) return; const c = item.segments[1] === LOCAL || item.named ? 99 : closeness(item); if (c > best) { best = c; at = k; } });
      if (at < 0) break;
      const item = queue.splice(at, 1)[0];
      const below = await step(item);
      below.forEach(child => { if (item.named) child.named = true; });
      queue.unshift(...below);
      if (until()) return;
    }
    if (!queue.length) finish();
  }
  // A fresh walk: what was kept or walked is dropped; objects seeded from the tree since are kept.
  function restart() {
    const seeded = [...objects.values()].filter(e => e.seeded);
    objects = new Map(seeded.map(e => [e.type + ":" + e.name, e]));
    problems = []; queue = null; complete = false; fromStore = false;
  }
  return {
    // walkFor: whether a name not known yet may be walked for, near only. A kept index that does not hold it is walked
    // again near, keeping what it holds.
    async find(type, name, walkFor = true) {
      const key = type + ":" + String(name).toUpperCase();
      if (objects.has(key)) return objects.get(key);
      // While the whole system is walked, the queue is that walk's: a lookup takes what is collected so far.
      if (!walkFor || building) return null;
      if (complete && fromStore) { queue = null; complete = false; fromStore = false; }
      await walk(() => objects.has(key));
      return objects.get(key) || null;
    },
    // What is known after walking what is near.
    async nearby() { await walk(); return [...objects.values()]; },
    // Every customer package - on request only.
    async refresh() { restart(); await walk(() => false, true); return [...objects.values()]; },
    /* Every customer package, `workers` requests at a time. onProgress(walked, known, name); cancelled() stops it, and a
       stopped walk is not kept - what it found stays for this session. */
    async walkAll({ workers = 4, onProgress = () => {}, cancelled = () => false } = {}) {
      if (building) throw new Error("The index of " + destination + " is being built already.");
      building = true;
      try {
        restart();
        await begin();
        let walked = 0, inflight = 0, failure = null;
        await new Promise(resolve => {
          const pump = () => {
            if (cancelled() || failure) { if (!inflight) resolve(); return; }
            while (inflight < workers && queue.length) {
              const item = queue.shift();
              inflight++;
              step(item).then(below => { queue.push(...below); walked++; onProgress(walked, walked + queue.length + inflight - 1, item.name); },
                error => { problems.push(item.name + ": " + (error && error.message || error)); })
                .finally(() => { inflight--; pump(); });
            }
            if (!inflight && !queue.length) resolve();
          };
          pump();
        });
        if (cancelled()) return { cancelled: true, walked, objects: objects.size };
        finish();
        return { cancelled: false, walked, objects: objects.size, problems };
      } finally { building = false; }
    },
    building: () => building,
    complete: () => complete,
    // A package of the tree with its subpackages, walked alone: what the reader opened from the extension's tree.
    async addPackage(segments, name) {
      const pending = [{ segments, name }];
      const found = [];
      while (pending.length) { const item = pending.shift(); found.push(item.name); pending.unshift(...await step(item, true)); }
      return found;
    },
    // A package of the tree (its path) whose neighbourhood is walked: the package of an object opened or found.
    prefer(path) { if (path && path.length > 2 && !preferred.some(p => p.join("/") === path.join("/"))) preferred.push(path); },
    seed(entry) { if (!objects.has(entry.type + ":" + entry.name)) put(entry.type, entry.name, { ...entry, seeded: true }); },
    // An entry whose folder turned out not to be there any more.
    drop(type, name) { objects.delete(type + ":" + String(name).toUpperCase()); },
    known: () => [...objects.values()],
    // Whether the tree's roots were read (now or in a kept index): only then are the customer namespaces known.
    namespaces: () => queue || complete || namespaces.size ? namespaces : null,
    problems: () => problems
  };
}
async function buildIndex(fs, destination, packages = [], progress = () => {}) {
  const index = createIndex({ fs, destination, packages, progress });
  const all = await index.refresh();
  return { objects: new Map(all.map(e => [e.type + ":" + e.name, e])), problems: index.problems(), builtAt: new Date().toISOString() };
}

/* The object or package a path of the extension's tree stands for: [destination, ..., Classes, ZCL_X, zcl_x.clas.abap]. */
function objectAt(segments) {
  const at = segments.findIndex((name, i) => i > 0 && KINDS[name] && segments[i - 1] === LIBRARY);
  if (at < 0) {
    // A package folder: a package's name under the System Library, or a user's folder of $TMP.
    const last = segments.at(-1);
    if (segments.includes(SYSTEM_LIBRARY) && segments.length > 2 && isPackageFolder(last)) return { kind: "package", name: last, path: segments };
    if (segments[1] === LOCAL && segments.length === 3) return { kind: "package", name: "$TMP", path: segments };
    return null;
  }
  const type = KINDS[segments[at]], name = segments[at + 1];
  if (!name) return null;
  const owner = segments.slice(0, at - 1);
  const pkg = owner[1] === LOCAL && owner.length === 3 ? "$TMP" : isPackageFolder(owner.at(-1) || "") ? owner.at(-1) : "";
  const path = segments.slice(0, at + 2), file = segments[at + 2];
  if (type === "FUGR") {
    const m = file && /^.+?\.fugr\.(.+)\.func\.abap$/.exec(file);
    return m ? { kind: "object", type: "FUNC", name: m[1].toUpperCase(), group: name, path, file, package: pkg, include: "main" }
      : { kind: "object", type: "FUGR", name, path, package: pkg, include: "main" };
  }
  const part = type === "CLAS" && file && /\.clas\.([a-z]+)\.abap$/.exec(file);
  return { kind: "object", type, name, path, package: pkg, include: part ? part[1] : "main" };
}

/* host: what VS Code does for this repository -
     readDirectory(segments) -> [[name, kind]], readFile(segments) -> text, write(segments, text),
     check(segments) -> diagnostics [{ severity: "error"|..., line, message }], activate(segments),
     activeText(segments) -> the active version's text,
     progress(text) */
/* The package part of a path of the tree: everything before "Source Code Library" or "Dictionary", or the path itself. */
function packagePath(path) {
  const at = path.findIndex(name => name === LIBRARY || name === DICTIONARY);
  return at > 0 ? path.slice(0, at) : path;
}

/* store: load() -> what save(index) kept, or nothing - the index between sessions. */
function createExtensionRepository({ system, host, store = null, emit = () => {} }) {
  const destination = system.destination;
  const label = system.name + " / " + adt.LABEL;
  const drafts = new Map();
  let applying = false;
  const refuse = what => () => { throw new Error(what + " is not available: " + adt.httpRefusal(system)); };
  const destinationUser = ((adt.destinations().find(d => d.id === destination) || {}).properties || {}).user || "";
  const index = createIndex({ fs: host, destination, packages: system.packages || [], store, user: destinationUser,
    progress: name => host.progress("Indexing " + destination + ": " + name) });
  // One walk at a time: two lookups at once would walk the same packages twice.
  let walking = Promise.resolve();
  const serial = work => { const done = walking.then(work, work); walking = done.catch(() => {}); return done; };
  // Standard SAP lies in no customer package: a name outside the customer namespace is not walked for, unless the system
  // names packages of its own to index.
  // Z* and Y*, and a namespace with a root package of its own in the tree; /IWNGW/ and the like are SAP's.
  const customerName = name => {
    const text = String(name).toUpperCase();
    if (!text.startsWith("/")) return isCustomerRoot(text);
    const known = index.namespaces();
    return !known || known.has(text.slice(0, text.indexOf("/", 1) + 1));
  };
  const walkable = name => customerName(name) || (system.packages || []).length > 0;
  const scope = () => "the $TMP of " + (destinationUser || "this user") + ", the packages of the objects worked on"
    + ((system.packages || []).length ? ", " + system.packages.join(", ") : "")
    + (index.complete() ? " and every customer package" : "; VERTEX: Index SAP System walks every customer package");
  async function lookup(type, name) {
    const found = await serial(() => index.find(type, name, walkable(name)));
    if (!found && index.building()) {
      throw new Error(type + " " + name + " is not in the part of " + destination + " indexed so far: its index is being built - try again when it is done.");
    }
    if (!found) {
      const problems = index.problems().length ? " Not indexed: " + index.problems().join("; ") + "." : "";
      throw new Error(type + " " + name + " was not found in " + destination + " (looked in " + scope() + ")." + problems);
    }
    // What it uses is looked for beside it first.
    if (found.path) index.prefer(packagePath(found.path));
    return found;
  }
  // A file of an indexed object; an entry kept from an earlier session may name a folder that is gone, and is looked up again.
  async function readEntry(type, name, file) {
    const entry = await lookup(type, name);
    try { return { entry, text: await host.readFile(file(entry)) }; }
    catch (error) {
      if (!/FileNotFound|ENOENT|not found/i.test(String(error && (error.code || error.message)))) throw error;
      index.drop(type, name);
      const again = await lookup(type, name);
      return { entry: again, text: await host.readFile(file(again)) };
    }
  }
  function fileOf(entry, part = "main") {
    if (entry.type === "FUNC") return [...entry.path, entry.file];
    if (entry.type !== "CLAS" && part !== "main") throw new Error("Includes apply only to classes.");
    if (!CLASS_PARTS.includes(part)) throw new Error("Unknown class include.");
    return [...entry.path, fileName(entry, part)];
  }
  const row = entry => ({ object_name: entry.name, object_type: entry.type, description: "", package: entry.package,
    object_url: objectUrl(entry.type, entry.name, entry.group) });
  async function includesOf(entry) {
    if (entry.type !== "CLAS") return [];
    const files = (await host.readDirectory(entry.path)).map(([n]) => n);
    return CLASS_PARTS.filter(part => files.includes(fileName(entry, part)));
  }

  async function search(args) {
    const query = args.query;
    if (typeof query !== "string" || !/^[A-Z0-9_/$*+]+$/i.test(query) || query.length > 80) throw new Error("Use a SAP name or name pattern (* and + wildcards).");
    const max = args.limit === undefined ? 50 : args.limit;
    if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error("limit must be 1..200.");
    const pattern = new RegExp("^" + query.toUpperCase().replace(/[.\\^$|?()[\]{}]/g, "\\$&").replace(/\*/g, ".*").replace(/\+/g, ".") + "$");
    const wanted = args.object_type ? [args.object_type] : Object.keys(TYPES);
    const all = (await serial(() => index.nearby())).filter(e => wanted.includes(e.type) && pattern.test(e.name));
    // Searched where the index has walked, and said so: the extension finds no name for anyone else.
    return { system: label, objects: all.slice(0, max).map(row), truncated: all.length > max, searched: scope() };
  }
  // The extension shows an object's inactive version when it has one; that is the version read here, and said.
  async function read(args) {
    const type = args.object_type, name = String(args.object_name || "").toUpperCase();
    if (!Object.hasOwn(TYPES, type)) throw new Error("Supported object_type values: PROG, INCL, CLAS, FUNC, INTF.");
    const include = args.include || "main";
    const { entry, text: source } = await readEntry(type, name, found => fileOf(found, include));
    return { ...row(entry), system: label, include, source_url: sourceUrl(type, entry.name, entry.group, include), source,
      revision: revision(source), active_revision: revision(source), includes: await includesOf(entry) };
  }
  function analysisReader() {
    const sources = new Map();
    return async args => {
      const key = args.object_type + ":" + String(args.object_name).toUpperCase() + ":" + (args.include || "main");
      if (!sources.has(key)) sources.set(key, read(args));
      return sources.get(key);
    };
  }
  async function sourceAt(url) {
    const at = parseSourceUrl(url);
    if (!at) throw new Error("Reading " + url + " is not available: " + adt.httpRefusal(system));
    if (at.type === "FUGR_MAIN" || at.type === "FUGR_INCLUDE") {
      const program = at.type === "FUGR_MAIN" ? "sapl" + lower(at.group) : lower(at.name);
      return (await readEntry("FUGR", at.group, group => [...group.path, lower(at.group) + ".fugr." + program + ".reps.abap"])).text;
    }
    return (await readEntry(at.type, at.name, found => fileOf(found, at.include || "main"))).text;
  }
  async function packageObjects(packageName) {
    const wanted = String(packageName).toUpperCase();
    const known = index.known().filter(e => e.package === wanted);
    const all = known.length ? known : await serial(() => index.nearby());
    const objects = all.filter(e => e.package === wanted && (e.type === "CLAS" || e.type === "INTF"))
      .map(e => ({ object_name: e.name, object_type: e.type }));
    if (!objects.length && !all.some(e => e.package === wanted)) {
      throw new Error("Package " + wanted + " was not found among the indexed packages of " + destination + ".");
    }
    if (objects.length > 100) throw new Error("Package contains more than 100 classes/interfaces; select a smaller package.");
    return objects;
  }

  function remember(data) {
    if (drafts.size >= 100) throw new Error("Too many pending changes. Discard or apply a draft first.");
    const change_id = randomUUID(), draft = { ...data, change_id, system: label, state: "prepared" };
    drafts.set(change_id, draft);
    return { ...draft };
  }
  async function modify(args) {
    if (typeof args.source !== "string" || !args.source.trim()) throw new Error("Source must be non-empty.");
    if (typeof args.base_revision !== "string") throw new Error("Read the object first and supply base_revision.");
    const current = await read(args);
    if (current.revision !== args.base_revision && current.revision !== revision(args.source)) {
      throw new Error("Source changed in SAP. Read it again before preparing a change.");
    }
    return remember({ ...current, operation: "modify", original_source: current.source, source: args.source,
      base_revision: current.revision, transport: args.transport || "" });
  }
  /* Written through the extension, checked, and activated only when the check finds no error: on an error the
     extension's own activation asks whether to activate anyway, and that answer would be the reader's, unseen here. */
  async function apply(id, { source, transport = "" }) {
    if (applying) throw new Error("SAP session is busy. Wait for the current operation to finish.");
    const change = drafts.get(id);
    if (!change || change.state !== "prepared") throw new Error("Change is not ready; read SAP and prepare a new draft.");
    if (change.operation !== "modify") throw new Error("Creating objects is not available: " + adt.httpRefusal(system));
    applying = true;
    let written = false;
    try {
      change.state = "applying";
      const entry = await lookup(change.object_type, change.object_name), file = fileOf(entry, change.include);
      const current = await host.readFile(file);
      if (revision(current) !== change.base_revision && revision(current) !== revision(source)) {
        throw new Error("Source changed in SAP since preview. Nothing was overwritten.");
      }
      if (revision(current) !== revision(source)) {
        emit({ type: "status", message: "Saving " + change.object_name });
        await host.write(file, source);
        written = true;
        if (revision(await host.readFile(file)) !== revision(source)) {
          throw new Error("SAP ADT extension did not store the source: reading it back gives another text.");
        }
      }
      const diagnostics = await host.check(file);
      const errors = diagnostics.filter(d => d.severity === "error");
      if (errors.length) {
        throw new Error("Syntax check failed, so activation was not requested: " + errors.map(d => "Line " + d.line + ": " + d.message).join("; "));
      }
      emit({ type: "status", message: "Activating " + change.object_name });
      await host.activate(file);
      const active = await host.activeText(file);
      if (revision(active) !== revision(source)) throw new Error("Activation was requested, but the active source differs. Inspect SAP before retrying.");
      change.state = "applied";
      return { system: label, object_name: change.object_name, object_type: change.object_type, saved: true, activated: true,
        revision: revision(active), diagnostics,
        ...(transport ? { warning: "The transport is chosen in SAP ADT extension, which asks for one when the object needs it; " + transport + " was not passed." } : {}) };
    } catch (error) {
      change.state = written ? "needs-inspection" : "prepared";
      throw new Error(error.message + (written ? " SAP source was written (inactive); activation was not confirmed." : ""));
    } finally { applying = false; }
  }

  const handlers = { search_sap_objects: search, read_sap_object: read, modify_sap_object: modify,
    create_sap_object: refuse("Creating objects"), read_value_origin_pipeline: refuse("The value origin pipeline") };
  async function execute(tool, args) {
    if (!Object.hasOwn(handlers, tool)) throw new Error("Unknown SAP code tool: " + tool);
    const task_id = randomUUID();
    emit({ type: "tool.call", task_id, tool });
    try { const result = await handlers[tool](args || {}); emit({ type: "tool.result", task_id, tool }); return result; }
    catch (error) { emit({ type: "error", task_id, tool, message: error.message }); throw error; }
  }
  const currentSource = (url, include) => sourceAt(String(url).split(/[?#]/)[0] + (include && include !== "main" ? "/includes/" + include : "/source/main"));
  const user = system.user || ((adt.destinations().find(d => d.id === destination) || {}).properties || {}).user || "";
  const language = ((adt.destinations().find(d => d.id === destination) || {}).properties || {}).language || "EN";
  return { execute, apply, draft: id => { const d = drafts.get(id); if (!d) throw new Error("Unknown or expired change. Prepare it again."); return { ...d }; },
    discard: id => drafts.delete(id), analysisReader, packageObjects, sourceAt, currentSource,
    language: () => language, user: () => user, canStore: async () => false, index: () => serial(() => index.refresh()),
    // The whole system, once, in the background - not through the serial queue, so lookups go on meanwhile.
    indexAll: options => index.walkAll(options),
    indexKept: () => !!(store && store.load()),
    // What the reader points at in the extension's tree is known without a walk.
    seed: info => { if (info && info.path) index.prefer(packagePath(info.path));
      if (info && info.kind === "object") index.seed({ type: info.type, name: info.name, path: info.path, package: info.package,
      ...(info.group ? { group: info.group, file: info.file } : {}) }); },
    addPackage: (segments, name) => serial(() => index.addPackage(segments, name)),
    customerName,
    // The dictionary reads of the transpiler's run (sap-ddic.js), answered from the extension's DDIC sources (sap-adt-ddic.js).
    dictionaryQuery: require("./sap-adt-ddic").createDictionaryQuery(async (name, kind) => {
      const entry = await serial(() => index.find("DDIC:" + kind, name, walkable(name)));
      if (!entry) return null;
      if (kind !== "TABL") return entry;
      const file = lower(name) + ".tabl.ddic";
      return { file, text: await host.readFile([...entry.path, file]) };
    }),
    // A function module's group, and a group's modules - what TFDIR answers over HTTP - from the extension's tree.
    groupOf: async module => (await lookup("FUNC", module)).group,
    groupModules: async group => {
      const entry = await lookup("FUGR", group), prefix = lower(group) + ".fugr.";
      return (await host.readDirectory(entry.path)).map(([file]) => file.startsWith(prefix) && /^(.+)\.func\.abap$/.exec(file.slice(prefix.length)))
        .filter(Boolean).map(m => m[1].toUpperCase());
    },
    query: refuse("Data preview"), revisions: refuse("Versions"), revisionSource: refuse("Versions"), storeReview: refuse("Storing a review"),
    unitTests: refuse("ABAP Unit through VERTEX"), atcCheck: refuse("ATC through VERTEX"), whereUsed: refuse("Where-used"),
    documentation: refuse("ABAP documentation"),
    // No elementInfo, elementDetails or dataElement: the editor asks them on every hover and offers SAP's navigation
    // only where they exist (code-workbench.js sourceOf), so their absence is what turns those off for this system.
    definition: refuse("Navigation to a definition"), implementation: refuse("Navigation to an implementation"),
    dispose: async () => { drafts.clear(); } };
}

module.exports = { createExtensionRepository, buildIndex, createIndex, objectAt, parseSourceUrl, objectUrl, sourceUrl, fileName, label: adt.LABEL };
