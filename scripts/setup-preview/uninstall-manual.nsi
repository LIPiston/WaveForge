; Safe WaveForge uninstaller UI preview. It never removes application files.
Unicode true
!include "MUI2.nsh"

!ifndef SRC
  !error "SRC not defined - run via npm run preview:setup"
!endif

!define PRODUCT_NAME "WaveForge 澜音工坊"
!define PRODUCT_FILENAME "WaveForge"
!define APP_EXECUTABLE_FILENAME "WaveForge.exe"
!define VERSION "0.1.4"
; 手动测试卸载器：生产语义（用户手动确认）
!define BUILD_UNINSTALLER
!define BUILD_RESOURCES_DIR "${SRC}\build"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define INSTALL_REGISTRY_KEY "Software\WaveForgePreview"

Var UnReviewTarget

Name "${PRODUCT_NAME}"
Caption "${PRODUCT_NAME} 卸载向导预览"
OutFile "${SRC}/release/uninstall-e2e-builder.exe"
RequestExecutionLevel user
Icon "${SRC}/build/setup-icon.ico"
ShowInstDetails nevershow
AutoCloseWindow false
SilentInstall silent
SilentUnInstall normal

!addincludedir "${SRC}"
!addincludedir "${SRC}/node_modules/app-builder-lib/templates/nsis"
!addincludedir "${SRC}/node_modules/app-builder-lib/templates/nsis/include"
!include "FileFunc.nsh"
!include "StdUtils.nsh"
!include "UAC.nsh"
!include "build\installer.nsh"

Function un.onInit
  StrCpy $INSTDIR "D:\opencode\WaveForge\release\e2e-uninstall"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/review=" $UnReviewTarget
  ${If} ${Errors}
    StrCpy $UnReviewTarget "webui"
  ${EndIf}
  !insertmacro customUnInit
FunctionEnd

Function un.onGUIInit
  Call un.WaveUnGuiInit
  System::Call 'user32::SetWindowTextW(p $HWNDPARENT, w "WaveForge Uninstall Preview [$UnReviewTarget]")'
FunctionEnd

Function un.ReviewConfirmCreate
  ${If} $UnReviewTarget == "confirm"
    System::Call 'user32::SetWindowTextW(p $HWNDPARENT, w "WaveForge Uninstall Preview [$UnReviewTarget]")'
    Call un.WaveUnConfirmCreate
  ${Else}
    Abort
  ${EndIf}
FunctionEnd
Function un.ReviewProgressPre
  ${If} $UnReviewTarget != "progress"
    Abort
  ${EndIf}
  System::Call 'user32::SetWindowTextW(p $HWNDPARENT, w "WaveForge Uninstall Preview [$UnReviewTarget]")'
FunctionEnd
Function un.ReviewFinishCreate
  ${If} $UnReviewTarget == "finish"
    System::Call 'user32::SetWindowTextW(p $HWNDPARENT, w "WaveForge Uninstall Preview [$UnReviewTarget]")'
    Call un.WaveUnFinishCreate
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

UninstPage custom un.ReviewConfirmCreate un.WaveUnConfirmLeave
UninstPage custom un.WaveWebUiUninstallCreate
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.ReviewProgressPre
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.WaveUnInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.WaveUnInstFilesLeave
!insertmacro MUI_UNPAGE_INSTFILES
UninstPage custom un.ReviewFinishCreate un.WaveUnFinishLeave

Section "Builder"
  WriteUninstaller "$EXEDIR\uninstall-preview.exe"
SectionEnd

Section "un.Preview"
  DetailPrint "正在移除组件（安全预览，不删除文件）"
  Sleep 1800
SectionEnd
