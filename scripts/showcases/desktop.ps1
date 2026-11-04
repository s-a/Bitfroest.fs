param([string]$RunDirectory)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $RunDirectory 'launch.json') -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ShowcaseDesktop {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SI { public int cb; public string reserved; public string desktop; public string title; public int x,y,cx,cy,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,int flags,uint access,IntPtr security);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string app,System.Text.StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
"@
$desktopName = 'BfRender' + [Guid]::NewGuid().ToString('N')
$desktopHandle = [ShowcaseDesktop]::CreateDesktop($desktopName,[IntPtr]::Zero,[IntPtr]::Zero,0,0x01FF,[IntPtr]::Zero)
if ($desktopHandle -eq [IntPtr]::Zero) { throw "CreateDesktop failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
 $startInfo = New-Object ShowcaseDesktop+SI
 $startInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf($startInfo)
 $startInfo.desktop = 'winsta0\' + $desktopName
 $processInfo = New-Object ShowcaseDesktop+PI
 $appPath = $config.code
 $argsText = '"' + $appPath + '" --new-window --disable-gpu --disable-workspace-trust --skip-welcome --skip-release-notes --user-data-dir="' + $RunDirectory + '\profile" --extensions-dir="' + $RunDirectory + '\extensions" --extensionDevelopmentPath="' + $config.repository + '" --extensionTestsPath="' + $config.tests + '" --remote-debugging-port=' + $config.port
 $command = New-Object System.Text.StringBuilder($argsText)
 if (-not [ShowcaseDesktop]::CreateProcess($appPath,$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0,[IntPtr]::Zero,$RunDirectory,[ref]$startInfo,[ref]$processInfo)) { throw "CreateProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
 $processInfo.pid | Set-Content -LiteralPath (Join-Path $RunDirectory 'process-id.txt')
 [ShowcaseDesktop]::CloseHandle($processInfo.thread) | Out-Null
 try {
   $deadline = [DateTime]::UtcNow.AddSeconds(180)
   while ([ShowcaseDesktop]::WaitForSingleObject($processInfo.process,200) -eq 258 -and [DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $RunDirectory 'stop'))) { }
 } finally {
   if ([ShowcaseDesktop]::WaitForSingleObject($processInfo.process,0) -eq 258) {
     & taskkill.exe /PID $processInfo.pid /T /F | Out-Null
   }
   [ShowcaseDesktop]::WaitForSingleObject($processInfo.process,10000) | Out-Null
   [ShowcaseDesktop]::CloseHandle($processInfo.process) | Out-Null
 }
} finally {
 if (-not [ShowcaseDesktop]::CloseDesktop($desktopHandle)) { throw 'The showcase desktop could not be closed.' }
}
