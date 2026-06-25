param(
  [string]$LogPath = "C:\Immich\migration-logs\delete_inactive_data_20260625.log"
)

$ErrorActionPreference = "Stop"

$targets = @(
  "X:\Immich\uploads\thumbs_DISABLED_PREVIEW_TEST_20260625",
  "X:\Immich\uploads\backups",
  "X:\Immich\database",
  "X:\Immich\redis",
  "X:\Immich\manual-db-backups",
  "X:\Immich\database.bak_20251030_1954",
  "X:\Immich\config-backups"
)

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "s"), $Message
  Add-Content -LiteralPath $LogPath -Value $line
}

Write-Log "Starting inactive Immich data deletion"
$before = Get-PSDrive -Name X
Write-Log ("FreeBeforeBytes={0}" -f $before.Free)

$root = [System.IO.Path]::GetFullPath("X:\Immich\")

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Log "SKIP missing $target"
    continue
  }

  $resolved = (Resolve-Path -LiteralPath $target).ProviderPath
  $full = [System.IO.Path]::GetFullPath($resolved)

  if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete outside X:\Immich: $full"
  }

  Write-Log "DELETE start $full"
  Remove-Item -LiteralPath $full -Recurse -Force
  Write-Log "DELETE done $full"
}

$after = Get-PSDrive -Name X
Write-Log ("FreeAfterBytes={0}" -f $after.Free)
Write-Log ("FreedBytes={0}" -f ($after.Free - $before.Free))
Write-Log "Finished inactive Immich data deletion"

[pscustomobject]@{
  FreeBeforeGB = [math]::Round($before.Free / 1GB, 3)
  FreeAfterGB = [math]::Round($after.Free / 1GB, 3)
  FreedGB = [math]::Round(($after.Free - $before.Free) / 1GB, 3)
  LogPath = $LogPath
}
