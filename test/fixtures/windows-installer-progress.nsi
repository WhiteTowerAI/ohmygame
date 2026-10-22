Unicode true
RequestExecutionLevel user
Name "OhMyGame installation progress test"
OutFile "${OUTPUT_DIR}\progress-${SMOKE_KIND}.exe"
ShowInstDetails nevershow
!addplugindir /x86-unicode "${NSIS_PLUGIN_DIR}"
!include MUI2.nsh
!include LogicLib.nsh
!include "${PROJECT_DIR}\build\installer.nsh"
!include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\extractAppPackage.nsh"
!insertmacro customPageAfterChangeDir
!undef MUI_PAGE_CUSTOMFUNCTION_LEAVE
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE SmokeFinish
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro customHeader
LangString omgInstalling 1033 "Installing..."
LangString omgInstalling 2052 "正在安装..."
LangString omgPreparing 1033 "Preparing installation..."
LangString omgExtracting 1033 "Extracting application files..."
LangString omgCopying 1033 "Copying application files..."
LangString omgFinalizing 1033 "Finishing installation..."
LangString omgComplete 1033 "Installation complete."
LangString omgPreparing 2052 "正在准备安装..."
LangString omgExtracting 2052 "正在解压程序文件..."
LangString omgCopying 2052 "正在复制程序文件..."
LangString omgFinalizing 2052 "正在完成安装..."
LangString omgComplete 2052 "安装完成。"
LangString appCannotBeClosed 1033 "Files could not be copied."
LangString appCannotBeClosed 2052 "无法复制文件。"
Var smokeLog

Function .onInit
  StrCpy $LANGUAGE ${SMOKE_LANGUAGE}
  ${If} ${Silent}
    StrCpy $smokeLog "${OUTPUT_DIR}\${SMOKE_KIND}-silent.log"
  ${Else}
    StrCpy $smokeLog "${OUTPUT_DIR}\${SMOKE_KIND}.log"
  ${EndIf}
  FileOpen $0 $smokeLog w
  FileClose $0
FunctionEnd

Function Snapshot
  Pop $R6
  SendMessage $omgProgressBar ${PBM_GETPOS} 0 0 $R7
  System::Call 'user32::GetWindowTextW(p $omgProgressText, w .r4, i ${NSIS_MAX_STRLEN})'
  FileOpen $R8 $smokeLog a
  FileSeek $R8 0 END
  FileWriteUTF16LE $R8 "$R6|$omgProgress|$R7|$4$\r$\n"
  FileClose $R8
FunctionEnd

Function SmokeFinish
  Call OhMyGameInstallProgressFinish
  Push "finish"
  Call Snapshot
  !ifdef PREVIEW
    Sleep 4000
  !endif
  SetErrorLevel 0
  Quit
FunctionEnd

Section
  InitPluginsDir
  # Replacement controls must occupy exactly the original DPI-scaled geometry.
  IfSilent geometry_done
  System::Call '*(i, i, i, i) p .r0'
  System::Call '*(i, i, i, i) p .r1'
  System::Call 'user32::GetWindowRect(p $omgProgressBar, p r0)'
  System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.ProgressBar, p r1)'
  System::Call 'user32::EqualRect(p r0, p r1) i .r2'
  ${If} $2 != 1
    SetErrorLevel 6
    Quit
  ${EndIf}
  System::Call 'user32::GetWindowRect(p $omgProgressText, p r0)'
  System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.Text, p r1)'
  System::Call 'user32::EqualRect(p r0, p r1) i .r2'
  ${If} $2 != 1
    SetErrorLevel 7
    Quit
  ${EndIf}
  System::Free $0
  System::Free $1
  geometry_done:
  Push "start"
  Call Snapshot
  StrCpy $R9 "register-preserved"
  Push "stack-preserved"
  # Exercise 64-bit arithmetic, even when the actual fixture archive is small.
  Push 5000000000
  Push 2500000000
  Call OhMyGameExtractProgress
  Push "large-payload"
  Call Snapshot
  # Retry from an earlier extraction point must hold the visible percentage.
  Push 100
  Push 10
  Call OhMyGameExtractProgress
  Push "retry"
  Call Snapshot
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETPOS} 24000 0
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETPOS} 5000 0
  Push "native-reset"
  Call Snapshot
  !ifdef PREVIEW
    StrCpy $omgProgressPhase "$(omgExtracting)"
    Call OhMyGameInstallProgressUpdate
    IfSilent preview_done
    Sleep 45000
    preview_done:
  !endif
  # Use the actual patched electron-builder extraction/copy/retry macro.
  File /oname=$PLUGINSDIR\payload.7z "${OUTPUT_DIR}\payload.7z"
  SetOutPath "$PLUGINSDIR\installed"
  !insertmacro extractUsing7za "$PLUGINSDIR\payload.7z"
  IfFileExists "$OUTDIR\payload.bin" +3
    SetErrorLevel 2
    Quit
  ${If} $omgExtractCompleted == 0
  ${OrIf} $omgExtractTotal == 0
    SetErrorLevel 3
    Quit
  ${EndIf}
  ${If} $R9 != "register-preserved"
    SetErrorLevel 4
    Quit
  ${EndIf}
  Pop $R9
  ${If} $R9 != "stack-preserved"
    SetErrorLevel 5
    Quit
  ${EndIf}
  Push "copied"
  Call Snapshot
  !insertmacro customInstall
  Push "finalizing"
  Call Snapshot
  IfSilent 0 +3
    SetErrorLevel 0
    Quit
  !if "${SMOKE_KIND}" == "failure"
    Abort
  !endif
SectionEnd
