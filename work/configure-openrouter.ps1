$ErrorActionPreference = 'Stop'
$secretDirectory = Join-Path $PSScriptRoot 'private'
New-Item -ItemType Directory -Force -Path $secretDirectory | Out-Null
$secret = Read-Host 'OpenRouter key (hidden)' -AsSecureString
try {
    if ($secret.Length -eq 0) { throw 'No key entered. The previous configuration was kept.' }
    $taskCredential = New-Object System.Management.Automation.PSCredential('openrouter', $secret)
    $taskHeaders = @{ Authorization = 'Bearer ' + $taskCredential.GetNetworkCredential().Password.Trim() }
    Write-Host 'Checking the key with OpenRouter. This does not run a model or charge for inference.'
    try {
        $taskCheck = Invoke-RestMethod -Uri 'https://openrouter.ai/api/v1/key' -Method Get -Headers $taskHeaders -MaximumRedirection 0 -TimeoutSec 20
    } catch {
        $taskStatus = 0
        if ($_.Exception.Response) { $taskStatus = [int]$_.Exception.Response.StatusCode }
        if ($taskStatus -eq 401 -or $taskStatus -eq 403) { throw 'OpenRouter rejected this key. Copy an active key from OpenRouter and run setup again. The previous configuration was kept.' }
        throw 'Could not validate the key with OpenRouter. Check your connection and run setup again. The previous configuration was kept.'
    } finally {
        $taskHeaders.Clear()
        $taskCredential = $null
    }
    if (!$taskCheck.data) { throw 'OpenRouter returned an unexpected key response. The previous configuration was kept.' }
    $secret | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $secretDirectory 'openrouter.dpapi')
    'openrouter' | Set-Content -LiteralPath (Join-Path $secretDirectory 'inference-provider.txt')
    if ($null -ne $taskCheck.data.limit_remaining -and $taskCheck.data.limit_remaining -le 0) {
        Write-Host 'The key is valid, but its spending allowance is exhausted. Update its limit or credits in OpenRouter before generating games.'
    }
    Write-Output 'OpenRouter key validated and encrypted for this Windows user.'
} finally {
    $secret.Dispose()
    $taskCheck = $null
}
