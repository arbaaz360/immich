param(
  [Parameter(Mandatory = $true)]
  [string]$Owner,

  [Parameter(Mandatory = $true)]
  [int]$Expected,

  [string]$SourceRoot = "X:\Immich\uploads\thumbs",
  [string]$DestRoot = "C:\Immich\thumbnail-cache",
  [string]$LogRoot = "C:\Immich\migration-logs",
  [int]$Threads = 32
)

$ErrorActionPreference = "Stop"

$sourceOwner = Join-Path $SourceRoot $Owner
$destOwner = Join-Path $DestRoot $Owner
$ownerLogRoot = Join-Path $LogRoot "robocopy_thumbnail_owner_${Owner}_shards"
$summaryPath = Join-Path $LogRoot "robocopy_thumbnail_owner_${Owner}_shards_summary.csv"

New-Item -ItemType Directory -Force -Path $destOwner | Out-Null
New-Item -ItemType Directory -Force -Path $ownerLogRoot | Out-Null

$shards = Get-ChildItem -LiteralPath $sourceOwner -Directory -Force | Sort-Object Name
$rows = @()

foreach ($shard in $shards) {
  $destShard = Join-Path $destOwner $shard.Name
  $log = Join-Path $ownerLogRoot "$($shard.Name).log"
  New-Item -ItemType Directory -Force -Path $destShard | Out-Null

  & robocopy.exe $shard.FullName $destShard "*-thumbnail.*" /S /COPY:DAT /DCOPY:DAT /R:1 /W:1 "/MT:$Threads" /NP "/LOG:$log" | Out-Null
  $exitCode = $LASTEXITCODE

  $copied = Get-ChildItem -LiteralPath $destShard -File -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
  $rows += [pscustomobject]@{
    Time = Get-Date -Format "s"
    Owner = $Owner
    Shard = $shard.Name
    ExitCode = $exitCode
    FilesInDestShard = $copied.Count
    BytesInDestShard = [int64]($copied.Sum)
  }
  $rows | Export-Csv -LiteralPath $summaryPath -NoTypeInformation
}

$total = Get-ChildItem -LiteralPath $destOwner -File -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
[pscustomobject]@{
  Owner = $Owner
  Files = $total.Count
  Expected = $Expected
  GB = [math]::Round(($total.Sum / 1GB), 3)
  Percent = [math]::Round(($total.Count / $Expected) * 100, 2)
  Summary = $summaryPath
}
