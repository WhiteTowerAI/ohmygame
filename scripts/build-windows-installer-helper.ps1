$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $root
try {
    New-Item -ItemType Directory -Path '.runtime' -Force | Out-Null
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw 'Visual Studio Build Tools with the C++ workload are required to build the Windows installer.'
    }
    $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $visualStudio) {
        throw 'Visual Studio Build Tools with the C++ workload are required to build the Windows installer.'
    }
    $developerShell = Join-Path $visualStudio 'Common7\Tools\VsDevCmd.bat'
    & cmd.exe /d /c "call `"$developerShell`" -arch=x64 -host_arch=x64 >nul && cl.exe /nologo /std:c++17 /W4 /WX /EHsc /O2 /MT /utf-8 /Fo.runtime\installer-process-helper.obj /Fe.runtime\installer-process-helper.exe build\installer-process-helper.cpp /link Rstrtmgr.lib User32.lib"
    if ($LASTEXITCODE -ne 0) {
        throw "The Windows installer helper failed to build (exit $LASTEXITCODE)."
    }
} finally {
    Pop-Location
}
