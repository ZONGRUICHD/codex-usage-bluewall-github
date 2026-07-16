# Create a Windows device snapshot, then merge snapshots from multiple devices.

param(
    [string]$Device = $env:COMPUTERNAME,
    [string[]]$Inputs = @(),
    [int]$Days = 365,
    [switch]$ScanOnly,
    [switch]$MergeOnly
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $ProjectDir "data"
$AssetsDir = Join-Path $ProjectDir "assets"
$Snapshot = Join-Path $DataDir "ai-usage-$Device.json"
$MergedData = Join-Path $DataDir "ai-usage.json"
$Svg = Join-Path $AssetsDir "ai-blue-wall.svg"

if ($ScanOnly -and $MergeOnly) {
    throw "-ScanOnly and -MergeOnly cannot be used together"
}

New-Item -ItemType Directory -Force -Path $DataDir, $AssetsDir | Out-Null

if (-not $MergeOnly) {
    python "$ScriptDir\scan_all_tools.py" `
        --days $Days `
        --device-name $Device `
        --output $Snapshot
    $Inputs += $Snapshot
}

if ($ScanOnly) {
    Write-Host "Created device snapshot: $Snapshot"
    exit 0
}

if ($Inputs.Count -eq 0) {
    $Inputs = @(
        Get-ChildItem -Path $DataDir -Filter "ai-usage-*.json" |
            Sort-Object FullName |
            ForEach-Object { $_.FullName }
    )
}

if ($Inputs.Count -eq 0) {
    throw "No device snapshots found. Pass one or more -Inputs files."
}

python "$ScriptDir\merge_devices.py" --inputs $Inputs --output $MergedData
node "$ScriptDir\render_blue_wall.js" `
    --data $MergedData `
    --output $Svg `
    --days $Days `
    --timezone Asia/Shanghai

Write-Host "Merged $($Inputs.Count) snapshot file(s) into $MergedData"
