param(
    [string]$Scene,
    [string]$CodePath,
    [string]$DemoRoot = 'C:\tmp\bf.fs\demo'
)
$ErrorActionPreference = 'Stop'
if (-not $CodePath) {
    $codeCommand = Get-Command code.cmd -ErrorAction Stop
    $CodePath = Join-Path (Split-Path (Split-Path $codeCommand.Source)) 'Code.exe'
}
$renderArguments = @((Join-Path $PSScriptRoot 'scripts/showcases/run.cjs'), '--code', $CodePath, '--demo', $DemoRoot)
if ($Scene) { $renderArguments += @('--scene', $Scene) }
& node @renderArguments
if ($LASTEXITCODE -ne 0) { throw "Showcase rendering failed with exit code $LASTEXITCODE." }
