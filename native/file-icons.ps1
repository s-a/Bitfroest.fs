$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$json = [Console]::In.ReadToEnd()
if ($json.Length -gt 524288) { throw 'Icon request exceeds limit.' }
$requests = $json | ConvertFrom-Json
if ($requests.Count -gt 24) { throw 'Too many icon requests.' }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FileIconReader {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFO {
        public IntPtr hIcon;
        public int iIcon;
        public uint attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string displayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string typeName;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfo(string path, uint attributes, ref SHFILEINFO info, uint size, uint flags);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern uint ExtractIconEx(string file, int index, IntPtr[] largeIcons, IntPtr[] smallIcons, uint count);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@

function Get-LocalPath([string]$Value, [string]$Directory = '') {
    if (-not $Value -or $Value.Length -gt 4096 -or $Value.Contains([char]0)) { return $null }
    $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
    if ($expanded.StartsWith('@')) { $expanded = $expanded.Substring(1) }
    if ($expanded.StartsWith('\') -or $expanded.StartsWith('/')) { return $null }
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        if (-not $Directory) { return $null }
        $expanded = [IO.Path]::Combine($Directory, $expanded)
    }
    $fullPath = [IO.Path]::GetFullPath($expanded)
    if ($fullPath -notmatch '^[A-Za-z]:\\') { return $null }
    $ancestor = $fullPath
    while ($ancestor) {
        if ([IO.File]::Exists($ancestor) -or [IO.Directory]::Exists($ancestor)) {
            if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) { return $null }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $fullPath
}

function Read-DesktopResource([string]$Directory) {
    $iniPath = [IO.Path]::Combine($Directory, 'desktop.ini')
    if (-not [IO.File]::Exists($iniPath)) { return $null }
    $file = Get-Item -LiteralPath $iniPath -Force
    if ($file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
    $section = ''
    $values = @{}
    foreach ($line in ([IO.File]::ReadAllText($iniPath, [Text.Encoding]::Default) -split '\r?\n')) {
        $text = $line.Trim()
        if ($text -match '^\[(.*)\]$') { $section = $Matches[1]; continue }
        if ($section -eq '.ShellClassInfo' -and $text -match '^([^;=]+)=(.*)$') { $values[$Matches[1].Trim()] = $Matches[2].Trim() }
    }
    if ($values.IconResource) { return $values.IconResource }
    if ($values.IconFile) { return $values.IconFile + ',' + $(if ($values.IconIndex) { $values.IconIndex } else { '0' }) }
    return $null
}

function Get-ResourceIcon([string]$Resource, [string]$Directory) {
    if (-not $Resource) { return [IntPtr]::Zero }
    $index = 0
    $resourcePath = $Resource
    if ($Resource -match '^(.*),\s*(-?\d+)\s*$') { $resourcePath = $Matches[1]; $index = [int]$Matches[2] }
    if ($index -lt -65535 -or $index -gt 65535) { return [IntPtr]::Zero }
    $filePath = Get-LocalPath $resourcePath $Directory
    if (-not $filePath -or -not [IO.File]::Exists($filePath)) { return [IntPtr]::Zero }
    $file = Get-Item -LiteralPath $filePath -Force
    if ($file.Length -gt 268435456 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return [IntPtr]::Zero }
    if ([IO.Path]::GetExtension($filePath).ToLowerInvariant() -notin @('.ico', '.exe', '.dll', '.icl')) { return [IntPtr]::Zero }
    $small = [IntPtr[]]::new(1)
    $large = [IntPtr[]]::new(1)
    [void][FileIconReader]::ExtractIconEx($filePath, $index, $large, $small, 1)
    if ($large[0] -ne [IntPtr]::Zero) { [void][FileIconReader]::DestroyIcon($large[0]) }
    return $small[0]
}

$result = @()
foreach ($request in $requests) {
    $iconHandle = [IntPtr]::Zero
    $encoded = $null
    try {
        if (-not ($request.key -is [string]) -or $request.key.Length -gt 300) { continue }
        $folder = $request.type -eq 'folder'
        $localPath = Get-LocalPath ([string]$request.path)
        $exists = $localPath -and $(if ($folder) { [IO.Directory]::Exists($localPath) } else { [IO.File]::Exists($localPath) })
        if ($exists) {
            $file = Get-Item -LiteralPath $localPath -Force
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { $exists = $false }
        }
        $directory = if ($folder -and $exists) { $localPath } elseif ($localPath) { [IO.Path]::GetDirectoryName($localPath) } else { '' }
        $resource = [string]$request.iconResource
        if (-not $resource -and $folder -and $exists) { $resource = Read-DesktopResource $localPath }
        if ($resource) { $iconHandle = Get-ResourceIcon $resource $directory }
        if ($iconHandle -eq [IntPtr]::Zero) {
            $info = [FileIconReader+SHFILEINFO]::new()
            [uint32]$flags = 0x100 -bor 0x1
            $lookup = if ($exists) { $localPath } else { [IO.Path]::GetFileName([string]$request.name) }
            if (-not $lookup) { $lookup = if ($folder) { 'folder' } else { 'file' } }
            if (-not $exists) { $flags = $flags -bor 0x10 }
            [uint32]$attributes = if ($folder) { 0x10 } else { 0x80 }
            [void][FileIconReader]::SHGetFileInfo($lookup, $attributes, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), $flags)
            $iconHandle = $info.hIcon
        }
        if ($iconHandle -ne [IntPtr]::Zero) {
            $icon = [Drawing.Icon]::FromHandle($iconHandle)
            $bitmap = $icon.ToBitmap()
            $stream = [IO.MemoryStream]::new()
            try {
                $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
                if ($stream.Length -le 65536) { $encoded = 'data:image/png;base64,' + [Convert]::ToBase64String($stream.ToArray()) }
            } finally { $stream.Dispose(); $bitmap.Dispose(); $icon.Dispose() }
        }
    } catch { $encoded = $null }
    finally { if ($iconHandle -ne [IntPtr]::Zero) { [void][FileIconReader]::DestroyIcon($iconHandle) } }
    $result += [pscustomobject]@{ key = [string]$request.key; icon = $encoded }
}
ConvertTo-Json -InputObject @($result) -Compress -Depth 3
