param(
    [string]$Scene,
    [string]$CodePath,
    [string]$DemoRoot
)
$ErrorActionPreference = 'Stop'
$renderArguments = @((Join-Path $PSScriptRoot 'scripts/showcases/run.cjs'))
if ($CodePath) { $renderArguments += @('--code', $CodePath) }
if ($DemoRoot) { $renderArguments += @('--demo', $DemoRoot) }
if ($Scene) { $renderArguments += @('--scene', $Scene) }
& node @renderArguments
if ($LASTEXITCODE -ne 0) { throw "Showcase rendering failed with exit code $LASTEXITCODE." }
