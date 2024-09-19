#!/usr/bin/env pwsh

# =========== Created with CLI version 1.8.0 ===========

function ExecAndGetMigrationID {
    param (
        [scriptblock]$ScriptBlock
    )
    $MigrationID = & @ScriptBlock | ForEach-Object {
        Write-Host $_
        $_
    } | Select-String -Pattern "\(ID: (.+)\)" | ForEach-Object { $_.matches.groups[1] }
    return $MigrationID
}

if (-not $env:GH_PAT) {
    Write-Error "GH_PAT environment variable must be set to a valid GitHub Personal Access Token with the appropriate scopes. For more information see https://docs.github.com/en/migrations/using-github-enterprise-importer/preparing-to-migrate-with-github-enterprise-importer/managing-access-for-github-enterprise-importer#creating-a-personal-access-token-for-github-enterprise-importer"
    exit 1
} else {
    Write-Host "GH_PAT environment variable is set and will be used to authenticate to GitHub."
}

$Succeeded = 0
$Failed = 0
$RepoMigrations = [ordered]@{}

# =========== Organization: amex-dryrun-org ===========

# === Queuing repo migrations ===
$MigrationID = ExecAndGetMigrationID { gh gei migrate-repo --skip-releases --github-source-org "amex-eng" --source-repo "m1-ios" --github-target-org "amex-dryrun-mobile" --target-repo "m1-ios" --queue-only --target-repo-visibility internal }
$RepoMigrations["m1-ios"] = $MigrationID


# =========== Waiting for all migrations to finish for Organization: the-source-org ===========

if ($RepoMigrations["m1-ios"]) { gh gei wait-for-migration --migration-id $RepoMigrations["m1-ios"] }
if ($RepoMigrations["m1-ios"] -and $lastexitcode -eq 0) { $Succeeded++ } else { $Failed++ }


Write-Host =============== Summary ===============
Write-Host Total number of successful migrations: $Succeeded
Write-Host Total number of failed migrations: $Failed

if ($Failed -ne 0) {
    exit 1
}