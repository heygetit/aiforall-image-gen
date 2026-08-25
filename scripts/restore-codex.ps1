[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Arguments
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "codex-setup.mjs"
& node $script --restore @Arguments
exit $LASTEXITCODE
