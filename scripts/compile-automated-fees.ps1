$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $projectRoot ".tools\solc-0.8.24.exe"
$expectedCompilerHash = "580EE56B61BBCAAD953117E1E4A0874D90E6AF5CB4CE4359571D7DA25F6620E9"
$output = Join-Path $projectRoot "contracts\build-check"

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

if (-not (Test-Path -LiteralPath $compiler)) {
  throw "Missing pinned Solidity compiler at .tools\solc-0.8.24.exe. See contracts/TESTING.md."
}
if ((Get-Sha256 $compiler) -ne $expectedCompilerHash) {
  throw "Pinned Solidity compiler checksum mismatch."
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
& $compiler --optimize --optimize-runs 200 --bin --bin-runtime --abi `
  (Join-Path $projectRoot "contracts\src\PonsBotFeeControl.sol") `
  (Join-Path $projectRoot "contracts\src\PonsBotFeeVault.sol") `
  (Join-Path $projectRoot "contracts\src\PonsBotFeeVaultFactory.sol") `
  (Join-Path $projectRoot "contracts\src\PonsBotBuybackAdapter.sol") `
  (Join-Path $projectRoot "contracts\src\PonsBotNativeBuybackExecutor.sol") `
  (Join-Path $projectRoot "contracts\src\PonsBotPairedBuybackExecutor.sol") `
  -o $output --overwrite
if ($LASTEXITCODE -ne 0) { throw "Solidity compilation failed." }

$vaultCreationHex = (Get-Content -LiteralPath (Join-Path $output "PonsBotFeeVault.bin") -Raw).Trim()
$vaultRuntimeHex = (Get-Content -LiteralPath (Join-Path $output "PonsBotFeeVault.bin-runtime") -Raw).Trim()
$vaultCreationBytes = [math]::Floor($vaultCreationHex.Length / 2)
$vaultRuntimeBytes = [math]::Floor($vaultRuntimeHex.Length / 2)
if ($vaultRuntimeBytes -ge 24576) { throw "Vault deployed runtime bytecode exceeds the EIP-170 size limit: $vaultRuntimeBytes bytes." }
Write-Host "Automated fee contracts compiled with Solidity 0.8.24. Vault creation bytecode: $vaultCreationBytes bytes; deployed runtime: $vaultRuntimeBytes bytes."
