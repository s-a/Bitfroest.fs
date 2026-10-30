param([Parameter(Mandatory = $true)][string]$EncodedPath, [switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPath))
if (-not [IO.Path]::IsPathRooted($target) -or $target.Contains([char]0) -or -not [IO.File]::Exists($target)) { throw 'Ungültiger Dateipfad.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FileAssociation {
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    private static extern int AssocQueryString(uint flags, uint str, string assoc, string extra, StringBuilder output, ref uint length);
    public static string Executable(string extension) {
        if (String.IsNullOrEmpty(extension)) return null;
        uint length = 32768;
        var output = new StringBuilder((int)length);
        return AssocQueryString(0, 2, extension, null, output, ref length) == 0 ? output.ToString() : null;
    }
}
'@
$executable = [FileAssociation]::Executable([IO.Path]::GetExtension($target))
$editor = [IO.Path]::GetFileName($executable) -in @('Code.exe', 'Code - Insiders.exe')
if (-not $editor -and -not $InspectOnly) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $target
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($target)
    $start.UseShellExecute = $true
    $launched = [Diagnostics.Process]::Start($start)
    if ($null -ne $launched) { $launched.Dispose() }
}
@{ editor = [bool]$editor } | ConvertTo-Json -Compress
