param(
  [string]$LogPath = "C:\Immich\migration-logs\fast_delete_inactive_data_20260625.log"
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

$empty = "C:\Immich\migration-logs\empty-delete-source"
New-Item -ItemType Directory -Force -Path $empty | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "s"), $Message
  Add-Content -LiteralPath $LogPath -Value $line
}

$root = [System.IO.Path]::GetFullPath("X:\Immich\")
$before = Get-PSDrive -Name X
Write-Log "Starting fast inactive Immich data deletion"
Write-Log ("FreeBeforeBytes={0}" -f $before.Free)

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

  $name = ($full -replace '[\\/:*?"<>|]', '_').Trim('_')
  $roboLog = Join-Path (Split-Path -Parent $LogPath) "fast_delete_$name.log"
  Write-Log "MIRROR_EMPTY start $full"
  & robocopy.exe $empty $full /MIR /R:0 /W:0 /MT:128 /NFL /NDL /NP "/LOG:$roboLog" | Out-Null
  $exitCode = $LASTEXITCODE
  Write-Log "MIRROR_EMPTY done $full exit=$exitCode"

  if ($exitCode -ge 8) {
    throw "Robocopy failed for $full with exit code $exitCode; see $roboLog"
  }

  Remove-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
  Write-Log "REMOVE_EMPTY_DIR done $full"
}

$after = Get-PSDrive -Name X
Write-Log ("FreeAfterBytes={0}" -f $after.Free)
Write-Log ("FreedBytes={0}" -f ($after.Free - $before.Free))
Write-Log "Finished fast inactive Immich data deletion"

[pscustomobject]@{
  FreeBeforeGB = [math]::Round($before.Free / 1GB, 3)
  FreeAfterGB = [math]::Round($after.Free / 1GB, 3)
  FreedGB = [math]::Round(($after.Free - $before.Free) / 1GB, 3)
  LogPath = $LogPath
}
