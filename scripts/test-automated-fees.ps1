$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$forge = Join-Path $projectRoot ".tools\foundry-v1.7.1\forge.exe"
$expectedForgeHash = "6DF26C16A6E53519ABDD09FCDACF9AF1ECDB50E216EE1816FA8012B5A553EF48"

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

if (-not (Test-Path -LiteralPath $forge)) {
  throw "Missing pinned Foundry v1.7.1 at .tools\foundry-v1.7.1. See contracts/TESTING.md."
}
if ((Get-Sha256 $forge) -ne $expectedForgeHash) {
  throw "Pinned Foundry checksum mismatch."
}

Push-Location $projectRoot
try {
  & $forge test -vv
  if ($LASTEXITCODE -ne 0) { throw "Automated fee contract tests failed." }
} finally {
  Pop-Location
}
