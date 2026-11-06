param([switch]$Pack)

$ErrorActionPreference = 'Stop'
$archives = Join-Path $env:RUNNER_TEMP 'windows-modules'
$names = @()
if ($Pack) {
    New-Item -Type Directory -Path $archives -Force | Out-Null
    $names = @(Get-ChildItem -LiteralPath node_modules -Name -Force | Sort-Object)
} else {
    New-Item -Type Directory -Path node_modules -Force | Out-Null
}

# Each top-level entry belongs to one tar, so extractors never write the same file.
$results = 0..3 | ForEach-Object -Parallel {
    $archive = Join-Path $using:archives "part-$_.tar"
    if ($using:Pack) {
        $entries = $using:names
        $members = for ($i = $_; $i -lt $entries.Count; $i += 4) { "./" + $entries[$i] }
        # Use the same GNU tar as actions/cache to record Bun's Windows hardlinks.
        & "$env:ProgramFiles\Git\usr\bin\tar.exe" --force-local -cf ($archive.Replace('\', '/')) -C node_modules -- @members
    } else {
        & "$env:SystemRoot\System32\tar.exe" -xf $archive -C node_modules
    }
    $LASTEXITCODE
} -ThrottleLimit 4
if (@($results).Count -ne 4 -or @($results -ne 0).Count) {
    throw "Windows dependency archive failed (tar exit codes: $results)"
}
