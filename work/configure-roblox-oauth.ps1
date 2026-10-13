$ErrorActionPreference = 'Stop'

function Assert-RopadRobloxOAuthConfig {
  param([string]$ClientId, [string]$RedirectUri)
  if ($ClientId -cnotmatch '^[A-Za-z0-9_-]{1,200}$') { throw 'Enter the public client ID shown in the Roblox OAuth app registration' }
  $taskCallback = $null
  if ($RedirectUri.Length -gt 256 -or $RedirectUri -cmatch '[\s\\]' -or
      $RedirectUri -cnotmatch '^https?://[^/?#]+/roblox/oauth/callback$' -or
      ![Uri]::TryCreate($RedirectUri, [UriKind]::Absolute, [ref]$taskCallback) -or
      $taskCallback.UserInfo -or $taskCallback.Query -or $taskCallback.Fragment -or
      $taskCallback.AbsolutePath -cne '/roblox/oauth/callback' -or !$taskCallback.Host -or
      ($taskCallback.Scheme -eq 'http' -and $taskCallback.Host -notin @('localhost','127.0.0.1'))) {
    throw 'Use HTTPS, or HTTP on localhost or 127.0.0.1, with exactly /roblox/oauth/callback and no query, fragment or credentials'
  }
}

function Set-RopadOAuthFile {
  param([string]$Path, [byte[]]$Bytes)
  # Only encrypted secret bytes or public configuration ever enter this file.
  $taskTemporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllBytes($taskTemporary, $Bytes)
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($taskTemporary, $Path, $null) }
    else { [IO.File]::Move($taskTemporary, $Path) }
  } finally {
    if ([IO.File]::Exists($taskTemporary)) { Remove-Item -LiteralPath $taskTemporary -Force }
  }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This setup helper requires Windows DPAPI; use server environment secrets on hosted systems' }
$taskPrivate = Join-Path $PSScriptRoot 'private'
$taskConfigPath = Join-Path $taskPrivate 'roblox-oauth-config.json'
$taskSecretPath = Join-Path $taskPrivate 'roblox-oauth-secret.dpapi'
foreach ($taskPath in @($taskPrivate, $taskConfigPath, $taskSecretPath)) {
  if ((Test-Path -LiteralPath $taskPath) -and ((Get-Item -LiteralPath $taskPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'OAuth settings must be regular files in the private folder, not links' }
}
$taskExisting = $null
if (Test-Path -LiteralPath $taskConfigPath) {
  try {
    $taskExisting = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
    if ($taskExisting.version -ne 1) { throw 'Unsupported configuration version' }
    Assert-RopadRobloxOAuthConfig -ClientId $taskExisting.clientId -RedirectUri $taskExisting.redirectUri
  } catch { throw 'Existing Roblox OAuth settings are unreadable; preserve them for recovery before replacing them' }
}

Write-Host 'Configure Roblox account linking for Ropad'
Write-Host 'Register a confidential app with identity scopes openid and profile only'
Write-Host 'Keep this secret on the server; never paste it into chat or the browser'
$taskClientId = (Read-Host 'Roblox OAuth client ID (Enter keeps the saved value)').Trim()
if (!$taskClientId -and $taskExisting) { $taskClientId = [string]$taskExisting.clientId }
$taskDefaultRedirect = 'http://localhost:61281/roblox/oauth/callback'
if ($taskExisting) { $taskDefaultRedirect = [string]$taskExisting.redirectUri }
$taskRedirect = (Read-Host ('Exact registered redirect URL (Enter uses ' + $taskDefaultRedirect + ')')).Trim()
if (!$taskRedirect) { $taskRedirect = $taskDefaultRedirect }
Assert-RopadRobloxOAuthConfig -ClientId $taskClientId -RedirectUri $taskRedirect
if ($taskRedirect -eq 'https://ropad.fun/roblox/oauth/callback') {
  Write-Host 'The persistent Ropad backend must serve this production callback before account linking will work'
}

$taskSecret = $null
$taskEncrypted = $null
$taskPreviousSecret = $null
$taskPreviousConfig = $null
$taskSecretWritten = $false
$taskConfigWritten = $false
try {
  $taskSecret = Read-Host 'Roblox OAuth client secret (hidden input; Enter keeps a saved secret)' -AsSecureString
  if (!$taskSecret -or $taskSecret.Length -gt 4096) { throw 'The client secret is missing or too long; existing settings are unchanged' }
  if ($taskSecret.Length -eq 0) {
    if (!(Test-Path -LiteralPath $taskSecretPath) -or !$taskExisting -or $taskClientId -cne [string]$taskExisting.clientId) { throw 'A new client ID needs its own secret; existing settings are unchanged' }
    $taskEncrypted = [IO.File]::ReadAllText($taskSecretPath).Trim()
    $taskVerified = $null
    try { $taskVerified = ConvertTo-SecureString $taskEncrypted; if (!$taskVerified.Length) { throw 'Empty stored secret' } }
    catch { throw 'The saved secret cannot be decrypted by this Windows account; existing settings are unchanged' }
    finally { if ($taskVerified) { $taskVerified.Dispose() } }
  } else {
    $taskEncrypted = ConvertFrom-SecureString $taskSecret
  }
  # Validate everything before touching existing files. A failed second commit
  # restores the first file, so a mismatched ID and secret are not left behind.
  $taskConfig = [ordered]@{ version = 1; clientId = $taskClientId; redirectUri = $taskRedirect }
  $taskEncoding = New-Object System.Text.UTF8Encoding($false)
  $taskConfigBytes = $taskEncoding.GetBytes(($taskConfig | ConvertTo-Json))
  $taskSecretBytes = $taskEncoding.GetBytes($taskEncrypted)
  if (Test-Path -LiteralPath $taskSecretPath) { $taskPreviousSecret = [IO.File]::ReadAllBytes($taskSecretPath) }
  if (Test-Path -LiteralPath $taskConfigPath) { $taskPreviousConfig = [IO.File]::ReadAllBytes($taskConfigPath) }
  if (!(Test-Path -LiteralPath $taskPrivate)) { [void](New-Item -ItemType Directory -Path $taskPrivate) }
  try {
    Set-RopadOAuthFile -Path $taskSecretPath -Bytes $taskSecretBytes; $taskSecretWritten = $true
    Set-RopadOAuthFile -Path $taskConfigPath -Bytes $taskConfigBytes; $taskConfigWritten = $true
  } catch {
    try {
      if ($taskSecretWritten) { if ($null -ne $taskPreviousSecret) { Set-RopadOAuthFile -Path $taskSecretPath -Bytes $taskPreviousSecret } else { Remove-Item -LiteralPath $taskSecretPath -Force } }
      if ($taskConfigWritten) { if ($null -ne $taskPreviousConfig) { Set-RopadOAuthFile -Path $taskConfigPath -Bytes $taskPreviousConfig } else { Remove-Item -LiteralPath $taskConfigPath -Force } }
    } catch { throw 'OAuth storage failed and rollback needs review; preserve the private folder before restarting' }
    throw 'OAuth settings could not be saved; the previous files were restored'
  }
  Write-Host 'Roblox OAuth settings saved with Windows DPAPI protection'
  Write-Host ('Registered callback must match exactly: ' + $taskRedirect)
  Write-Host 'No server was restarted; use the current approved Ropad restart helper when ready'
  Write-Host 'Account linking does not sign into Studio or grant permission to publish games'
} finally {
  if ($taskSecret) { $taskSecret.Dispose() }
  $taskSecret = $null
  $taskEncrypted = $null
  $taskSecretBytes = $null
  $taskPreviousSecret = $null
}
