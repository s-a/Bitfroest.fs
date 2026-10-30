$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { Add-Type -Path (Join-Path $PSScriptRoot 'folder-locks.cs') } catch { [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)); exit 1 }
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    if ($request.action -eq 'scan') {
      $result = [FolderLocks]::Scan([string]$request.path)
      $details = @{}
      foreach ($row in $result.rows) {
        if (-not $details.ContainsKey($row.pid)) {
          $details[$row.pid] = ''
          try {
            $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($row.pid)" -ErrorAction Stop
            if ($info -and [Math]::Abs($info.CreationDate.ToUniversalTime().Ticks - [long]$row.started) -lt 10000) { $details[$row.pid] = [string]$info.CommandLine }
          } catch { }
        }
        $row.commandLine = $details[$row.pid]
      }
    }
    elseif ($request.action -in @('unlock', 'terminate')) {
      $entries = @($request.rows | ForEach-Object { $row = New-Object FolderLocks+Entry; $row.pid = $_.pid; $row.started = $_.started; $row.file = $_.file; $row.kind = $_.kind; $row.handle = $_.handle; $row.module = $_.module; $row })
      $result = [FolderLocks]::Act([string]$request.action, [string]$request.path, [FolderLocks+Entry[]]$entries, [int]$request.hostPid)
    }
    elseif ($request.action -eq 'schedule') {
      $result = [FolderLocks]::Schedule([string]$request.path, [string]$request.backup)
    }
    elseif ($request.action -eq 'rename') { $result = [FolderLocks]::Rename([string]$request.path, [string]$request.destination) }
    else { throw 'Ungültige Sperrenaktion.' }
    [Console]::WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
  } catch { [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
}
