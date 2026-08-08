# Programme le rafraîchissement nocturne de SVET dans le planificateur Windows.
#
# Sans lui, l'application se périme en silence : la course du soleil est
# recalculée à la minute affichée, mais la transmission — ce qui traverse
# réellement jusqu'au trottoir — est figée à la date du calcul. Deux mois plus
# tard, elle annonce des ombres qui n'existent plus.
#
#   .\schedule-refresh.ps1              installe la tâche pour 03h15
#   .\schedule-refresh.ps1 -At 04:30    à une autre heure
#   .\schedule-refresh.ps1 -Remove      la retire

[CmdletBinding()]
param(
    [string] $At = '03:15',
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'SVET — rafraîchissement des zones'
$Root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Tâche « $TaskName » retirée."
    } else {
        Write-Host "Aucune tâche « $TaskName » à retirer."
    }
    return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node est introuvable dans le PATH." }

$script = Join-Path $PSScriptRoot 'refresh.mjs'
if (-not (Test-Path $script)) { throw "refresh.mjs est introuvable dans $PSScriptRoot." }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Daily -At $At

# La machine peut être en veille à 3 h du matin : sans réveil ni rattrapage, la
# tâche saute la nuit entière et personne ne le remarque.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Recalcule la course du soleil de toutes les zones SVET pour la date du jour.' `
    -Force | Out-Null

Write-Host "Tâche « $TaskName » programmée chaque jour à $At."
Write-Host "  travail : $Root"
Write-Host "  commande : node `"$script`""
Write-Host ''
Write-Host 'Pour la lancer tout de suite et vérifier :'
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName'"
