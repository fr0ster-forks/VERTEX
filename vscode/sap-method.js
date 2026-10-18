"use strict";

// Return a bounded part of one ABAP implementation method. Source is still
// fetched from SAP as an object; only this slice enters the model context.
function extract(source, requested, fromLine = 1, limit = 120) {
  const name = String(requested || "").trim().toUpperCase();
  if (!/^[A-Z0-9_~\/]+$/.test(name)) throw new Error("Specify an exact ABAP method name.");
  if (!Number.isInteger(fromLine) || fromLine < 1) throw new Error("from_line must be positive.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error("limit must be 1..250.");
  const lines = String(source || "").split(/\r?\n/);
  const methods = [];
  let start = -1, found = null;
  for (let i = 0; i < lines.length; i++) {
    const opening = /^\s*METHOD\s+([A-Z0-9_~\/]+)\s*\./i.exec(lines[i]);
    if (opening) { start = i; methods.push(opening[1].toUpperCase()); }
    if (start >= 0 && /^\s*ENDMETHOD\s*\./i.test(lines[i])) {
      if (methods.at(-1) === name) { found = { start, end: i }; break; }
      start = -1;
    }
  }
  if (!found) return { found: false, method_name: name, available_methods: [...new Set(methods)].slice(0, 50) };
  const total = found.end - found.start + 1;
  if (fromLine > total) throw new Error("from_line is beyond the end of method " + name + " (" + total + " lines).");
  const first = found.start + fromLine - 1, last = Math.min(found.end + 1, first + limit);
  return { found: true, method_name: name, source: lines.slice(first, last).join("\n"),
    start_line: first + 1, end_line: last, total_lines: total,
    next_line: last <= found.end ? fromLine + last - first : null };
}

module.exports = { extract };
