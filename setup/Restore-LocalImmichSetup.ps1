param(
    [string]$ImmichRoot = 'X:\Immich',
    [string]$PatchRoot = 'C:\Immich\patches\immich-2.7.5',
    [bool]$InstallCompose = $true
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$patchSource = Join-Path $repoRoot 'patches\immich-2.7.5'
$reverseFaceSearchSource = Join-Path $repoRoot 'reverse-face-search'
$reverseFaceSearchTarget = 'C:\Immich\reverse-face-search'
$profilePicturePickerSource = Join-Path $repoRoot 'profile-picture-picker'
$profilePicturePickerTarget = 'C:\Immich\profile-picture-picker'
$composeTemplate = Join-Path $repoRoot 'docker\docker-compose.template.yml'

New-Item -ItemType Directory -Force -Path `
    'C:\Immich\database', `
    'C:\Immich\redis', `
    'C:\Immich\thumbnail-cache', `
    $reverseFaceSearchTarget, `
    $profilePicturePickerTarget, `
    'C:\Immich\profile-picture-picker-runs', `
    $PatchRoot, `
    $ImmichRoot | Out-Null

Copy-Item -Path (Join-Path $patchSource '*') -Destination $PatchRoot -Recurse -Force
Copy-Item -Path (Join-Path $reverseFaceSearchSource '*') -Destination $reverseFaceSearchTarget -Recurse -Force
Copy-Item -Path (Join-Path $profilePicturePickerSource '*') -Destination $profilePicturePickerTarget -Recurse -Force

if ($InstallCompose) {
    $targetCompose = Join-Path $ImmichRoot 'docker-compose.yml'
    if (Test-Path -LiteralPath $targetCompose) {
        $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
        $backupDir = Join-Path $ImmichRoot 'config-backups'
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        Copy-Item -LiteralPath $targetCompose -Destination (Join-Path $backupDir "docker-compose_before_restore_$stamp.yml") -Force
    }
    Copy-Item -LiteralPath $composeTemplate -Destination $targetCompose -Force
}

Write-Host "Patch files installed to $PatchRoot"
Write-Host "Reverse face search build context installed to $reverseFaceSearchTarget"
Write-Host "Profile picture picker build context installed to $profilePicturePickerTarget"
if ($InstallCompose) {
    Write-Host "Compose template installed to $ImmichRoot\docker-compose.yml"
    Write-Host "Create or update $ImmichRoot\.env with real API keys before starting Docker."
}
