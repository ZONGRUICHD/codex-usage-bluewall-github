# Install the local collector that GitHub-hosted runners and Vercel cannot run.

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'AI Coding Blue Wall Update',

    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
    [string]$At = '00:15',

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Device = 'windows-main',

    [string]$ProjectDir,
    [switch]$RunNow,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectDir) {
    $ProjectDir = Split-Path -Parent $ScriptDir
}
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$Updater = Join-Path $ProjectDir 'scripts\update.ps1'

if ($Remove) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Removed scheduled task: $TaskName"
    }
    return
}

if (-not (Test-Path -LiteralPath $Updater)) {
    throw "Updater not found: $Updater"
}

$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$clock = [DateTime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$runAt = (Get-Date).Date.Add($clock.TimeOfDay)
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
    '-File "' + $Updater + '" -Device "' + $Device + '" -Commit -Push'

$action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument $arguments `
    -WorkingDirectory $ProjectDir
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At $runAt),
    (New-ScheduledTaskTrigger -AtLogOn -User $Identity)
)
$principal = New-ScheduledTaskPrincipal `
    -UserId $Identity `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

if ($PSCmdlet.ShouldProcess($TaskName, "Install daily collector at $At")) {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $triggers `
        -Principal $principal `
        -Settings $settings `
        -Description 'Scan local AI coding usage and publish aggregate data to GitHub/Vercel.' `
        -Force | Out-Null

    if ($RunNow) {
        Start-ScheduledTask -TaskName $TaskName
    }
    Write-Host "Installed scheduled task: $TaskName"
    Write-Host "Repository: $ProjectDir"
    Write-Host "Daily run: $At (plus logon)"
}
