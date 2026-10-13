!macro customCheckAppRunning
  StrCpy $R1 0

  app_check:
    # 0 means running and 17 means not running. Any other result means the
    # PowerShell/CIM check itself failed and must not be treated as success.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.Equals('$INSTDIR\${APP_EXECUTABLE_FILENAME}', 'OrdinalIgnoreCase') }); if ($$running.Count -gt 0) { exit 0 } else { exit 17 } } catch { exit 18 }"`
    Pop $R0
    ${If} $R0 == 17
      Goto app_closed
    ${EndIf}
    ${If} $R0 != 0
      # Group policy, a missing PowerShell binary, CIM failure, or a path that
      # PowerShell cannot parse falls back to a built-in name-only check.
      # A false positive is safer than overwriting files still in use.
      # The fallback also uses 17 exclusively for "not found"; tasklist or
      # findstr failures remain conservative and keep the installer stopped.
      nsExec::Exec `"$CmdPath" /D /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH > "$PLUGINSDIR\ohmygame-processes.txt" & if errorlevel 1 exit /b 18 & "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\"" < "$PLUGINSDIR\ohmygame-processes.txt" >NUL & if errorlevel 1 exit /b 17 & exit /b 0`
      Pop $R0
      ${If} $R0 == 17
        Goto app_closed
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
        nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.Equals('$INSTDIR\${APP_EXECUTABLE_FILENAME}', 'OrdinalIgnoreCase') }); if ($$running.Count -eq 0) { exit 17 }; $$running | ForEach-Object { $$process = Get-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue; if ($$process -and $$process.MainWindowHandle -ne 0) { [void]$$process.CloseMainWindow() } }; exit 0 } catch { exit 18 }"`
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
