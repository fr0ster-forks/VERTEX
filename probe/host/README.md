# Host probe

Development probe, not part of any shipped host. It checks gate 2: the VS Code extension host's
Node version and whether `@mcp-abap-adt/auth-broker`, `@mcp-abap-adt/connection` and
`@mcp-abap-adt/sap-rfc-lite` load inside it.

## Run (Windows)

In Command Prompt, install with the SAP NW RFC SDK visible:

```bat
cd probe\host
set SAPNWRFC_HOME=C:\nwrfcsdk\nwrfcsdk
set PATH=C:\nwrfcsdk\nwrfcsdk\lib;%PATH%
npm install
```

Check that `node_modules\@mcp-abap-adt\sap-rfc-lite\build\Release\sapnwrfc.node` exists.
The native dependency is optional; npm can silently drop it if its build fails.

Start VS Code from that same shell so its PATH carries the SDK (replace the placeholder with
the absolute repository path):

```bat
code --extensionDevelopmentPath="<absolute path>\probe\host"
```

In the Extension Development Host, open the Command Palette, run **VERTEX Probe: Report Host**,
and copy the JSON it opens. The report contains no credential and no system data.
