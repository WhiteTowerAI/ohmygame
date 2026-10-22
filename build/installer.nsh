!include WinMessages.nsh

# Keep our controls separate from NSIS/Nsis7z's per-phase progress controls.
# The app-builder-lib patch supplies extraction callbacks and a copy-complete hook.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OhMyGameInstallProgressStart
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE OhMyGameInstallProgressFinish
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var omgProgressBar
    Var omgProgressText
    Var omgProgress
    Var omgProgressNext
    Var omgProgressPhase
    Var omgExtractCompleted
    Var omgExtractTotal

    Function OhMyGameInstallProgressStart
      System::Store S
      # Use the existing page geometry/font so Windows scaling is respected.
      System::Call '*(i, i, i, i) p .r0'
      System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.ProgressBar, p r0)'
      System::Call 'user32::MapWindowPoints(p 0, p $mui.InstFilesPage, p r0, i 2)'
      System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
      IntOp $3 $3 - $1
      IntOp $4 $4 - $2
      ShowWindow $mui.InstFilesPage.ProgressBar ${SW_HIDE}
      System::Call 'user32::CreateWindowExW(i 0, w "msctls_progress32", w "", i 0x50000000, i r1, i r2, i r3, i r4, p $mui.InstFilesPage, p 0, p 0, p 0) p .s'
      Pop $omgProgressBar
      SendMessage $omgProgressBar ${PBM_SETRANGE32} 0 100
      System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.Text, p r0)'
      System::Call 'user32::MapWindowPoints(p 0, p $mui.InstFilesPage, p r0, i 2)'
      System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
      IntOp $3 $3 - $1
      IntOp $4 $4 - $2
      ShowWindow $mui.InstFilesPage.Text ${SW_HIDE}
      System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r1, i r2, i r3, i r4, p $mui.InstFilesPage, p 0, p 0, p 0) p .s'
      Pop $omgProgressText
      SendMessage $mui.InstFilesPage.Text ${WM_GETFONT} 0 0 $1
      SendMessage $omgProgressText ${WM_SETFONT} $1 1
      System::Free $0
      StrCpy $omgProgress 0
      StrCpy $omgProgressNext 0
      StrCpy $omgProgressPhase "$(omgPreparing)"
      Call OhMyGameInstallProgressUpdate
      System::Store L
    FunctionEnd

    Function OhMyGameInstallProgressUpdate
      IfSilent progress_update_done
      # Retry callbacks and native progress resets must never move us backwards.
      ${If} $omgProgressNext > $omgProgress
        StrCpy $omgProgress $omgProgressNext
      ${EndIf}
      SendMessage $omgProgressBar ${PBM_SETPOS} $omgProgress 0
      ${If} $omgProgress == 100
        SendMessage $omgProgressText ${WM_SETTEXT} 0 "STR:$(omgComplete) 100%"
      ${Else}
        SendMessage $omgProgressText ${WM_SETTEXT} 0 "STR:$(omgInstalling) $omgProgress% ($omgProgressPhase)"
      ${EndIf}
      progress_update_done:
    FunctionEnd

    Function OhMyGameExtractProgress
      # Nsis7z pushes completed bytes followed by total bytes. Always consume
      # both, including silent installations. Use 64-bit math for large payloads.
      Pop $omgExtractCompleted
      Pop $omgExtractTotal
      System::Store S
      ${If} $omgExtractTotal != 0
        System::Int64Op $omgExtractCompleted * 75
        Pop $1
        System::Int64Op $1 / $omgExtractTotal
        Pop $omgProgressNext
        IntOp $omgProgressNext $omgProgressNext + 10
        ${If} $omgProgressNext > 85
          StrCpy $omgProgressNext 85
        ${EndIf}
        Call OhMyGameInstallProgressUpdate
      ${EndIf}
      System::Store L
    FunctionEnd

    Function OhMyGameInstallProgressFinish
      # The leave callback also runs on failure. Only success may show 100%.
      IfAbort progress_done
      StrCpy $omgProgressNext 100
      StrCpy $omgProgressPhase "$(omgComplete)"
      Call OhMyGameInstallProgressUpdate
      progress_done:
    FunctionEnd
  !endif
!macroend

!macro customExtractUsing7za FILE
  StrCpy $omgProgressNext 10
  StrCpy $omgProgressPhase "$(omgExtracting)"
  Call OhMyGameInstallProgressUpdate
  Push $R9
  GetFunctionAddress $R9 OhMyGameExtractProgress
  Nsis7z::ExtractWithCallback "${FILE}" $R9
  Pop $R9
  StrCpy $omgProgressNext 85
  StrCpy $omgProgressPhase "$(omgCopying)"
  Call OhMyGameInstallProgressUpdate
!macroend

!macro customAppFilesCopied
  StrCpy $omgProgressNext 95
  StrCpy $omgProgressPhase "$(omgFinalizing)"
  Call OhMyGameInstallProgressUpdate
!macroend

!macro customInstall
  StrCpy $omgProgressNext 99
  Call OhMyGameInstallProgressUpdate
!macroend

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
