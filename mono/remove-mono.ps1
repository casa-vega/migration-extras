$content = Get-Content -Path "migrate.ps1"
$content | Where-Object { $_ -notmatch "m1-android|m1-ios" } | Set-Content -Path "migrate.ps1"
