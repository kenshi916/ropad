param(
  [string[]]$StudioIds = @(),
  [switch]$List,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
$taskRunner = Join-Path $PSScriptRoot 'parallax/studio-worker.cjs'
if (!(Test-Path -LiteralPath $taskRunner)) { $taskRunner = Join-Path $PSScriptRoot 'studio-worker.cjs' }
if (!(Test-Path -LiteralPath $taskRunner)) { throw 'The Parallax Studio worker runner is missing' }
$taskArgs = @($taskRunner)
if ($List) {
  & node @taskArgs '--list'
  exit $LASTEXITCODE
}
$taskSavedConfig = Join-Path $PSScriptRoot 'private/studio-workers.json'
if (!$StudioIds.Count -and (Test-Path -LiteralPath $taskSavedConfig)) {
  $taskConfig = Get-Content -LiteralPath $taskSavedConfig -Raw | ConvertFrom-Json
  $StudioIds = @($taskConfig.studioIds)
}
if ($StudioIds.Count -lt 1 -or $StudioIds.Count -gt 2) {
  throw 'Use -List to find Studio IDs, then pass -StudioIds with one or two empty unpublished Studio instances'
}
foreach ($taskStudioId in $StudioIds) {
  if (!$taskStudioId -or $taskStudioId.Length -gt 200 -or $taskStudioId -match '[\r\n]') { throw 'Invalid Studio instance ID' }
  $taskArgs += @('--studio-id', $taskStudioId)
}
if ($Once) { $taskArgs += '--once' }
$taskPrivate = Join-Path $PSScriptRoot 'private'
$taskKeyFile = Join-Path $taskPrivate 'studio-pool.key'
try {
  # Initializes the worker credential on the local server without returning it.
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:61281/api/builds/pool' -TimeoutSec 10
  if (!(Test-Path -LiteralPath $taskKeyFile)) { throw 'Start this copy of the Parallax server before starting its workers' }
  $taskPoolKey = (Get-Content -LiteralPath $taskKeyFile -Raw).Trim()
  if ($taskPoolKey -notmatch '^[a-f0-9]{64}$') { throw 'Invalid local Studio worker credential' }
  $env:PARALLAX_WORKER_KEY = $taskPoolKey
  $taskPoolKey = $null
  & node @taskArgs
  $taskExit = $LASTEXITCODE
} finally {
  Remove-Item Env:PARALLAX_WORKER_KEY -ErrorAction SilentlyContinue
  $taskPoolKey = $null
}
exit $taskExit
