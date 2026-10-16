"use strict";

// VS Code host for the pages the Eclipse plugin serves - the same files, from
// the same folder. Nothing about a service lives here that does not live there
// too, which is the whole point of the split.
//
// Eclipse gets its connection from the ABAP project's ADT session, and a window
// opened from an object inherits the system that object lives in. Here there is
// no project to inherit from, so the systems are a list in the settings and one
// of them is active.

const vscode = require("vscode");
const mcp = require("./mcp");
const selector = require("./selector");
const versions = require("./versions");
const assistant = require("./assistant");
const anthropic = require("./anthropic");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

/* The pages are the Eclipse plugin's, and that is where they are read from in
   a checkout. A vsix carries only this folder, so vscode:prepublish copies them
   in and the packaged extension finds them here. One source of truth, one copy
   made at packaging time, and no guessing at run time about which it is. */
const PACKAGED = path.join(__dirname, "resources");
const PAGES = fs.existsSync(PACKAGED)
  ? PACKAGED
  : path.join(__dirname, "..", "org.vertex.abap.ui", "resources");

/** Passwords are filed per system: two systems are two users often enough. */
function secretKey(system) {
  return "vertex.password." + system.name;
}

/* ---------- what each service asks for ----------

   One entry per view in the Eclipse plugin, and the path builders are the same
   ones its Java writes. They are duplicated rather than shared because there is
   nowhere to share them: the two hosts have no language in common. Keeping them
   side by side in one table at least makes the divergence visible.           */

const SERVICES = require(path.join(PAGES, "tool-routes.js")).SERVICES;

/* Which services the ABAP half on a system has, whichever window asks. */
const ABOUT = "/sap/bc/adt/vertex/about";

/* Calls that change something on the server, and which of their arguments is
   the body. Everything not named here reads. */
const WRITES = { act: 4 };

function upper(value) {
  return encodeURIComponent(String(value || "").toUpperCase());
}

/* ---------- the page ---------- */

// In Eclipse these are BrowserFunctions; here they are postMessage, which is the
// only thing a webview can do. The contract fits unchanged because sdeLoad never
// returned a value in the first place - the asynchronous shape was forced on us
// by the WebView2 callback deadlock, and it happens to be exactly what VS Code
// requires.
//
// The arguments travel as an array rather than by name. Each service calls
// sdeLoad with its own, and a host that named them would need editing every time
// a page learned a new one; what they mean is the service's business, and the
// service is where it is written down.
const SHIM = [
  "<script>",
  "(function () {",
  "  const api = acquireVsCodeApi();",
  "  let pending = null;",
  "  function send(call) {",
  "    return function () {",
  "      api.postMessage({ type: 'call', call: call,",
  "                        args: Array.prototype.slice.call(arguments) });",
  "    };",
  "  }",
  "  window.sdeLoad = send('load');",
  "  window.sdeClass = send('class');",
  "  window.sdeFlow = send('flow');",
  "  window.sdeAsset = send('asset');",
  "  window.sdeJoin = send('join');",
  "  window.sdeOpen = send('open');",
  "  window.sdeReview = send('review');",
  "  window.sdeAct = send('act');",
  "  window.sdeRequests = send('requests');",
  "  window.sdeAbout = send('about');",
  "  window.sdeTitle = send('title');",
  "  window.sdeBrowse = send('browse');",
  "  window.sdeAsk = send('ask');",
  "  window.sdeModels = send('models');",
  "  window.sdeTake = function () {",
  "    const taken = pending;",
  "    pending = null;",
  "    return taken;",
  "  };",
  "  window.addEventListener('message', function (e) {",
  "    if (e.data && e.data.type === 'result') {",
  "      pending = e.data.payload;",
  "      sdeReady();",
  "    }",
  // The assistant answers on a channel of its own: a reply that takes a
  // minute must not land in the middle of whatever the grid is doing.
  "    if (e.data && e.data.type === 'progress' && typeof vertexProgress === 'function') {",
  "      vertexProgress(e.data.payload);",
  "    }",
  "    if (e.data && e.data.type === 'assistant' && typeof sdeAssistant === 'function') {",
  "      sdeAssistant(e.data.payload);",
  "    }",
  "  });",
  "}());",
  "</script>"
].join(String.fromCharCode(10));

function pageHtml(service, initial) {
  let html = fs.readFileSync(path.join(PAGES, SERVICES[service].page), "utf8");
  const controls = fs.readFileSync(path.join(PAGES, "vertex-controls.css"), "utf8");
  html = html.replace("</head>", "<style>" + controls + "</style></head>");
  html = html.replace("<script>", SHIM + String.fromCharCode(10) + "<script>");
  html = html.replace("/*INIT*/null/*INIT*/", initialLiteral(initial));
  return html;
}

/** What the page starts from, in the shape that page expects. */
function initialLiteral(initial) {
  if (!initial) {
    return "null";
  }
  if (typeof initial === "string") {
    return "'" + initial + "'";
  }
  return "{name:'" + initial.name + "',type:'" + (initial.type || "") + "'}";
}

/* ---------- the systems ---------- */

function systems() {
  return (vscode.workspace.getConfiguration("vertex").get("systems") || [])
    .filter(function (s) { return s && s.name; });
}

/**
 * The system to read from, or a sentence saying why there is none. An empty
 * vertex.active means the first one: with a single system configured, naming it
 * again would be ceremony.
 */
/* A VERTEX Tools window keeps the system it was opened on. Whatever it sets
   off - a read, the chat, an assistant's MCP calls - runs inside pinTo, and
   active() answers with that system instead of vertex.active. */
const pinnedSystem = new (require("async_hooks").AsyncLocalStorage)();

function pinTo(name, work) {
  return name ? pinnedSystem.run(name, work) : work();
}

function active() {
  const all = systems();
  if (all.length === 0) {
    return { error: "No system configured. VERTEX: Import SAP Systems fills vertex.systems from SAP Logon and Eclipse, or put one in by hand: a name, a url and a user." };
  }
  const pinned = pinnedSystem.getStore();
  const wanted = pinned || (vscode.workspace.getConfiguration("vertex").get("active") || "").trim();
  if (!wanted) {
    return { system: all[0] };
  }
  const found = all.filter(function (s) { return s.name === wanted; });
  if (found.length === 0) {
    return {
      error: (pinned ? "This window reads from " + wanted + ", which is no longer"
                     : "vertex.active names " + wanted + ", which is not")
           + " in vertex.systems. There is " + all.map(function (s) { return s.name; }).join(", ") + "."
    };
  }
  return { system: found[0] };
}

function missing(system) {
  const gaps = [];
  if (!system.url) { gaps.push("url"); }
  if (!system.user) { gaps.push("user"); }
  return gaps;
}

// Asked once per system, then kept by VS Code in the OS credential store. This
// extension never writes it to a file and never puts it in a URL.
async function password(context, system) {
  const stored = await context.secrets.get(secretKey(system));
  if (stored) {
    return stored;
  }
  const entered = await vscode.window.showInputBox({
    prompt: "SAP password for " + system.user + " on " + system.name,
    password: true,
    ignoreFocusOut: true
  });
  if (entered) {
    await context.secrets.store(secretKey(system), entered);
  }
  return entered;
}

/** The client belongs to every request, not to one of them. */
function withClient(system, requestPath) {
  if (!system.client) {
    return requestPath;
  }
  return requestPath + (requestPath.indexOf("?") === -1 ? "?" : "&")
       + "sap-client=" + encodeURIComponent(system.client);
}

function request(system, pw, requestPath, extra) {
  const settings = extra || {};
  return new Promise(function (resolve, reject) {
    let base;
    try {
      base = new URL(system.url);
    } catch (e) {
      reject(new Error("The url of " + system.name + " is not a valid one: " + system.url));
      return;
    }

    const secure = base.protocol === "https:";
    const headers = {
      Authorization: "Basic " + Buffer.from(system.user + ":" + pw).toString("base64"),
      Accept: requestPath.split("?")[0] === "/sap/bc/adt/discovery"
        ? "application/atomsvc+xml" : "application/json"
    };
    Object.keys(settings.headers || {}).forEach(function (name) {
      headers[name] = settings.headers[name];
    });
    if (settings.body) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(settings.body, "utf8");
    }

    const options = {
      hostname: base.hostname,
      port: base.port || (secure ? 443 : 80),
      path: requestPath,
      method: settings.method || "GET",
      headers: headers
    };
    if (secure) {
      options.rejectUnauthorized = system.allowInsecureCertificate !== true;
    }

    const req = (secure ? https : http).request(options, function (res) {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", function (chunk) { body += chunk; });
      res.on("end", function () {
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
    });
    req.on("error", reject);
    if (settings.body) {
      req.write(settings.body, "utf8");
    }
    req.end();
  });
}

/* A write needs a CSRF token, and the token belongs to the session that was
   given it - so the cookies of that response have to travel with it. Eclipse
   never needed this: its ADT communication layer holds a destination and does
   the same dance out of sight. */
async function csrf(system, pw) {
  const res = await request(system, pw, withClient(system, "/sap/bc/adt/discovery"), {
    headers: { "x-csrf-token": "fetch" }
  });
  const token = res.headers["x-csrf-token"];
  if (!token || token.toLowerCase() === "required") {
    throw new Error("HTTP " + res.status + ": " + system.name
                  + " did not hand out a CSRF token, so nothing was written.");
  }
  const cookies = (res.headers["set-cookie"] || [])
    .map(function (one) { return one.split(";")[0]; })
    .join("; ");
  return { token: token, cookies: cookies };
}

/** ADT reports failures as XML; pull the human sentence out of it. */
function describeFailure(status, body) {
  const match = /<message[^>]*>([\s\S]*?)<\/message>/.exec(body);
  const detail = match ? match[1].trim() : body.substring(0, 500).trim();
  return "HTTP " + status + (detail ? ": " + detail : "");
}

function describeConnection(error) {
  const code = String(error.code || "");
  let text = "Cannot reach the system: " + (error.message || String(error));
  if (code.indexOf("CERT") !== -1 || code.indexOf("SELF_SIGNED") !== -1) {
    text += String.fromCharCode(10, 10)
          + "The server certificate could not be verified. Development systems often carry "
          + "one that cannot be. If you accept that, set allowInsecureCertificate on this "
          + "system in vertex.systems - it is off by default because it disables the check "
          + "entirely.";
  }
  return text;
}

/**
 * Reads one resource and answers in the shape the page expects. Given a BODY it
 * writes instead, which needs a CSRF token first.
 */
let frontendAnalysisRequest, frontendTableRequest, frontendTableWrite;
async function fetch(context, requestPath, body, progress, cancelled) {
  if (body == null && frontendAnalysisRequest && /^\/sap\/bc\/adt\/vertex\/(metrics|class|package|flow)\//.test(requestPath)) {
    try { return JSON.stringify(await frontendAnalysisRequest(requestPath, progress, cancelled)); }
    catch (error) { return 'ERROR:' + error.message; }
  }
  // SelecTor's table and join are read through ADT's data preview, not the VERTEX resource on SAP; a pivot still
  // goes to the resource.
  if (body == null && frontendTableRequest && /^\/sap\/bc\/adt\/vertex\/((table|join|versions|review)\/|requests(\?|$))/.test(requestPath)) {
    let answer;
    try { answer = await frontendTableRequest(requestPath, progress); }
    catch (error) { return 'ERROR:' + error.message; }
    if (answer) { return JSON.stringify(answer); }
  }
  // A reviewer's action and the save of a review built from ADT are made on this side and stored in the table
  // (through VERTEX's store resource) or in a file, as vertex.review.storage says.
  if (body != null && frontendTableWrite && /^\/sap\/bc\/adt\/vertex\/review\//.test(requestPath)) {
    try { return JSON.stringify(await frontendTableWrite(requestPath, body)); }
    catch (error) { return 'ERROR:' + error.message; }
  }
  if (body == null && requestPath === ABOUT) {
    const selected = active();
    if (selected.error) return 'ERROR:' + selected.error;
    const raw = await fetch(context, ABOUT + '?backend=1');
    let remote = {};
    try { if (!raw.startsWith('ERROR:')) remote = JSON.parse(raw); } catch (_) {}
    const local = ['metrics','class','package','flow','table','join','versions','requests','review'];
    const services = ['metrics','class','package','flow','table','join','versions','review','requests'].map(name =>
      local.includes(name) ? { name, active: 'X', backend: ['table','join','versions','requests','review'].includes(name) ? 'ADT data preview' : 'ADT + abaplint' } :
        (remote.services || []).find(s => s.name === name) || { name, active: '', backend: 'VERTEX', handler: name });
    return JSON.stringify({ ...remote, user: remote.user || selected.system.user,
      backends: remote.backends || [{ name: 'VERTEX', installed: false }], services });
  }
  const chosen = active();
  if (chosen.error) {
    return "ERROR:" + chosen.error;
  }
  const system = chosen.system;
  const gaps = missing(system);
  if (gaps.length) {
    return "ERROR:System " + system.name + " has no " + gaps.join(" and ") + ".";
  }

  const pw = await password(context, system);
  if (!pw) {
    return "ERROR:No password was entered, so the request was not sent.";
  }

  let extra;
  if (body) {
    try {
      const ticket = await csrf(system, pw);
      extra = {
        method: "POST",
        body: body,
        headers: { "x-csrf-token": ticket.token, Cookie: ticket.cookies }
      };
    } catch (e) {
      // CSRF already says what went wrong in a sentence; a connection failure
      // does not, and describeConnection is what turns one into words.
      return "ERROR:" + (e && e.message ? e.message : describeConnection(e));
    }
  }

  // ADT's quick search answers in XML only; the VERTEX resources in JSON.
  if (!body && requestPath.startsWith("/sap/bc/adt/repository/informationsystem/search?")) {
    extra = { headers: { Accept: "application/xml" } };
  }

  let response;
  try {
    response = await request(system, pw, withClient(system, requestPath), extra);
  } catch (e) {
    return "ERROR:" + describeConnection(e);
  }

  if (response.status === 401) {
    // A wrong password kept in the store would block every later attempt with no
    // way out, so drop it and say that it was dropped.
    await context.secrets.delete(secretKey(system));
    return "ERROR:HTTP 401: " + system.name + " rejected user " + system.user
         + ". The stored password has been discarded; loading again will ask for it.";
  }
  if (response.status === 404) {
    // A resource that is not there is a setup state, not a failure: the
    // extension is installed here and the ABAP half has never been put on the
    // system. The page says what to install; it needs to be told which of the
    // two this is.
    return "ERROR:NOBACKEND:" + describeFailure(response.status, response.body);
  }
  if (response.status !== 200) {
    return "ERROR:" + describeFailure(response.status, response.body);
  }
  if (!response.body || !response.body.trim()) {
    // A 200 carrying nothing is not success. Name what actually came back
    // instead of letting the page fail on an empty parse.
    return "ERROR:HTTP 200 with an empty body."
         + " content-type: " + (response.headers["content-type"] || "(none)")
         + " | content-length: " + (response.headers["content-length"] || "(none)")
         + " | location: " + (response.headers["location"] || "(none)");
  }
  return response.body;
}

/** One of the libraries that travel with the pages, as text. */
// The shared controls stylesheet is an asset like the diagram library: a page
// given to a webview as a string has no address to load one from, so it asks
// for what it needs by name. Both files live beside the pages.
const ASSETS = { mermaid: "mermaid.min.js", controls: "vertex-controls.css", flow: "vertex-flow.js", lens: "vertex-lens.js", flowGraph: "vertex-flow-graph.js", abapControl: "vertex-abap-control.js" };
function asset(name) {
  if (!ASSETS[name]) {
    return "ERROR:This host ships no asset called " + name + ".";
  }
  const file = name === "abapControl" ? require("./abap-control").file : path.join(PAGES, ASSETS[name]);
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    return "ERROR:" + file + " could not be read: " + e.message;
  }
}

/* ---------- panels ---------- */

function open(context, service, initial, beside) {
  const definition = SERVICES[service];
  const panel = vscode.window.createWebviewPanel(
    "vertex",
    typeof initial === "string" && initial ? initial : definition.title,
    beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = pageHtml(service, initial);

  panel.webview.onDidReceiveMessage(
    async function (message) {
      if (!message || message.type !== "call") {
        return;
      }
      const args = message.args || [];

      if (message.call === "open") {
        // What needed surgery on the E4 model in Eclipse is one argument here.
        open(context, service, String(args[0] || ""), true);
        return;
      }
      if (message.call === "browse") {
        // Opening a link belongs to the window manager, not to the webview.
        if (args[0]) {
          vscode.env.openExternal(vscode.Uri.parse(String(args[0])));
        }
        return;
      }
      if (message.call === "title") {
        // The page reports what it loaded, so a panel driven from its own input
        // bar does not keep the name it was opened with.
        if (args[0]) {
          panel.title = definition.title + ": " + args[0];
        }
        return;
      }
      if (message.call === "asset") {
        // A library the page needs, shipped with the extension rather than
        // fetched: these windows have to work on a machine with no way out to
        // the internet. The names are a fixed list, so this can never read
        // anything the extension did not mean to ship.
        panel.webview.postMessage({
          type: "result",
          payload: asset(String(args[0] || ""))
        });
        return;
      }
      if (message.call === "about") {
        // What the ABAP half on this system has. Every window asks the same
        // question when it opens, so it is answered here rather than per service.
        panel.webview.postMessage({
          type: "result",
          payload: await fetch(context, ABOUT)
        });
        return;
      }
      if (message.call === "models" || message.call === "ask") {
        const payload = !ASSISTED[service]
          ? { error: "This window has no assistant." }
          : message.call === "models"
            ? await assistantModels(context, args)
            : await assistantAsk(context, service, args);
        payload.call = message.call;
        try {
          await panel.webview.postMessage({ type: "assistant", payload: JSON.stringify(payload) });
        } catch (e) {
          // The window was closed while the assistant was still working;
          // there is nobody left to tell.
        }
        return;
      }

      const build = definition[message.call];
      if (!build) {
        // A page asking for something this service does not answer is a gap in
        // the host, not a user error, and it says so where the user can see it.
        panel.webview.postMessage({
          type: "result",
          payload: "ERROR:This host has no " + message.call + " for " + service + "."
        });
        return;
      }
      // A writing call carries its body in one of its arguments; WRITES says
      // which. Everything else reads.
      const bodyAt = WRITES[message.call];
      const body = bodyAt === undefined ? undefined : String(args[bodyAt] || "");
      // What a long read is doing goes to the page's status line as it happens.
      const progress = text => { panel.webview.postMessage({ type: "progress", payload: String(text) }).then(undefined, () => {}); };
      panel.webview.postMessage({
        type: "result",
        payload: await fetch(context, build(args), body, progress)
      });
    },
    undefined,
    context.subscriptions
  );

  return panel;
}

/* ---------- the window assistants ----------

   The person picks Claude Code or Codex, as they do for the MCP address, and
   the model that assistant offers. The request goes to that assistant with
   the window's own endpoint as its only tool source; what it hands back is
   checked against the system here before the page is given it.

   Each window that has one names what its assistant knows - the rules, the
   tools, the shape of a plan and the check - and the address its tools are
   served at, beside the review on the same local server. */

const ASSISTED = {
  table: { brain: selector, route: "/selector" },
  versions: { brain: versions, route: "/versions" }
};

function windowTools() {
  const pages = {};
  Object.keys(ASSISTED).forEach(function (service) {
    const brain = ASSISTED[service].brain;
    pages[ASSISTED[service].route] = { tools: brain.TOOLS, call: brain.callTool };
  });
  return pages;
}

function assistantExtension(id) {
  const described = assistant.ASSISTANTS[id];
  const found = described ? vscode.extensions.getExtension(described.extension) : null;
  return found ? found.extensionPath : "";
}

async function assistantModels(context, args) {
  const id = String(args[0] || "");
  try {
    // What Config models in the VERTEX panel leaves switched on; versions are
    // added there too, so the page offers no field of its own for them.
    return { assistant: id, models: require("./model-config").apply(vscode, id, id === "anthropic-api"
      ? await anthropic.models((await require("./key-profiles").getActiveKey(context.secrets, id)).key)
      : await assistant.models({ assistant: id, extensionPath: assistantExtension(id) })) };
  } catch (e) {
    return { assistant: id, error: e.message };
  }
}

async function assistantAsk(context, service, args) {
  const id = String(args[0] || "");
  const brain = ASSISTED[service].brain;
  const chosen = active();
  if (chosen.error) {
    return { error: chosen.error };
  }
  let state;
  try {
    state = JSON.parse(String(args[3] || "{}"));
  } catch (e) {
    return { error: "The page sent a state that is not JSON." };
  }
  let running;
  try {
    running = await tools.start();
  } catch (e) {
    return { error: "The VERTEX tool server did not start, so the assistant would have no tools: "
                    + e.message };
  }
  try {
    const answer = await assistant.ask({
      assistant: id,
      model: String(args[1] || ""),
      personalInstructions: vscode.workspace.getConfiguration("vertex.ai").get("personalInstructions", false),
      extensionPath: assistantExtension(id),
      url: running.url.replace(/\/mcp$/, ASSISTED[service].route),
      token: tools.token,
      instructions: brain.INSTRUCTIONS,
      prompt: brain.preparePrompt
        ? await brain.preparePrompt({ fetch: fetch, context: context }, String(args[2] || ""), state)
        : brain.prompt(String(args[2] || ""), state),
      schema: brain.PLAN_SCHEMA,
      tools: brain.TOOLS.map(function (t) { return t.name; })
    });
    const plan = await brain.checkPlan({ fetch: fetch, context: context }, answer.plan);
    return { plan: plan, model: answer.model, system: chosen.system.name };
  } catch (e) {
    return { error: e.message, model: e.model || "", system: chosen.system.name };
  }
}

/* An agent already in the editor - Copilot, Claude Code, Codex - can be handed
   what VERTEX knows about SAP instead of VERTEX growing an agent of its own.
   The way in is MCP, and the server is this extension: it already holds the
   system, the user and the password, so nothing of that has to be passed to
   another process. */
function serveTools(context, server) {
  const label = "VERTEX SAP";
  const version = vscode.extensions.getExtension("YuriiSychov.vertex-abap");
  const shown = version && version.packageJSON ? version.packageJSON.version : "0";

  context.subscriptions.push(
    vscode.commands.registerCommand("vertex.getStarted", async function () {
      await vscode.commands.executeCommand("workbench.action.openWalkthrough",
        "YuriiSychov.vertex-abap#vertex.start", false);
    }),
    ...["systems", "test", "ai", "mcp"].map(step =>
      vscode.commands.registerCommand("vertex." + step + "Info", async function () {
        await vscode.commands.executeCommand("markdown.showPreview",
          vscode.Uri.file(path.join(__dirname, "walkthrough", step + ".md")));
      })),
    vscode.commands.registerCommand("vertex.mcpAddress", async function () {
      const picked = await vscode.window.showQuickPick(["Codex", "Claude Code"], {
        title: "Connect VERTEX to which assistant?"
      });
      if (!picked) { return; }
      const client = picked;
      let running;
      try {
        running = await server.start();
      } catch (e) {
        vscode.window.showErrorMessage("The VERTEX tool server did not start: "
                                       + (e && e.message ? e.message : String(e)));
        return;
      }
      // Ready to paste: Claude Code and Codex are told where to connect and
      // with which token. Copilot needs none of this - it is handed the same
      // address through the provider below.
      // User scope, not the default local one: local ties the server to the
      // directory Claude Code happens to be started in, and this one belongs
      // to the machine, not to a folder.
      const entries = [{ name: "vertex", url: running.url },
        { name: "vertex-debug", url: running.url.replace(/\/mcp$/, "/debug") }];
      const line = entries.map(({ name, url }) => client === "Codex"
        ? '[mcp_servers.' + name + ']\nurl = "' + url
          + '"\nhttp_headers = { Authorization = "Bearer ' + server.token + '" }\n'
        : 'claude mcp add --transport http ' + name + ' --scope user ' + url
                 + ' --header "Authorization: Bearer ' + server.token + '"').join("\n");
      await vscode.env.clipboard.writeText(line);
      vscode.window.showInformationMessage(
        (client === "Codex"
          ? "Copied Codex configuration for review and debugger. Paste into ~/.codex/config.toml, replacing existing [mcp_servers.vertex] and [mcp_servers.vertex-debug] sections, then restart Codex and start a new conversation. "
          : "Copied two Claude Code terminal commands for review and debugger. If already registered, first run claude mcp remove vertex --scope user and claude mcp remove vertex-debug --scope user. ")
        + (vscode.workspace.getConfiguration("vertex").get("mcp.port", 37777) === 0
          ? "Port 0 changes the address on reload. Set vertex.mcp.port for a stable connection."
          : "The port and token persist across window reloads."));
    })
  );

  if (!hasMcpApi()) {
    // Said once, where it can be seen: the tools simply will not appear
    // otherwise, and an empty tool list explains nothing.
    console.log("VERTEX: this VS Code has no vscode.lm MCP API, so no tools are offered.");
    return;
  }

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("vertex", {
      provideMcpServerDefinitions: async function () {
        const running = await server.start();
        return [
          new vscode.McpHttpServerDefinition(
            label,
            vscode.Uri.parse(running.url),
            { Authorization: "Bearer " + server.token },
            shown)
        ];
      }
    })
  );
}

function hasMcpApi() {
  return !!(vscode.lm
         && typeof vscode.lm.registerMcpServerDefinitionProvider === "function"
         && typeof vscode.McpHttpServerDefinition === "function");
}

let tools = null;

/* A Tools window showing a diff tells the panel which part and which two
   versions are on screen, but not the lines: the panel's chat has no tool to
   read a diff. So the changed lines are read here, from the window's system,
   and handed over as the selected fragment - the changes with three lines
   around each, capped like any fragment. */
async function withShownDiff(context, state) {
  const view = state && state.vertex_view;
  if (!view || (state.selected_fragment && state.selected_fragment.text)) { return state; }
  // A review's object is read the same way: the saved review of that object in the request, its blocks marked.
  const reviewing = view.view === "review_object" && !!view.review_object;
  if (!reviewing && (view.view !== "diff" || !view.part || !view.version)) { return state; }
  const route = reviewing ? SERVICES.versions.review([view.name, "", view.review_object, view.review_type])
    : SERVICES.versions.load([view.name, view.type, view.part, view.part_type, view.compared_with || "", view.version, "I"]);
  const raw = await pinTo(state.system, () => fetch(context, route));
  if (typeof raw !== "string" || raw.indexOf("ERROR:") === 0) {
    throw new Error("VERTEX could not read the diff shown in the Tools window: " + String(raw).substring(6));
  }
  const data = JSON.parse(raw);
  const ops = data.ops || [];
  const near = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === "=") { return; }
    for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) { near[k] = true; }
  });
  const lines = [], opens = {};
  (data.blocks || []).forEach(b => { if (b.op_from > 0) { opens[b.op_from - 1] = b; } });
  const verdict = b => b.action === "A" ? "approved" : b.action === "D" ? "declined" : "open";
  ops.forEach((o, i) => {
    if (opens[i]) { const b = opens[i]; lines.push("#" + b.hunk_no + " " + b.change_kind + ", " + b.change_count + " lines, line " + b.start_line
      + ", " + (b.author_name || b.author) + ", " + verdict(b)); }
    if (near[i]) { lines.push((o.op === "=" ? " " : o.op) + " " + o.text); }
    else if (lines[lines.length - 1] !== "...") { lines.push("..."); }
  });
  if (!lines.length) { return state; }
  if (reviewing) {
    return { ...state, selected_fragment: { view, text: "Review of " + view.review_object.trim() + " (" + (view.review_type || "")
      + ") in request " + view.name + ", versions " + (data.versno_old || "nothing") + " to " + data.versno_new
      + " ('-' removed, '+' added, #n a review block):\n" + lines.join("\n") } };
  }
  return { ...state, selected_fragment: { view,
    text: "Diff of " + view.part.trim() + " from " + (view.compared_with || "nothing") + " to " + view.version
          + " ('-' removed, '+' added):\n" + lines.join("\n") } };
}

function systemKey(system) {
  return JSON.stringify([system.name, system.url, system.client || "", system.user]);
}

/* The debugger an assistant drives through /debug: one per window, on the
   active system, with the password VS Code keeps. The listener runs on a
   stateless session; each stopped program gets a stateful one of its own. */
function debuggerFor(context) {
  const crypto = require("crypto");
  let id = context.globalState.get("vertex.debug.ideId");
  if (!id) {
    id = crypto.randomBytes(16).toString("hex").toUpperCase();
    context.globalState.update("vertex.debug.ideId", id);
  }
  const dbg = require("./debugger").create({
    ideId: id,
    terminalId: id,
    openUrl: url => vscode.env.openExternal(vscode.Uri.parse(url)),
    // Which system is active now: a window's own, a chat's named one, or vertex.active.
    current: () => { const chosen = active(); return chosen.error ? "" : systemKey(chosen.system); },
    connect: async function () {
      const chosen = active();
      if (chosen.error) { throw new Error(chosen.error); }
      const system = chosen.system;
      const pw = await password(context, system);
      if (!pw) { throw new Error("The SAP password for " + system.name + " was not supplied."); }
      const { ADTClient } = require("abap-adt-api");
      const make = function () {
        const client = new ADTClient(system.url, system.user, pw, system.client || "", "EN", { timeout: 300000 });
        client.httpClient.httpclient = require("./sap-http").create(system);
        return client;
      };
      const listener = make();
      // The listener spends its life in a long poll, so the dump feed gets a
      // stateless session of its own rather than queueing behind it.
      const probe = make();
      return {
        key: systemKey(system), system, user: String(system.user).toUpperCase(), listener, probe,
        open: async function () {
          const client = make();
          client.stateful = "stateful";
          await client.login();
          return client;
        }
      };
    }
  });
  // A closed window must not leave breakpoints and a listener behind on SAP.
  context.subscriptions.push({ dispose: () => { dbg.stop().catch(() => {}); } });
  return dbg;
}

/* The source tools with the debugger's added: the schemas and the method the
   chat is told, and a call that sends debug_* to the debugger. The Anthropic
   API path calls execute directly, so it gets the answer as text. */
function withDebugger(sapCode, debugTools) {
  // Getters, read when asked - as the source tools' own text is: it names the
  // systems configured at the time. Object.assign would read them now.
  return Object.create(sapCode, {
    schemas: { get: () => sapCode.schemas.concat(debugTools.tools) },
    instructions: { get: () => sapCode.instructions + "\n\n" + debugTools.instructions },
    execute: { value: async function (name, args) {
      if (!/^debug_/.test(name)) { return sapCode.execute(name, args); }
      const answer = await debugTools.call({}, name, args || {});
      if (answer.isError) { throw new Error(answer.content[0].text); }
      return answer.content[0].text;
    } }
  });
}

function activate(context) {
  const sapCode = require("./code-workbench").register(vscode, context, { active, password, pin: pinTo,
    pinned: () => pinnedSystem.getStore() || "", systems });
  require("./local-navigation").register(vscode, context);
  frontendAnalysisRequest = sapCode.frontendRequest;
  frontendTableRequest = sapCode.tableRequest;
  frontendTableWrite = sapCode.tableWrite;
  require('./local-run').setSelectorQuery(sapCode.selectorQuery);
  // A first start with no system: offered once per start, never imported without the reader's click.
  const listed = vscode.workspace.getConfiguration("vertex").get("systems");
  if (Array.isArray(listed) && !listed.some(function (s) { return s && s.name; })) {
    vscode.window.showInformationMessage("VERTEX: no SAP system is configured. Import them from SAP Logon and Eclipse?",
      "Import SAP Systems", "Settings").then(function (answer) {
        if (answer === "Import SAP Systems") { vscode.commands.executeCommand("vertex.importSystems"); }
        if (answer === "Settings") { vscode.commands.executeCommand("workbench.action.openSettings", "vertex.systems"); }
      });
  }
  // The panel's chat debugs too: its assistant gets the debugger tools beside
  // the source tools, on the same /chat address, with nothing to register.
  // Visual Debug in the Tools window draws this same debugger.
  const dbg = debuggerFor(context);
  sapCode.attachDebugger(dbg);
  const debugTools = mcp.debugSet(dbg);
  const chatTools = withDebugger(sapCode, debugTools);
  let latestToolsContext = null;
  // What the Visual Debug panel shows - the record, and the flow of the analysis - for the chat to be given with a question.
  let latestDebugContext = null;
  const port = vscode.workspace.getConfiguration("vertex").get("mcp.port", 37777);
  const chatSet = {
      tools: chatTools.schemas.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations
      })),
    call: async function (deps, name, args) {
      const config = vscode.workspace.getConfiguration("vertex.ai");
      const provider = config.get("provider", "codex-subscription") === "claude-subscription" ? "claude" : "codex";
      const sessionLog = require("./session-log");
      return sessionLog.tools(sessionLog.current(config.get("logPath", ""), provider, sessionLog.fromConfig(config)),
        async function (_deps, toolName, toolArgs) {
          if (/^debug_/.test(toolName)) { return debugTools.call(_deps, toolName, toolArgs); }
          const result = await sapCode.execute(toolName, toolArgs);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        })(deps, name, args);
    }
  };
  tools = mcp.create({ fetch: fetch, context: context, port: port,
    pin: pinTo, pinned: () => pinnedSystem.getStore() || "",
    pages: Object.assign(windowTools(), { "/chat": chatSet, "/debug": debugTools }) });
  const showTools = (initial, embeddedPanel) => require("./tools-window").open(vscode, context,
    { panel: embeddedPanel, pages: PAGES, fetch, asset, active, pin: pinTo, models: args => assistantModels(context, args),
      originPoints: args => sapCode.originPoints(args),
      openToolSource: args => sapCode.openToolSource(args),
      documentObject: document => sapCode.documentObject(document),
      setContext: value => { latestToolsContext = value; },
      debugger: dbg,
      chat: () => require("./chat").create(vscode, chatTools, tools, context.secrets, () => latestDebugContext, () => require("./value-origin-view").originContext()) }, initial);
  // The normal source tab remains the sole code editor.  The debugger is a
  // docked panel, not another editor tab showing a second copy of that source.
  let dockedDebugView = null, dockedDebugSource = null, localDebugAdapter = null;
  const localHistoryMark = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
    overviewRulerLane: vscode.OverviewRulerLane?.Full,
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, "images", "stopped.svg"),
    gutterIconSize: "contain"
  });
  context.subscriptions.push(localHistoryMark);
  let localHistoryEditor = null;
  const clearLocalHistoryMark = () => {
    if (localHistoryEditor) localHistoryEditor.setDecorations(localHistoryMark, []);
    localHistoryEditor = null;
  };
  const localEntry = source => {
    try { return require("./local-run").entryScreen(source.document, source.entryLine); }
    catch (error) { return { error: error.message }; }
  };
  const dockedDebugInitial = () => !dockedDebugSource ? null : {
    name: dockedDebugSource.object_name,
    type: dockedDebugSource.object_type,
    local: dockedDebugSource.local === true,
    // Opened to run, not to analyse: until a breakpoint is set the panel is the selection screen and the output.
    runOnly: dockedDebugSource.local === true && dockedDebugSource.runOnly === true,
    // Opened by the Run command, not by Clear: the program runs at once.
    autoRun: dockedDebugSource.local === true && dockedDebugSource.autoRun === true && !localDebugAdapter?.hasTrace(),
    // Opened again while its run is alive: the page takes the run's record instead of starting one.
    restore: dockedDebugSource.local === true && !!localDebugAdapter?.hasTrace(),
    scenarios: dockedDebugSource.local ? require("./local-run").scenariosFor(dockedDebugSource.document) : [],
    // A method or function module under the cursor: the screen of its parameters, or why it cannot be called.
    entry: dockedDebugSource.local ? localEntry(dockedDebugSource) : null,
    parameters: dockedDebugSource.local ? require("./local-run").parametersFor(dockedDebugSource.document) : [],
    // The whole selection screen with its texts, which the panel draws.
    screen: dockedDebugSource.local ? require("./local-run").screenFor(dockedDebugSource.document) : null
  };
  // A transpiler run of an SAP program works on copies of its sources; the reader works in the SAP tabs. These turn one
  // into the other: a copy's path and its tab's address. A local file is its own path.
  const sapCopy = (by, value) => (dockedDebugSource?.sapCopies?.copies || []).find(copy =>
    by === "uri" ? copy.uri === value : copy.path.toLowerCase() === String(value || "").toLowerCase());
  const runPathOf = uri => uri?.scheme === "file" ? uri.fsPath : sapCopy("uri", uri?.toString())?.path || null;
  const runUriOf = file => { const copy = sapCopy("path", file); return copy ? vscode.Uri.parse(copy.uri) : vscode.Uri.file(file); };
  const runDocument = async file => {
    const copy = sapCopy("path", file);
    return copy ? pinTo(dockedDebugSource.sapCopies.system, () => sapCode.sourceOf(copy.object))
      : vscode.workspace.openTextDocument(vscode.Uri.file(file));
  };
  const postDockedPicture = () => {
    if (dockedDebugSource?.local && localDebugAdapter) {
      const frame = localDebugAdapter.picture().stopped?.frames?.[0];
      const editor = (vscode.window.visibleTextEditors || []).find(item =>
        frame && runPathOf(item.document.uri)?.toLowerCase() === String(frame.url || "").toLowerCase());
      if (localHistoryEditor && localHistoryEditor !== editor) clearLocalHistoryMark();
      if (editor && frame?.line > 0 && frame.line <= editor.document.lineCount) {
        editor.setDecorations(localHistoryMark, [editor.document.lineAt(frame.line - 1).range]);
        localHistoryEditor = editor;
      } else if (!frame) clearLocalHistoryMark();
    }
    if (dockedDebugView) void dockedDebugView.webview.postMessage({ type: "debug",
      payload: JSON.stringify(dockedDebugSource?.local ? localDebugAdapter?.picture() : dbg.picture()) });
  };
  let latestLocalVariables = null;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("vertex.visualDebug", {
    resolveWebviewView(view) {
      dockedDebugView = view;
      view.webview.options = { enableScripts: true };
      view.webview.html = require("./tools-window").debugHtml(dockedDebugInitial());
      if (dockedDebugSource?.local && latestLocalVariables) {
        setTimeout(() => void view.webview.postMessage({ type: "localVariables", state: latestLocalVariables }), 150);
      }
      let logicReceive=null,logicDisposers=[];
      const unwatch = dbg.watch(postDockedPicture);
      // The reader's place in a VERTEX source, for the variables it shows before the program runs: the object and the line the
      // cursor is on, whichever VERTEX tab is in front. A change is sent once the cursor has rested a moment.
      let cursorTimer;
      const sendCursor = () => {
        const editor = vscode.window.activeTextEditor, object = editor && (dockedDebugSource?.local
          ? require("./local-analysis").sourceObject(editor.document) : sapCode.documentObject(editor.document));
        if (!object) { return; }
        view.webview.postMessage({ type: "cursor", payload: JSON.stringify({ ...object, line: editor.selection.active.line + 1 }) });
      };
      const watchCursor = () => { clearTimeout(cursorTimer); cursorTimer = setTimeout(sendCursor, 150); };
      const cursorWatchers = [vscode.window.onDidChangeTextEditorSelection(watchCursor), vscode.window.onDidChangeActiveTextEditor(watchCursor)];
      setTimeout(sendCursor, 400);
      view.onDidDispose(() => { clearTimeout(cursorTimer); cursorWatchers.forEach(watcher => watcher.dispose()); });
      const receive = view.webview.onDidReceiveMessage(async message => {
        try {
          if (message.call === "localPanelReady") {
            if (latestLocalVariables && dockedDebugSource?.local) {
              await view.webview.postMessage({ type: "localVariables", state: latestLocalVariables });
            }
            return;
          }
          if (message.call === "localRun") {
            if (!dockedDebugSource?.local) throw new Error("Open a local ABAP file in Visual Debug first.");
            clearLocalHistoryMark();
            latestLocalVariables = null;
            await require("./local-run").launch(vscode, true, {
              document: dockedDebugSource.document, selection: message.selection || {}
            });
            await view.webview.postMessage({ type: "localRunResult", message: "Debug session started. Breakpoints and variables are in the VS Code Debug view." });
            return;
          }
          if (message.call === "localStep") {
            clearLocalHistoryMark();
            const command = { into: "workbench.action.debug.stepInto", over: "workbench.action.debug.stepOver",
              out: "workbench.action.debug.stepOut", continue: "workbench.action.debug.continue",
              stop: "workbench.action.debug.stop" }[message.kind];
            if (!command) throw new Error("Unknown local debug action.");
            await vscode.commands.executeCommand(command);
            return;
          }
          if (message.call === "copyLocalVariables") {
            const state = latestLocalVariables || { frame: "", variables: [] };
            const lines = [state.frame || "", ...(state.variables || []).map(variable =>
              variable.name + " = " + String(variable.value ?? ""))].filter(Boolean);
            await vscode.env.clipboard.writeText(lines.join("\n"));
            return;
          }
          if(message.call==="inlineLogic"){if(logicReceive)await logicReceive(message.payload);return;}
          if (message.call === "source") {
            const args = message.args || [];
            const type = String(args[1] || "").toUpperCase();
            if (!["PROG", "CLAS", "FUNC"].includes(type)) { throw new Error("Unsupported source type."); }
            const source = await pinTo(dockedDebugSource && dockedDebugSource.system_name, () =>
              sapCode.execute("read_sap_object", { object_name: String(args[0] || ""), object_type: type }));
            await view.webview.postMessage({ type: "result", payload: JSON.stringify(source) });
            return;
          }
          if (message.call === "asset") {
            const name = String((message.args || [])[0] || "");
            await view.webview.postMessage({ type: "result", payload: asset(name) });
            return;
          }
          if (message.call === "origin") {
            // Where the chosen value can be changed, from the same analysis the
            // editor command runs. The window turns these into breakpoints. It takes
            // seconds and answers on a channel of its own, by the number of the request,
            // so that it runs beside the debugger instead of holding its queue - an
            // error included: it is the analysis's, not the next debugger answer's.
            const request = JSON.parse(String((message.args || [])[0] || "{}"));
            let reply;
            try { reply = { id: request.id, answer: request.pathFormula ? sapCode.originPath(request.pathFormula)
              : request.recordFormula ? require("./record-formula").build(request.recordFormula)
              : dockedDebugSource?.local && request.variables
              ? await require("./local-analysis").declaredVariables(dockedDebugSource.document, request.variables, vscode)
              : request.open ? await sapCode.originOpen(request.open) : request.variables ? await sapCode.originVariables(request.variables) : await sapCode.originPoints(request,progress=>view.webview.postMessage({type:"originProgress",payload:{id:request.id,...progress}}),dockedDebugSource?.local?dockedDebugSource.document:null) }; }
            catch (error) { reply = { id: request.id, error: error.message }; }
            await view.webview.postMessage({ type: "origin", payload: JSON.stringify(reply) });
            return;
          }
          if (message.call === "debugContext") {
            try { latestDebugContext = JSON.parse(String((message.args || [])[0] || "null")); } catch (error) { latestDebugContext = null; }
            return;
          }
          if (message.call === "clear") {
            // Clear: the panel starts again for its object, as a new open does; breakpoints and a SAP session stay.
            if (dockedDebugSource) openVisualDebug(dockedDebugSource.runOnly === true, { ...dockedDebugSource, autoRun: false });
            return;
          }
          if (message.call === "backward") {
            // Where used from a breakpoint: Backward Usage Analysis from the point's line, of the value chosen in Variables
            // wherever it is named, else of the routine there.
            const point = JSON.parse(String((message.args || [])[0] || "{}"));
            let editor = null;
            if (dockedDebugSource?.local) {
              editor = await vscode.window.showTextDocument(await runDocument(String(point.url || "")), { preview: false });
            } else {
              await sapCode.revealFrame(point);
              const name = String(point.program || "").toLowerCase();
              editor = (vscode.window.visibleTextEditors || []).find(item => name && item.document.uri.toString().toLowerCase().includes(name)) || vscode.window.activeTextEditor;
              if (editor) editor = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preview: false });
            }
            if (!editor) throw new Error("The source of " + point.program + " is not open.");
            const line = Math.max(0, Math.min(editor.document.lineCount - 1, Number(point.line || 1) - 1));
            const position = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            await vscode.commands.executeCommand("vertex.backwardUsage", { variable: point.variable || "" });
            return;
          }
          if (message.call === "reveal") {
            // The player walked to a recorded stop. In this panel the source is
            // the editor's, so that is what has to move.
            const frame = JSON.parse(String((message.args || [])[0] || "{}"));
            if (dockedDebugSource?.local) {
              const source = String(frame.url || "");
              if (source && /\.abap$/i.test(source)) {
                const document = await runDocument(source);
                const line = Math.max(0, Math.min(document.lineCount - 1, Number(frame.line || 1) - 1));
                const editor = await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
                const position = new vscode.Position(line, 0);
                if (localHistoryEditor && localHistoryEditor !== editor) clearLocalHistoryMark();
                editor.setDecorations(localHistoryMark, [document.lineAt(line).range]);
                localHistoryEditor = editor;
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
              }
            } else {
              await sapCode.revealFrame(frame);
            }
            return;
          }
          if (message.call === "debug" && (message.args || [])[0] === "copy") {
            // The step log to the clipboard, through VS Code rather than the page.
            await vscode.env.clipboard.writeText(String(JSON.parse((message.args || [])[1] || "{}").text || ""));
            await view.webview.postMessage({ type: "result", payload: "{}" });
            return;
          }
          if (message.call !== "debug") { throw new Error("Unsupported VERTEX Debug request."); }
          // The docked panel is opened from an ABAP editor and has no source
          // pane of its own: the stop is followed in that editor.
          if (typeof dbg.drivenBy === "function") { dbg.drivenBy("editor"); }
          const args = message.args || [];
          const command = String(args[0] || "");
          const commandArgs = JSON.parse(String(args[1] || "{}"));
          if (dockedDebugSource?.local && localDebugAdapter) {
            if (["run", "step", "stop", "detach", "terminate"].includes(command)) clearLocalHistoryMark();
            const answer = await localDebugAdapter.command(command, commandArgs);
            // The program is over: no line of it is running, so the editor shows none.
            if (["run", "step"].includes(command) && answer && answer.ended) clearLocalHistoryMark();
            if (["run", "stop", "detach", "terminate"].includes(command))
              await vscode.commands.executeCommand("setContext", "vertex.localHistory", localDebugAdapter.hasTrace());
            await view.webview.postMessage({ type: "result", payload: JSON.stringify(answer) });
            return;
          }
          // The SAP program run with the ABAP transpiler: its sources are read into a folder of their own, and the panel
          // turns to the transpiler's, on the program written there.
          if (command === "sapTranspile") {
            await view.webview.postMessage({ type: "result", payload: "{}" });
            await runSapTranspiler(dockedDebugSource);
            return;
          }
          if(command==="logicTools"){
            logicDisposers.splice(0).forEach(dispose=>dispose());logicReceive=null;
            const embedded={title:"Logic",webview:{
              set html(value){void view.webview.postMessage({type:"inlineLogicHtml",payload:value});},
              postMessage:payload=>view.webview.postMessage({type:"inlineLogicReply",payload}),
              onDidReceiveMessage:handler=>{logicReceive=handler;return {dispose(){logicReceive=null;}};}
            },onDidDispose:handler=>{logicDisposers.push(handler);return {dispose(){}};}};
            const editor=vscode.window.activeTextEditor,editorObject=editor&&sapCode.documentObject(editor.document);
            const selected=editorObject?{name:editorObject.object_name,type:editorObject.object_type,cursorLine:editor.selection.active.line+1}:commandArgs;
            await showTools({...selected,action:"scheme",boundObject:true},embedded);
            await view.webview.postMessage({type:"result",payload:"{}"});return;
          }
          const handled = Date.now();
          const answer = await pinTo(dockedDebugSource && dockedDebugSource.system_name, () =>
            require("./tools-window").debugCommand(dbg, command, commandArgs,
              resource => fetch(context, resource)));
          // How long the host held a step, for the window's time per stage.
          if (command === "step" && answer && typeof answer === "object") { answer.handler = Date.now() - handled; }
          await view.webview.postMessage({ type: "result", payload: JSON.stringify(answer) });
        } catch (error) {
          if (message.call === "localRun") {
            await view.webview.postMessage({ type: "localRunResult", error: error.message });
            return;
          }
          await view.webview.postMessage({ type: "result", payload: "ERROR:" + error.message });
        }
      });
      view.onDidDispose(() => {
        if (dockedDebugView === view) { dockedDebugView = null; }
        logicDisposers.splice(0).forEach(dispose=>dispose());
        unwatch(); receive.dispose();
      });
      postDockedPicture();
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  require("./local-debug-vars").register(vscode, context, state => {
    latestLocalVariables = state;
    if (dockedDebugSource?.local && localDebugAdapter) localDebugAdapter.update(state);
    if (dockedDebugView && dockedDebugSource?.local) {
      void dockedDebugView.webview.postMessage({ type: "localVariables", state });
    }
  }, () => !!dockedDebugSource?.local);
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => {
    if (dockedDebugSource?.local && localDebugAdapter) localDebugAdapter.finish();
    void vscode.commands.executeCommand("setContext", "vertex.localHistory", false);
  }));
  // In the transpiler panel the breakpoints are VS Code's own: a point set or removed in the editor is shown at once.
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(() => { if (dockedDebugSource?.local && localDebugAdapter) postDockedPicture(); }));
  const openVisualDebug = (runOnly = false, again = null) => {
    void vscode.commands.executeCommand("setContext", "vertex.localHistory", false);
    const editor = vscode.window.activeTextEditor;
    const local = require("./local-analysis");
    const localObject = local.isLocalAbap(editor?.document) ? local.sourceObject(editor.document) : null;
    // Clear starts the same panel again, for the object it shows, whichever editor is in front.
    const source = again || (localObject ? { ...localObject, local: true, document: editor.document, entryLine: editor.selection.active.line + 1 } : sapCode.editorContext());
    if (!source || !source.object_name) {
      vscode.window.showWarningMessage("VERTEX: open a local or SAP ABAP source tab first.");
      return;
    }
    // A new window starts clean: no record, no paused transpiler run, no analysed path, no values of an earlier
    // Node debug session, no history mark. A live SAP debug session and the breakpoints are the debugger's, and stay.
    localDebugAdapter?.dispose();
    latestLocalVariables = null;
    clearLocalHistoryMark();
    sapCode.forgetOrigin?.();
    dockedDebugSource = { ...source, runOnly: runOnly === true, autoRun: runOnly === true && (!again || again.autoRun === true) };
    localDebugAdapter = source.local ? require("./local-debug-adapter").create(vscode, source.document,
      selection => require("./local-run").launch(vscode, false, { document: source.document, selection, live: true, entryLine: source.entryLine }),
      postDockedPicture, () => require("./local-run").runScope(vscode, source.document),
      { entry: () => localEntry(source), variants: context.workspaceState, pathOf: runPathOf, uriOf: runUriOf }) : null;
    if (source.local && latestLocalVariables && dockedDebugView) {
      setTimeout(() => void dockedDebugView?.webview.postMessage({ type: "localVariables", state: latestLocalVariables }), 150);
    }
    if (dockedDebugView) {
      // A page the same as the one shown is not loaded again by VS Code: the mark of this opening makes it new.
      dockedDebugView.webview.html = require("./tools-window").debugHtml(dockedDebugInitial()) + "<!-- " + Date.now() + " -->";
      dockedDebugView.show(true);
      postDockedPicture();
    } else {
      vscode.commands.executeCommand("workbench.view.extension.vertex-debug").catch(error =>
        vscode.window.showErrorMessage("VERTEX: could not open Debug panel: " + error.message));
    }
  };
  // An SAP program run with the ABAP transpiler: its sources are read into a folder of their own, and Visual Debug turns
  // to the transpiler's panel on the program written there, running at once.
  const runSapTranspiler = async shown => {
    const kind = String(shown?.object_type || "").toUpperCase();
    if (!["PROG", "CLAS", "FUNC"].includes(kind)) throw new Error("The transpiler runs an SAP program, a method of an SAP class or a function module; open one first.");
    // A class runs one method: the one the cursor stands in, in the tab of the class's own source.
    let entryLine = 1;
    if (kind === "CLAS") {
      const object = { object_name: shown.object_name, object_type: "CLAS", include: "main" };
      const tab = await pinTo(shown.system_name, () => sapCode.sourceUri(object)), editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== tab)
        throw new Error("Put the cursor in a method of " + shown.object_name + ", in the tab of its class source.");
      entryLine = editor.selection.active.line + 1;
    }
    // A function module runs whole: from the cursor in its tab, else from its first line.
    if (kind === "FUNC") {
      const tab = await pinTo(shown.system_name, () => sapCode.sourceUri({ object_name: shown.object_name, object_type: "FUNC", include: "main" }));
      const editor = vscode.window.activeTextEditor;
      entryLine = editor && editor.document.uri.toString() === tab ? editor.selection.active.line + 1 : 1;
    }
    const read = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "VERTEX: reading " + shown.object_name + " for the transpiler" },
      report => pinTo(shown.system_name, () => sapCode.transpileSources(shown, name => report.report({ message: name }))));
    const transpile = require("./sap-transpile"), file = transpile.writeProject(shown.system_name, read.sources, read.dictionary);
    // The programs' texts, for the selection screen the panel draws (local-run screenFor).
    fs.writeFileSync(path.join(path.dirname(path.dirname(file)), "vertex-texts.json"), JSON.stringify(read.texts || {}));
    // Each copy and the SAP tab it was read from: the run steps, marks and stops in the tab, not in the copy.
    const folder = path.dirname(path.dirname(file)), copies = [];
    for (const source of read.sources) {
      // A function group's module is its FUNC tab; its main program and includes have no VERTEX tab and stay copies.
      if (source.type === "FUGR" && source.kind !== "module") continue;
      const object = source.type === "FUGR" ? { object_name: source.include, object_type: "FUNC", include: "main" }
        : { object_name: source.name, object_type: source.type, include: source.include };
      copies.push({ path: transpile.copyPath(folder, source), object,
        uri: await pinTo(shown.system_name, () => sapCode.sourceUri(object)) });
    }
    const module = kind === "FUNC" && read.sources.find(source => source.kind === "module" && source.include === String(shown.object_name).toUpperCase());
    if (kind === "FUNC" && !module) throw new Error(shown.object_name + " was not among the modules read of its function group.");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(module ? transpile.copyPath(folder, module) : file));
    if (kind === "FUNC") entryLine = Math.max(entryLine, module.signature.firstLine);
    if (kind !== "PROG" && !require("./local-run").entryScreen(document, entryLine))
      throw new Error("Line " + entryLine + " of " + shown.object_name + " is in no method: put the cursor in the method to run.");
    openVisualDebug(true, { ...require("./local-analysis").sourceObject(document), local: true, document, entryLine, autoRun: true,
      sapCopies: { system: shown.system_name, copies } });
  };
  // F5-F8 are deliberately scoped in package.json to a VERTEX ABAP editor.
  // A stopped program is shared with Visual Debug, so stepping here redraws
  // the already open visual tab without a second debugger session.
  const stepFromSource = async kind => {
    // A step from a local file, or from the SAP tab of a source the transpiler run took a copy of.
    const fromRun = dockedDebugSource?.sapCopies && runPathOf(vscode.window.activeTextEditor?.document?.uri);
    if (require("./local-analysis").isLocalAbap(vscode.window.activeTextEditor?.document) || fromRun) {
      if (localDebugAdapter?.hasTrace() && dockedDebugView) {
        await dockedDebugView.webview.postMessage({ type: "historyStep", kind });
        return;
      }
      const command = { into: "workbench.action.debug.stepInto", over: "workbench.action.debug.stepOver",
        out: "workbench.action.debug.stepOut", continue: "workbench.action.debug.continue" }[kind];
      await vscode.commands.executeCommand(command);
      return;
    }
    if (!dbg.picture().stopped) {
      vscode.window.showWarningMessage("VERTEX: no stopped ABAP program. Open Visual Analysis / Debug and run to a breakpoint first.");
      return;
    }
    dbg.drivenBy("editor");
    try { await dbg.advance(kind); }
    catch (error) { vscode.window.showErrorMessage("VERTEX: " + error.message); }
  };
  context.subscriptions.push(vscode.commands.registerCommand("vertex.tools", initial => {
    if (!initial && require("./local-analysis").isLocalAbap(vscode.window.activeTextEditor?.document)) {
      const object = require("./local-analysis").sourceObject(vscode.window.activeTextEditor.document);
      return vscode.commands.executeCommand(object?.object_type === "CLAS" ? "vertex.tools.uml" : "vertex.tools.metrics");
    }
    return showTools(initial);
  }));
  require('./tools-context').register(vscode, context, sapCode, showTools);
  require('./local-run').register(vscode, context);
  context.subscriptions.push(
    vscode.commands.registerCommand("vertex.openVisualDebug", () => openVisualDebug(false)),
    // A local program run with the transpiler: the same panel, which shows the selection screen and the output until a
    // breakpoint is set, and the debugger then.
    vscode.commands.registerCommand("vertex.runTranspiler", async () => {
      if (require("./local-analysis").isLocalAbap(vscode.window.activeTextEditor?.document)) return openVisualDebug(true);
      try { await runSapTranspiler(sapCode.editorContext()); }
      catch (error) { vscode.window.showErrorMessage("VERTEX: " + error.message); }
    }),
    vscode.commands.registerCommand("vertex.debugInto", () => stepFromSource("into")),
    vscode.commands.registerCommand("vertex.debugOver", () => stepFromSource("over")),
    vscode.commands.registerCommand("vertex.debugOut", () => stepFromSource("out")),
    vscode.commands.registerCommand("vertex.debugContinue", () => stepFromSource("continue"))
  );
  require("./sidebar").register(vscode, context, active,
    require("./chat").create(vscode, chatTools, tools, context.secrets, () => latestDebugContext, () => require("./value-origin-view").originContext()), systems,
    () => withShownDiff(context, latestToolsContext));
  require("./log-report").register(vscode, context);
  serveTools(context, tools);
  // External clients cannot trigger a VS Code MCP provider. Start on activation
  // so a registered Codex/Claude connection also works after a window reload.
  if (port !== 0) {
    tools.start().catch(function (error) {
      vscode.window.showErrorMessage("VERTEX: " + error.message);
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("vertex.ai.chooseLogFolder", () => require("./model-config").chooseLogFolder(vscode)),
    vscode.commands.registerCommand("vertex.open", function () {
      showTools({ type: "TABL" });
    }),
    vscode.commands.registerCommand("vertex.metrics", function () {
      if (require("./local-analysis").isLocalAbap(vscode.window.activeTextEditor?.document)) {
        return vscode.commands.executeCommand("vertex.tools.metrics");
      }
      showTools({ type: "CLAS", action: "metrics" });
    }),
    vscode.commands.registerCommand("vertex.versions", function () {
      showTools({ type: "TR" });
    }),
    vscode.commands.registerCommand("vertex.importSystems", async function () {
      try { await require("./system-setup").importSystems(vscode, context); }
      catch (error) { vscode.window.showErrorMessage("VERTEX: " + error.message); }
    }),
    // Each configured system asked with its own user and password, the way every read is made: the answer says
    // which part of the setting is wrong.
    vscode.commands.registerCommand("vertex.testSystems", async function () {
      const all = systems();
      if (!all.length) { vscode.window.showWarningMessage("VERTEX: vertex.systems is empty. VERTEX: Import SAP Systems fills it from SAP Logon."); return; }
      const results = [];
      for (const system of all) {
        const gaps = missing(system);
        if (gaps.length) { results.push(system.name + ": no " + gaps.join(" and ") + " in the setting."); continue; }
        const pw = await password(context, system);
        if (!pw) { results.push(system.name + ": not tested - no password given."); continue; }
        try {
          const res = await request(system, pw, withClient(system, "/sap/bc/adt/discovery"));
          // A refused password is not kept: the next test or read asks for it again.
          if (res.status === 401) { await context.secrets.delete(secretKey(system)); }
          results.push(system.name + ": " + (res.status === 200 ? "OK - ADT answers for " + system.user + (system.client ? " in client " + system.client : "")
            : res.status === 401 ? "HTTP 401 - user or password refused; the stored password is dropped, the next test asks again"
            : describeFailure(res.status, res.body)));
        } catch (error) { results.push(system.name + ": " + describeConnection(error)); }
      }
      const failed = results.filter(r => !/: OK - /.test(r)).length;
      vscode.window[failed ? "showWarningMessage" : "showInformationMessage"]("VERTEX: " + results.join("  |  "), { modal: failed > 0 });
    }),
    vscode.commands.registerCommand("vertex.switchSystem", async function (requested) {
      const all = systems();
      if (all.length === 0) {
        vscode.window.showWarningMessage(
          "VERTEX: there is nothing to switch between. Put your systems in vertex.systems.");
        return;
      }
      const current = active();
      const picked = requested ? { label: requested } : await vscode.window.showQuickPick(
        all.map(function (s) {
          return {
            label: s.name,
            description: s.user + "@" + s.url + (s.client ? " client " + s.client : ""),
            picked: !current.error && current.system.name === s.name
          };
        }),
        { title: "Read from which system?" }
      );
      if (!picked) {
        return;
      }
      await vscode.workspace.getConfiguration("vertex")
        .update("active", picked.label, vscode.ConfigurationTarget.Global);
      // Panels already open keep what they last read; the next Load goes to the
      // system chosen here.
      vscode.window.showInformationMessage("VERTEX: now reading from " + picked.label + ".");
    }),
    vscode.commands.registerCommand("vertex.forgetPassword", async function () {
      const chosen = active();
      if (chosen.error) {
        vscode.window.showWarningMessage("VERTEX: " + chosen.error);
        return;
      }
      await context.secrets.delete(secretKey(chosen.system));
      vscode.window.showInformationMessage(
        "VERTEX: the stored password for " + chosen.system.name + " was removed.");
    }),
    vscode.commands.registerCommand("vertex.configureApiKey", async function () {
      const api = require("./openai-compatible");
      const provider = await vscode.window.showQuickPick([
        { label: "Anthropic", id: "anthropic" },
        ...Object.entries(api.PROVIDERS).map(([id, value]) => ({ label: value.label, id }))
      ], { title: "Which AI provider?" });
      if (!provider) { return; }
      const profile = await vscode.window.showInputBox({
        title: "Key name for " + provider.label,
        value: "DEFAULT", ignoreFocusOut: true,
        validateInput: value => String(value || "").trim() ? undefined : "Enter a key name."
      });
      if (profile === undefined) { return; }
      const value = await vscode.window.showInputBox({
        title: "API key for " + provider.label,
        prompt: "The key is stored in VS Code SecretStorage, never in settings.json.",
        password: true,
        ignoreFocusOut: true,
        validateInput: text => String(text || "").trim() ? undefined : "Enter an API key."
      });
      if (value === undefined) { return; }
      await require("./key-profiles").save(context.secrets,
        provider.id === "anthropic" ? "anthropic-api" : provider.id, profile, value);
      vscode.window.showInformationMessage(provider.label + " API key '" + profile.trim() + "' saved securely.");
    }),
    vscode.commands.registerCommand("vertex.selectProvider", async function () {
      const values = require("./model-config").PROVIDERS.map(provider => [provider.label, provider.setting]);
      const current = vscode.workspace.getConfiguration("vertex.ai").get("provider", "codex-subscription");
      const picked = await vscode.window.showQuickPick(values.map(item => ({
        label: item[0], picked: item[1] === current, id: item[1]
      })), { title: "Select VERTEX AI provider" });
      if (!picked) { return; }
      const settings = vscode.workspace.getConfiguration("vertex.ai");
      if (picked.id !== current) {
        await settings.update("provider", picked.id, vscode.ConfigurationTarget.Global);
        await settings.update("model", "", vscode.ConfigurationTarget.Global);
      }
      vscode.window.showInformationMessage("VERTEX: using " + picked.label + ".");
    })
  );
  return { sapCode };
}

function deactivate() {
  if (tools) { tools.stop(); tools = null; }
}

exports.activate = activate;
exports.deactivate = deactivate;
