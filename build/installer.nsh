!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\ohmygame-check-process.cmd "${BUILD_RESOURCES_DIR}\check-process.cmd"
  # NSIS is a 32-bit process even in an x64 installer. Sysnative bypasses WOW64
  # redirection so a missing 32-bit PowerShell does not break the native probe.
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $PowerShellPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $R1 0

  app_check:
    # 0 means running and 17 means not running. Any other result means the
    # PowerShell/CIM check itself failed and must not be treated as success.
    nsExec::ExecToStack /TIMEOUT=5000 `"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -Command "try { $$running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.Equals('$INSTDIR\${APP_EXECUTABLE_FILENAME}', 'OrdinalIgnoreCase') }); if ($$running.Count -gt 0) { exit 0 } else { exit 17 } } catch { Write-Output $$_.Exception.Message; exit 18 }"`
    Pop $R0
    Pop $R2
    ${If} $R0 == 17
      Goto app_closed
    ${EndIf}
    ${If} $R0 != 0
      # Group policy, a missing PowerShell binary, CIM failure, or a path that
      # PowerShell cannot parse falls back to a built-in name-only check.
      # A false positive is safer than overwriting files still in use.
      DetailPrint "PowerShell process check failed ($R0): $R2"
      # A separate script compares tasklist's CSV image-name field literally,
      # without findstr's quote-sensitive pattern or chained exit-code checks.
      nsExec::ExecToStack /TIMEOUT=5000 `"$CmdPath" /D /S /C ""$PLUGINSDIR\ohmygame-check-process.cmd" "${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\ohmygame-processes.txt""`
      Pop $R0
      Pop $R2
      ${If} $R0 == 17
        Goto app_closed
      ${EndIf}
      ${If} $R0 != 0
        # Unknown is not "running" or "safe to overwrite". Do not spend 30
        # retries waiting for an application that may not even be installed.
        DetailPrint "Fallback process check failed ($R0): $R2"
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appProcessCheckFailed)" /SD IDCANCEL IDRETRY retry_close
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}

    ${If} $R1 == 0
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK request_close
        Quit
      ${EndIf}

      request_close:
        DetailPrint "$(appClosing)"
        # Ask only the main window to close. This gives every supported old
        # version a chance to save before Electron tears down its child tree.
        nsExec::Exec /TIMEOUT=5000 `"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -Command "try { $$running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.Equals('$INSTDIR\${APP_EXECUTABLE_FILENAME}', 'OrdinalIgnoreCase') }); if ($$running.Count -eq 0) { exit 17 }; $$running | ForEach-Object { $$process = Get-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue; if ($$process -and $$process.MainWindowHandle -ne 0) { [void]$$process.CloseMainWindow() } }; exit 0 } catch { exit 18 }"`
        Pop $R0
        ${If} $R0 != 0
          DetailPrint "Could not request a normal close automatically; waiting for the application to exit."
        ${EndIf}
    ${EndIf}

    IntOp $R1 $R1 + 1
    ${If} $R1 < 30
      DetailPrint `Waiting for "${PRODUCT_NAME}" to close safely.`
      Sleep 1000
      Goto app_check
    ${EndIf}

    # Do not force-kill a process that may still be saving user work.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY retry_close
    Quit

  retry_close:
    StrCpy $R1 0
    Goto app_check

  app_closed:
!macroend
