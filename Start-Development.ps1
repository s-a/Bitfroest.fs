[CmdletBinding()]
param(
    [string]$CodeCommand = 'code'
)

$ErrorActionPreference = 'Stop'
$projectPath = $PSScriptRoot
$companionPath = Join-Path $projectPath 'scripts\development-host'

foreach ($dependency in @('node_modules\@zip.js\zip.js\package.json', 'native\binding.node')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectPath $dependency))) {
        throw 'Projektabhaengigkeiten oder das passende native Modul fehlen. Vor dem Entwicklungsstart bereitstellen und im Projektordner npm ci ausfuehren.'
    }
}

$launcher = Get-Command $CodeCommand -ErrorAction Stop
$launchArguments = @(
    '--new-window'
    "--extensionDevelopmentPath=$projectPath"
    "--extensionDevelopmentPath=$companionPath"
    $projectPath
)
& $launcher @launchArguments
if ($launcher.CommandType -eq 'Application' -and $LASTEXITCODE -ne 0) {
    throw "Der Entwicklungsstart ist fehlgeschlagen (Exitcode $LASTEXITCODE)."
}
