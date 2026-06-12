# AI Coding Blue Wall - Windows PowerShell Update Script
# Usage: .\scripts\update.ps1

param(
    [int]$Days = 365,
    [string]$Config = "config.json",
    [switch]$Commit,
    [switch]$Push
)

$ErrorActionPreference = "Stop"

# Get script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

# Colors
function Write-Info { Write-Host "[INFO] $args" -ForegroundColor Green }
function Write-Warn { Write-Host "[WARN] $args" -ForegroundColor Yellow }
function Write-Error { Write-Host "[ERROR] $args" -ForegroundColor Red }

# Load configuration
function Load-Config {
    $configFile = Join-Path $ProjectDir $Config
    if (Test-Path $configFile) {
        $cfg = Get-Content $configFile | ConvertFrom-Json
        return @{
            Username = $cfg.username
            OutputSvg = $cfg.output_svg
            OutputData = $cfg.output_data
            Days = $cfg.days
        }
    } else {
        Write-Warn "Config file not found: $configFile"
        return @{
            Username = "user"
            OutputSvg = "assets/ai-blue-wall.svg"
            OutputData = "data/ai-usage.json"
            Days = 365
        }
    }
}

# Scan all supported tools
function Scan-Usage {
    param($Days, $Output)
    Write-Info "Scanning AI coding usage data..."
    python "$ScriptDir\scan_all_tools.py" --days $Days --output $Output
}

# Render SVG
function Render-Svg {
    param($Data, $Output, $Username, $Days)
    Write-Info "Generating blue wall SVG..."
    python "$ScriptDir\render_blue_wall.py" --data $Data --output $Output --username $Username --days $Days
}

# Commit changes
function Commit-Changes {
    if ($Commit) {
        Write-Info "Committing changes..."
        Set-Location $ProjectDir
        $cfg = Load-Config
        git add $cfg.OutputData $cfg.OutputSvg
        git commit -m "Update AI coding blue wall $(Get-Date -Format 'yyyy-MM-dd')"
    }
}

# Push changes
function Push-Changes {
    if ($Push) {
        Write-Info "Pushing changes..."
        Set-Location $ProjectDir
        git push
    }
}

# Main
function Main {
    Write-Info "Starting AI Coding Blue Wall update..."

    $cfg = Load-Config
    $outputData = Join-Path $ProjectDir $cfg.OutputData
    $outputSvg = Join-Path $ProjectDir $cfg.OutputSvg

    Scan-Usage -Days $Days -Output $outputData
    Render-Svg -Data $outputData -Output $outputSvg -Username $cfg.Username -Days $Days
    Commit-Changes
    Push-Changes

    Write-Info "Update complete!"
    Write-Info "SVG generated: $outputSvg"
    Write-Info "Data saved: $outputData"
}

Main
