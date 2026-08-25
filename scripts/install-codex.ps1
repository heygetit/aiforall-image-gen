[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Arguments
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "codex-setup.mjs"
& node $script --install @Arguments
exit $LASTEXITCODE
