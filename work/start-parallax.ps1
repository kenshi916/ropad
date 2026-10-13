$ErrorActionPreference = 'Stop'
try {
$taskProviderFile = Join-Path $PSScriptRoot 'private/inference-provider.txt'
if (Test-Path -LiteralPath $taskProviderFile) {
  $taskProvider = (Get-Content -LiteralPath $taskProviderFile -Raw).Trim()
  if ($taskProvider -notin @('openrouter','orbio')) { throw 'Invalid inference provider configuration' }
  $env:PARALLAX_AI_PROVIDER = $taskProvider
}
foreach ($taskGateway in @('openrouter','orbio')) {
  $taskSecretFile = Join-Path $PSScriptRoot ('private/' + $taskGateway + '.dpapi')
  if (Test-Path -LiteralPath $taskSecretFile) {
    $taskSecret = Get-Content -LiteralPath $taskSecretFile | ConvertTo-SecureString
    $taskCredential = New-Object System.Management.Automation.PSCredential($taskGateway, $taskSecret)
    if ($taskGateway -eq 'orbio') { $env:ORBIO_API_KEY = $taskCredential.GetNetworkCredential().Password }
    else { $env:OPENROUTER_API_KEY = $taskCredential.GetNetworkCredential().Password }
    $taskSecret.Dispose()
  }
}

# Public configuration and the encrypted secret are separate. Deployment-provided
# environment values take precedence; no OAuth credentials are needed when the
# optional account-link feature has not been configured.
$taskOAuthConfigPath = Join-Path $PSScriptRoot 'private/roblox-oauth-config.json'
$taskOAuthSecretPath = Join-Path $PSScriptRoot 'private/roblox-oauth-secret.dpapi'
if ((!$env:ROBLOX_OAUTH_CLIENT_ID -or !$env:ROBLOX_OAUTH_REDIRECT_URI) -and (Test-Path -LiteralPath $taskOAuthConfigPath)) {
  try {
    $taskOAuthConfig = Get-Content -LiteralPath $taskOAuthConfigPath -Raw | ConvertFrom-Json
    if ($taskOAuthConfig.version -ne 1) { throw 'Unsupported configuration version' }
    if (!$env:ROBLOX_OAUTH_CLIENT_ID) { $env:ROBLOX_OAUTH_CLIENT_ID = [string]$taskOAuthConfig.clientId }
    if (!$env:ROBLOX_OAUTH_REDIRECT_URI) { $env:ROBLOX_OAUTH_REDIRECT_URI = [string]$taskOAuthConfig.redirectUri }
  } catch { throw 'Saved Roblox OAuth settings are invalid; preserve them for recovery' }
}
if (!$env:ROBLOX_OAUTH_CLIENT_SECRET -and (Test-Path -LiteralPath $taskOAuthSecretPath)) {
  $taskOAuthSecret = $null
  $taskOAuthCredential = $null
  try {
    $taskOAuthSecret = Get-Content -LiteralPath $taskOAuthSecretPath -Raw | ConvertTo-SecureString
    $taskOAuthCredential = New-Object System.Management.Automation.PSCredential('roblox-oauth', $taskOAuthSecret)
    $env:ROBLOX_OAUTH_CLIENT_SECRET = $taskOAuthCredential.GetNetworkCredential().Password
  } catch { throw 'The Roblox OAuth secret cannot be decrypted by this Windows account; use the setup helper to repair it' }
  finally { if ($taskOAuthSecret) { $taskOAuthSecret.Dispose() }; $taskOAuthSecret = $null; $taskOAuthCredential = $null }
}
if ($env:ROBLOX_OAUTH_CLIENT_ID -or $env:ROBLOX_OAUTH_CLIENT_SECRET -or $env:ROBLOX_OAUTH_REDIRECT_URI) {
  if ($env:ROBLOX_OAUTH_CLIENT_ID -cnotmatch '^[A-Za-z0-9_-]{1,200}$' -or !$env:ROBLOX_OAUTH_CLIENT_SECRET -or $env:ROBLOX_OAUTH_CLIENT_SECRET.Length -gt 4096) { throw 'Roblox OAuth requires a valid client ID, client secret and exact registered redirect URI' }
  $taskOAuthUri = $null
  $taskOAuthRedirect = $env:ROBLOX_OAUTH_REDIRECT_URI
  if (!$taskOAuthRedirect -or $taskOAuthRedirect.Length -gt 256 -or $taskOAuthRedirect -cmatch '[\s\\]' -or
      $taskOAuthRedirect -cnotmatch '^https?://[^/?#]+/roblox/oauth/callback$' -or
      ![Uri]::TryCreate($taskOAuthRedirect, [UriKind]::Absolute, [ref]$taskOAuthUri) -or
      $taskOAuthUri.UserInfo -or $taskOAuthUri.Query -or $taskOAuthUri.Fragment -or
      $taskOAuthUri.AbsolutePath -cne '/roblox/oauth/callback' -or !$taskOAuthUri.Host -or
      ($taskOAuthUri.Scheme -eq 'http' -and $taskOAuthUri.Host -notin @('localhost','127.0.0.1'))) { throw 'Roblox OAuth callback must use HTTPS or HTTP localhost/127.0.0.1 with exactly /roblox/oauth/callback' }
}
$env:PARALLAX_STATE_DIR = Join-Path $PSScriptRoot 'private'
& node (Join-Path $PSScriptRoot 'parallax/server.cjs')
} finally {
  Remove-Item Env:OPENROUTER_API_KEY,Env:ORBIO_API_KEY,Env:PARALLAX_AI_PROVIDER,Env:ROBLOX_OAUTH_CLIENT_SECRET,Env:ROBLOX_OAUTH_CLIENT_ID,Env:ROBLOX_OAUTH_REDIRECT_URI -ErrorAction SilentlyContinue
  $taskCredential = $null
  $taskOAuthCredential = $null
}
