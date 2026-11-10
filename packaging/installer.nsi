; OCS 网课助手 · Windows 安装包
; 用 makensis 编译（Linux 上也能出 exe，不需要 Windows）

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define APP_NAME "OCS 网课助手"
!define APP_VER "2.8.0"
!define APP_EXE "OCS网课助手.exe"
!define APP_PUBLISHER "OCS"
!define APP_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OCS-Server"

Name "${APP_NAME} ${APP_VER}"
BrandingText "${APP_NAME} ${APP_VER}"
OutFile "..\dist\OCS-Setup-${APP_VER}.exe"
InstallDir "$LOCALAPPDATA\Programs\OCS"
InstallDirRegKey HKCU "Software\OCS-Server" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "2.8.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion" "${APP_VER}"
VIAddVersionKey "ProductVersion" "${APP_VER}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "MIT"

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "ocs.ico"
!define MUI_UNICON "ocs.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"
!define MUI_FINISHPAGE_LINK "使用说明（README）"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR\app\README.md"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------------- 组件说明 ----------------
LangString DESC_SEC_MAIN ${LANG_SIMPCHINESE} "程序本体（自带 Node 运行时，无需另装）。"
LangString DESC_SEC_DESKTOP ${LANG_SIMPCHINESE} "在桌面放一个启动图标。"
LangString DESC_SEC_AUTOSTART ${LANG_SIMPCHINESE} "开机自动启动，适合长期挂课的机器。"

; ---------------- 安装 ----------------
Section "程序文件" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  File "staging\${APP_EXE}"
  File "staging\node.exe"
  File "staging\ocs.ico"

  SetOutPath "$INSTDIR\app"
  File /r "staging\app\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\OCS-Server" "InstallDir" "$INSTDIR"

  ; 开始菜单
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\ocs.ico" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0

  ; 卸载信息
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayVersion" "${APP_VER}"
  WriteRegStr HKCU "${APP_REGKEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayIcon" "$INSTDIR\ocs.ico"
  WriteRegStr HKCU "${APP_REGKEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${APP_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${APP_REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_REGKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${APP_REGKEY}" "EstimatedSize" "$0"
SectionEnd

Section "桌面快捷方式" SEC_DESKTOP
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\ocs.ico" 0
SectionEnd

Section /o "开机自动启动" SEC_AUTOSTART
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OCS-Server" "$\"$INSTDIR\${APP_EXE}$\""
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN} $(DESC_SEC_MAIN)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} $(DESC_SEC_DESKTOP)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_AUTOSTART} $(DESC_SEC_AUTOSTART)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function .onInstSuccess
  ; Edge 是默认浏览器内核。Win10/11 一般自带；没有就提示一句，别等启动时才报错
  IfFileExists "$PROGRAMFILES(x86)\Microsoft\Edge\Application\msedge.exe" edge_ok
  IfFileExists "$PROGRAMFILES\Microsoft\Edge\Application\msedge.exe" edge_ok
  IfFileExists "$LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe" edge_ok
  IfFileExists "$PROGRAMFILES\Google\Chrome\Application\chrome.exe" edge_ok
  IfFileExists "$PROGRAMFILES(x86)\Google\Chrome\Application\chrome.exe" edge_ok
    IfSilent edge_ok
    MessageBox MB_ICONINFORMATION|MB_OK "没有检测到 Microsoft Edge 或 Chrome。$\r$\n$\r$\n程序需要一个 Chromium 内核的浏览器来跑网课页面，请先安装 Edge（Windows 10/11 通常自带）再启动。"
  edge_ok:
FunctionEnd

; ---------------- 卸载 ----------------
Section "Uninstall"
  ; 先关掉正在跑的进程，否则文件删不掉。
  ; 用 nsExec 而不是 ExecWait：进程本来就没在跑时不会弹窗，也不会卡住。
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
  Pop $0
  nsExec::Exec 'taskkill /IM node.exe /F'
  Pop $0

  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\ocs.ico"
  Delete "$INSTDIR\Uninstall.exe"

  ; app\data 保留：里面是登录态和配置，重装后不用重新扫码
  RMDir /r "$INSTDIR\app\src"
  RMDir /r "$INSTDIR\app\userscript"
  RMDir /r "$INSTDIR\app\node_modules"
  Delete "$INSTDIR\app\launch.js"
  Delete "$INSTDIR\app\package.json"
  Delete "$INSTDIR\app\package-lock.json"
  Delete "$INSTDIR\app\README.md"
  Delete "$INSTDIR\app\AI答题说明.md"

  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OCS-Server"
  DeleteRegKey HKCU "${APP_REGKEY}"
  DeleteRegKey HKCU "Software\OCS-Server"

  RMDir "$INSTDIR\app"
  RMDir "$INSTDIR"

  IfSilent done
  MessageBox MB_ICONINFORMATION|MB_OK "已卸载。$\r$\n$\r$\n如果不再使用，可以手动删除这个目录（里面有登录态和配置）：$\r$\n$INSTDIR\app\data"
  done:
SectionEnd
