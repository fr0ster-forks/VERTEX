# See package.js for the warning about vsce --no-dependencies.
param(
    [ValidateSet('universal','win32-x64','darwin-arm64')][string]$Target='universal',
    [switch]$KeepNodeModules
)
$nodeArgs = @((Join-Path $PSScriptRoot 'package.js'), '--target', $Target)
if ($KeepNodeModules) { $nodeArgs += '--keep-node-modules' }
& node @nodeArgs
exit $LASTEXITCODE
