# Scan this Windows device, merge every checked-in device snapshot, render the
# canonical SVG, and optionally publish the update to GitHub.

[CmdletBinding()]
param(
    [ValidateRange(7, 365)]
    [int]$Days = 365,

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Device = 'windows-main',

    [ValidateSet('codex', 'claude_code', 'mimocode', 'opencode', 'hermes')]
    [string[]]$Tools = @('codex'),

    [switch]$Commit,
    [switch]$Push,
    [switch]$SkipPull,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $ProjectDir 'data'
$Snapshot = Join-Path $DataDir "ai-usage-$Device.json"
$MergedData = Join-Path $DataDir 'ai-usage.json'
$Svg = Join-Path $ProjectDir 'assets\ai-blue-wall.svg'
$ScannerScript = Join-Path $ScriptDir 'scan_all_tools.py'
$MergerScript = Join-Path $ScriptDir 'merge_devices.py'
$RendererScript = Join-Path $ScriptDir 'render_blue_wall.js'
$TransactionId = [Guid]::NewGuid().ToString('N')
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) "bluewall-update-$TransactionId"
$PublishRecords = @()
$IndexMayBeDirty = $false
$CommitCreated = $false

function Write-Step([string]$Message) {
    Write-Host "[bluewall] $Message" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

function Get-CheckedOutput {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
    )
    $output = & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
    return ($output | Out-String).Trim()
}

function Publish-GeneratedFile {
    param(
        [Parameter(Mandatory)] [string]$Source,
        [Parameter(Mandatory)] [string]$Destination,
        [Parameter(Mandatory)] [string]$Id
    )

    $staged = "$Destination.bluewall-$Id.tmp"
    $backup = "$Destination.bluewall-$Id.bak"
    $existed = Test-Path -LiteralPath $Destination

    try {
        Copy-Item -LiteralPath $Source -Destination $staged -Force
        if ($existed) {
            [IO.File]::Replace($staged, $Destination, $backup, $true)
        }
        else {
            [IO.File]::Move($staged, $Destination)
            $backup = $null
        }
    }
    finally {
        if (Test-Path -LiteralPath $staged) {
            Remove-Item -LiteralPath $staged -Force
        }
    }

    return [PSCustomObject]@{
        Destination = $Destination
        Backup = $backup
        Existed = $existed
    }
}

function Restore-PublishedFiles {
    param([object[]]$Records)

    for ($index = $Records.Count - 1; $index -ge 0; $index--) {
        $record = $Records[$index]
        if ($record.Existed -and (Test-Path -LiteralPath $record.Backup)) {
            Copy-Item -LiteralPath $record.Backup -Destination $record.Destination -Force
        }
        elseif (-not $record.Existed -and (Test-Path -LiteralPath $record.Destination)) {
            Remove-Item -LiteralPath $record.Destination -Force
        }
    }
}

function Remove-PublishArtifacts {
    param([object[]]$Records)

    foreach ($record in $Records) {
        if ($record.Backup -and (Test-Path -LiteralPath $record.Backup)) {
            Remove-Item -LiteralPath $record.Backup -Force
        }
    }
}

if ($Push) {
    $Commit = $true
}

$Python = (Get-Command python -ErrorAction Stop).Source
$Node = (Get-Command node -ErrorAction Stop).Source
$Git = (Get-Command git -ErrorAction Stop).Source
$OriginalGitEnvironment = @{
    GIT_TERMINAL_PROMPT = $env:GIT_TERMINAL_PROMPT
    GCM_INTERACTIVE = $env:GCM_INTERACTIVE
}
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'

Push-Location $ProjectDir
try {
    $currentBranch = Get-CheckedOutput $Git branch --show-current
    if ($currentBranch -ne 'main') {
        throw "Automated updates must run from branch 'main'; current branch is '$currentBranch'."
    }

    $dirty = Get-CheckedOutput $Git status --porcelain
    if ($dirty) {
        throw 'The worktree has uncommitted changes. Resolve them before running an automated update.'
    }

    if ($Push -and -not $SkipPull) {
        Write-Step 'Fast-forwarding from GitHub'
        Invoke-Checked $Git pull --ff-only origin main
    }

    New-Item -ItemType Directory -Path $TempRoot | Out-Null
    $TempSnapshot = Join-Path $TempRoot (Split-Path -Leaf $Snapshot)
    $TempMergedData = Join-Path $TempRoot 'ai-usage.json'
    $TempSvg = Join-Path $TempRoot 'ai-blue-wall.svg'

    Write-Step "Scanning $Device ($($Tools -join ', '))"
    $scanArguments = @(
        $ScannerScript
        '--days'
        [string]$Days
        '--device-name'
        $Device
        '--output'
        $TempSnapshot
        '--tools'
    ) + $Tools
    Invoke-Checked $Python @scanArguments

    $inputs = @(
        Get-ChildItem -Path $DataDir -Filter 'ai-usage-*.json' -File |
            Where-Object { $_.FullName -ne $Snapshot } |
            Sort-Object FullName |
            ForEach-Object { $_.FullName }
    ) + @($TempSnapshot)
    if ($inputs.Count -eq 0) {
        throw 'No device snapshots were found to merge.'
    }

    Write-Step "Merging $($inputs.Count) device snapshot(s)"
    $mergeArguments = @($MergerScript, '--inputs') +
        $inputs + @('--output', $TempMergedData)
    Invoke-Checked $Python @mergeArguments

    Write-Step 'Rendering the shared GitHub/self-hosted SVG'
    $renderArguments = @(
        $RendererScript
        '--data'
        $TempMergedData
        '--output'
        $TempSvg
        '--days'
        [string]$Days
        '--timezone'
        'Asia/Shanghai'
    )
    Invoke-Checked $Node @renderArguments
    $checkArguments = $renderArguments + @('--check')
    Invoke-Checked $Node @checkArguments

    if (-not $SkipTests) {
        Write-Step 'Running regression tests'
        Invoke-Checked $Node 'tests\test_api_svg.js'
        Invoke-Checked $Python '-m' 'unittest' 'discover' '-s' 'tests' '-v'
    }

    Write-Step 'Publishing validated generated files'
    $PublishRecords += Publish-GeneratedFile $TempSnapshot $Snapshot $TransactionId
    $PublishRecords += Publish-GeneratedFile $TempMergedData $MergedData $TransactionId
    $PublishRecords += Publish-GeneratedFile $TempSvg $Svg $TransactionId

    $relativeSnapshot = 'data/' + (Split-Path -Leaf $Snapshot)
    $trackedGenerated = @($relativeSnapshot, 'data/ai-usage.json', 'assets/ai-blue-wall.svg')

    if ($Commit) {
        $IndexMayBeDirty = $true
        Invoke-Checked $Git add -- @trackedGenerated
        & $Git diff --cached --quiet
        $diffExitCode = $LASTEXITCODE
        if ($diffExitCode -eq 0) {
            Write-Step 'No usage changes to commit'
            $IndexMayBeDirty = $false
        }
        elseif ($diffExitCode -eq 1) {
            $message = 'Update AI coding usage ' + (Get-Date -Format 'yyyy-MM-dd HH:mm zzz')
            Invoke-Checked $Git commit -m $message
            $CommitCreated = $true
            $IndexMayBeDirty = $false
        }
        else {
            throw "git diff failed with exit code $diffExitCode"
        }
    }

    if ($Push) {
        Write-Step 'Pushing the update to GitHub'
        Invoke-Checked $Git push origin HEAD:main
    }

    Write-Step 'Update complete'
}
catch {
    if (-not $CommitCreated -and $PublishRecords.Count -gt 0) {
        if ($IndexMayBeDirty) {
            & $Git restore --staged -- $relativeSnapshot 'data/ai-usage.json' 'assets/ai-blue-wall.svg' 2>$null
        }
        Restore-PublishedFiles $PublishRecords
    }
    throw
}
finally {
    Remove-PublishArtifacts $PublishRecords
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
    foreach ($name in $OriginalGitEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $OriginalGitEnvironment[$name], 'Process')
    }
    Pop-Location
}
