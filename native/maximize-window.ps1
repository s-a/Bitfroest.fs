param(
    [Parameter(Mandatory = $true)][string]$TitleToken,
    [Parameter(Mandatory = $true)][string]$ExecutablePath
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CommanderWindow {
    public delegate bool WindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr handle);
}
'@
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $targets = [Collections.Generic.List[IntPtr]]::new()
    $callback = [CommanderWindow+WindowCallback]{
        param($handle, $parameter)
        if (-not [CommanderWindow]::IsWindowVisible($handle)) { return $true }
        $text = [Text.StringBuilder]::new(2048)
        [void][CommanderWindow]::GetWindowText($handle, $text, $text.Capacity)
        if (-not $text.ToString().Contains($TitleToken)) { return $true }
        [uint32]$ownerId = 0
        [void][CommanderWindow]::GetWindowThreadProcessId($handle, [ref]$ownerId)
        $owner = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
        if ($owner -and $owner.Path -eq $ExecutablePath) { $targets.Add($handle) }
        return $true
    }
    [void][CommanderWindow]::EnumWindows($callback, [IntPtr]::Zero)
    if ($targets.Count -eq 1) {
        [void][CommanderWindow]::ShowWindowAsync($targets[0], 3)
        for ($confirmation = 0; $confirmation -lt 20; $confirmation++) {
            if ([CommanderWindow]::IsZoomed($targets[0])) { exit 0 }
            Start-Sleep -Milliseconds 50
        }
        throw 'Das Commander-Fenster wurde gefunden, aber nicht maximiert.'
    }
    Start-Sleep -Milliseconds 80
}
throw 'Das Commander-Fenster konnte nicht eindeutig zugeordnet werden.'
