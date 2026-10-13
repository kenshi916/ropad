$ErrorActionPreference = 'Stop'
$taskSecretDirectory = Join-Path $PSScriptRoot 'private'
New-Item -ItemType Directory -Force -Path $taskSecretDirectory | Out-Null
$taskSecret = Read-Host 'Orbio gateway API key (hidden; not a wallet private key)' -AsSecureString
if ($taskSecret.Length -eq 0) { $taskSecret.Dispose(); throw 'No key was entered; configuration is unchanged' }
try {
  $taskSecret | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $taskSecretDirectory 'orbio.dpapi')
  'orbio' | Set-Content -LiteralPath (Join-Path $taskSecretDirectory 'inference-provider.txt')
} finally { $taskSecret.Dispose() }
Write-Output 'Orbio key encrypted for this Windows user and selected as the inference provider'
Write-Output 'Restart Parallax to apply it The key account pays for AI; launch fees are not a local compute balance'
