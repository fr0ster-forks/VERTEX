# VERTEX MCP in Claude Code or Codex (optional)

The panel's chat needs nothing more. This step is for working in Claude Code or Codex themselves - in a terminal or their own window - with VERTEX's SAP tools: reading code, reviews, the debugger.

**Add the VERTEX MCP server** copies what to paste: a command for Claude Code, a section of `config.toml` for Codex. Copilot finds the server by itself.

Choose **Codex** or **Claude Code** once. VERTEX copies configuration for both servers:

| Server | Capabilities |
|---|---|
| `vertex` | Read transport objects and review status; inspect code diffs with review blocks and saved verdicts. Uses standard ADT; no VERTEX ABAP classes required. Cannot save or approve reviews. |
| `vertex-debug` | Set breakpoints, start a run in WebGUI, inspect stops, stack and variables, and step or continue through the SAP debugger. Does not change code, data or variable values. |

For Codex, paste both sections into `~/.codex/config.toml`, replacing existing
`vertex` and `vertex-debug` sections. For Claude Code, run both copied commands;
remove existing registrations of those names first if needed. Restart the assistant
and start a new conversation. Keep this VS Code window open while using either server.

This connects the external assistant to VERTEX. The chat inside the VERTEX panel
already receives its tools automatically and does not need this setup.

Done once per computer. Later it is in the Command Palette (type *MCP*), under `vertex.mcp.port` in Settings, and here under **Help > Get Started**.
