[CmdletBinding()]
param(
  [switch] $CheckOnly,
  [switch] $NativeOnly
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "codex-setup.mjs"
if ($CheckOnly) {
  & node $script --configure-key --check-only
  exit $LASTEXITCODE
}

function Read-SecretKey([string] $Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

$mainKey = $null
$nativeKey = $null
if (-not $NativeOnly) {
  $mainKey = Read-SecretKey "gpt-image-2 API key (Enter to keep current)"
}
$nativeKey = Read-SecretKey "Optional gpt-image-1.5 API key (Enter to skip)"
if ([string]::IsNullOrWhiteSpace($mainKey) -and [string]::IsNullOrWhiteSpace($nativeKey)) {
  & node $script --configure-key --check-only
} else {
  $env:AIFORALL_SETUP_MAIN_KEY = $mainKey
  $env:AIFORALL_SETUP_NATIVE_KEY = $nativeKey
  & node $script --configure-key
  Remove-Item Env:AIFORALL_SETUP_MAIN_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:AIFORALL_SETUP_NATIVE_KEY -ErrorAction SilentlyContinue
}
exit $LASTEXITCODE
