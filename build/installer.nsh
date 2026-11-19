!include WinMessages.nsh

# Keep our controls separate from NSIS/Nsis7z's per-phase progress controls.
# The app-builder-lib patch supplies extraction callbacks and a copy-complete hook.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OhMyGameInstallProgressStart
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE OhMyGameInstallProgressFinish
!macroend

!macro customHeader
  Var omgInstallerLog
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

!macro OhMyGameLogDirectory
  # Use an administrator-owned directory when setup or the uninstaller is elevated.
  StrCpy $2 "$TEMP"
  System::Call 'shell32::IsUserAnAdmin() i.r1'
  ${If} $1 != 0
    StrCpy $2 "$WINDIR\Logs"
  ${EndIf}
!macroend

!macro OhMyGameUseParentLog
  ${If} $omgInstallerLog == ""
    System::Store S
    ReadEnvStr $3 "OHMYGAME_INSTALL_LOG_ID"
    StrLen $4 $3
    ${If} $4 > 0
    ${AndIf} $4 <= 4
      # Accept only a short hex ID, then reconstruct the path at this privilege level.
      System::Call 'msvcrt::wcsspn(w r3, w "0123456789ABCDEFabcdef") i.r5 ?c'
      ${If} $4 == $5
        !insertmacro OhMyGameLogDirectory
        System::Call 'kernel32::GetFileAttributesW(w "$2\OMG$3.tmp") i.r5'
        IntOp $4 $5 & 0x410
        ${If} $5 != -1
        ${AndIf} $4 == 0
          StrCpy $omgInstallerLog "$2\OMG$3.tmp"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    System::Store L
  ${EndIf}
!macroend

!macro OhMyGameLog MESSAGE
  DetailPrint "${MESSAGE}"
  System::Store S
  ${If} $omgInstallerLog == ""
    !insertmacro OhMyGameLogDirectory
    System::Call 'kernel32::GetTempFileNameW(w r2, w "OMG", i 0, w .r0) i.r1'
    ${If} $1 != 0
      StrCpy $omgInstallerLog $0
    ${EndIf}
  ${EndIf}
  ${If} $omgInstallerLog != ""
    ClearErrors
    FileOpen $0 "$omgInstallerLog" a
    ${IfNot} ${Errors}
      FileSeek $0 0 END
      FileWriteUTF16LE /BOM $0 "${MESSAGE}$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
  System::Store L
!macroend

!macro OhMyGameRunHelper COMMAND
  InitPluginsDir
  File /oname=$PLUGINSDIR\ohmygame-installer-process-helper.exe "${BUILD_RESOURCES_DIR}\..\.runtime\installer-process-helper.exe"
  nsExec::Exec /TIMEOUT=15000 `"$PLUGINSDIR\ohmygame-installer-process-helper.exe" --log "$omgInstallerLog" ${COMMAND}`
  Pop $R0
  !insertmacro OhMyGameLog "helper exit=$R0"
!macroend

!macro OhMyGamePrepareProcesses ROOT
  System::Store S
  !insertmacro OhMyGameLog "process-check directory=${ROOT}"
  ${Do}
    !insertmacro OhMyGameRunHelper 'probe "${ROOT}" "${APP_EXECUTABLE_FILENAME}"'
    ${If} $R0 == 10
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +3
        SetErrorLevel 2
        Quit
      ${EndIf}
      DetailPrint "$(appClosing)"
      !insertmacro OhMyGameRunHelper 'close "${ROOT}" "${APP_EXECUTABLE_FILENAME}"'
      ${If} $R0 == 0
        StrCpy $R1 0
        ${DoWhile} $R1 < 30
          Sleep 1000
          !insertmacro OhMyGameRunHelper 'probe "${ROOT}" "${APP_EXECUTABLE_FILENAME}"'
          IntOp $R1 $R1 + 1
          ${If} $R0 != 10
            ${ExitDo}
          ${EndIf}
        ${Loop}
      ${EndIf}
    ${EndIf}
    ${If} $R0 == 11
      !insertmacro OhMyGameRunHelper 'clean "${ROOT}" "${APP_EXECUTABLE_FILENAME}"'
    ${EndIf}
    ${If} $R0 == 10
      # A still-running main process may have unsaved work. Force requires consent.
      StrCpy $R1 0
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(omgForceClose)" /SD IDNO IDNO +2
      StrCpy $R1 1
      ${If} $R1 == 1
        !insertmacro OhMyGameRunHelper 'force "${ROOT}" "${APP_EXECUTABLE_FILENAME}"'
      ${EndIf}
    ${EndIf}
    ${If} $R0 == 0
      ${ExitDo}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appProcessCheckFailed)$\r$\n$omgInstallerLog" /SD IDCANCEL IDRETRY +3
    SetErrorLevel 2
    Quit
  ${Loop}
  System::Store L
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    !insertmacro OhMyGameUseParentLog
  !endif
  !insertmacro OhMyGamePrepareProcesses "$INSTDIR"
!macroend

!macro customOldUninstallPrepare
  !insertmacro OhMyGamePrepareProcesses "$installationDir"
  System::Store S
  System::Call 'shlwapi::PathFindFileNameW(w "$omgInstallerLog") w.r0'
  StrCpy $0 $0 -4 3
  System::Call 'kernel32::SetEnvironmentVariableW(w "OHMYGAME_INSTALL_LOG_ID", w r0)'
  System::Store L
!macroend

!macro customOldUninstallFinished
  System::Call 'kernel32::SetEnvironmentVariableW(w "OHMYGAME_INSTALL_LOG_ID", p 0)'
!macroend

!macro customOldUninstallerLaunchFailed
  !insertmacro customOldUninstallFinished
  !insertmacro OhMyGameLog "old-uninstaller-launch-failed path=$uninstallerFileName"
  # A missing legacy uninstaller can be repaired by installing again.
  ${If} ${FileExists} "$uninstallerFileName"
  ${OrIf} ${FileExists} "$uninstallerFileNameTemp"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(omgOldUninstallerLaunchFailed)$\r$\n$omgInstallerLog" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customOldUninstallRetryFailed
  !insertmacro OhMyGameLog "old-uninstaller-retries-exhausted exit=$R0 directory=$installationDir"
  System::Store S
  !insertmacro OhMyGameRunHelper 'legacy-owners "$installationDir" "${APP_EXECUTABLE_FILENAME}"'
  System::Store L
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(omgOldCleanupFailed)$\r$\n$omgInstallerLog" /SD IDCANCEL IDRETRY OneMoreAttempt
  SetErrorLevel 2
  Quit
!macroend

!macro customMoveOldFile SOURCE DESTINATION
  System::Store S
  # NSIS Rename does not expose the Win32 error. Retry only a failed move.
  System::Call 'kernel32::MoveFileW(w "${SOURCE}", w "${DESTINATION}") i.r0 ?e'
  Pop $1
  ${If} $0 == 0
    # The running uninstaller may be the only file that cannot move.
    ${If} "${SOURCE}" != "$INSTDIR\${UNINSTALL_FILENAME}"
      !insertmacro OhMyGameUseParentLog
      !insertmacro OhMyGameLog "old-file-move-failed path=${SOURCE} win32-error=$1"
      ${If} $1 == 32
      ${OrIf} $1 == 33
      ${OrIf} $1 == 5
        !insertmacro OhMyGameRunHelper 'owners "${SOURCE}"'
      ${EndIf}
    ${EndIf}
    System::Store L
    SetErrors
  ${Else}
    System::Store L
    ClearErrors
  ${EndIf}
!macroend
