; WaveForge WebView2 壳端到端探针：真实 stub 流程 + 假安装段（慢速写文件 + 可启动的 app）。
; 编译：MAKENSIS=... node scripts/setup-preview/build-webui-probe.mjs
; 用法：直接运行 release/setup-webui-probe.exe —— 走壳 UI，点“安装”后观察进度/完成页。
Unicode true
!include "MUI2.nsh"

!ifndef SRC
  !error "SRC not defined - run via scripts/setup-preview/build-webui-probe.mjs"
!endif

!define PRODUCT_NAME "WaveForge 澜音工坊"
!define PRODUCT_FILENAME "WaveForge"
!define APP_EXECUTABLE_FILENAME "WaveForge.exe"
!define VERSION "9.9.9-probe"
!define APP_FILENAME "WaveForge 澜音工坊"
!define APP_GUID "{A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D}"
!define ESTIMATED_SIZE 71680
!define isUpdated `0 == 1`
!define WF_PROBE
; 与真实 assisted 构建一致（!oneClick=false ⇒ REQUIRED），silent 范围补齐才可用
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define BUILD_RESOURCES_DIR "${SRC}\build"

Name "${PRODUCT_NAME} UI 探针"
Caption "${PRODUCT_NAME} 安装探针"
OutFile "${SRC}\release\setup-webui-probe.exe"
RequestExecutionLevel user
Icon "${SRC}\build\setup-icon.ico"
ShowInstDetails nevershow
AutoCloseWindow true

Var newDesktopLink
Var oldStartMenuLink
Var oldDesktopLink
Var oldShortcutName
Var oldMenuDirectory
Var launchLink

!addincludedir "${SRC}"
!addincludedir "${SRC}/node_modules/app-builder-lib/templates/nsis"
!addincludedir "${SRC}/node_modules/app-builder-lib/templates/nsis/include"
!addplugindir "${SRC}\scripts\setup-preview\plugins"
!include "FileFunc.nsh"
!include "StdUtils.nsh"
!include "${SRC}\node_modules\app-builder-lib\templates\nsis\multiUser.nsh"
!include "build\installer.nsh"

Function .onInit
  StrCpy $installMode "current"
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\WaveForge"
  !insertmacro customInit
FunctionEnd

; 假安装段：慢速写 ~70MB 假文件（供壳的目录轮询画出真实进度），最后放一个能启动的 WaveForge.exe
Section "install" SEC01
  SetOutPath "$INSTDIR"
  StrCpy $0 0
  ${While} $0 < 140
    FileOpen $1 "$INSTDIR\payload-$0.dat" w
    StrCpy $2 0
    ${While} $2 < 2600
      FileWrite $1 "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF$\r$\n"
      IntOp $2 $2 + 1
    ${EndWhile}
    FileClose $1
    IntOp $0 $0 + 1
    Sleep 60
  ${EndWhile}
  CopyFiles /SILENT "$WINDIR\notepad.exe" "$INSTDIR\WaveForge.exe"
SectionEnd

; 完成页“立即打开”在探针里直接退出（真实构建由 eb 的 customFinishPage 提供）
Function WaveFinishRun
  Quit
FunctionEnd
