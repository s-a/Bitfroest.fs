$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
while ($null -ne ($searchLine = [Console]::ReadLine())) {
    try {
        $searchRequest = $searchLine | ConvertFrom-Json
        @{ attributes = [int][IO.File]::GetAttributes([string]$searchRequest.path) } | ConvertTo-Json -Compress
    } catch {
        @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
}
