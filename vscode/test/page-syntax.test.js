"use strict";
// Every inline script of the pages parses: one stray quote stops the whole page, and the panel is left blank without a word.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path");
const folders = [path.join(__dirname, "..", "pages"), path.join(__dirname, "..", "..", "org.vertex.abap.ui", "resources")];
for (const folder of folders) {
  for (const name of fs.readdirSync(folder).filter(n => n.endsWith(".html"))) {
    test("the scripts of " + path.basename(folder) + "/" + name + " parse", () => {
      const html = fs.readFileSync(path.join(folder, name), "utf8"), re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
      let m, n = 0;
      while ((m = re.exec(html))) {
        n++;
        // The host writes its values into the marked places; a placeholder stands for them here.
        const code = m[1].replace(/\/\*([A-Z-]+)\*\/[\s\S]*?\/\*\1\*\//g, "null");
        assert.doesNotThrow(() => new Function(code), "script " + n + " of " + name);
      }
    });
  }
}
