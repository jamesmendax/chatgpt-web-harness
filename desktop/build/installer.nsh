; Custom NSIS cleanup for the installed launcher.  The prompt is deliberate:
; users may keep their encrypted configuration and installed Skills when
; removing only the program files.  Silent uninstall is the KEEP-DATA path so
; automated lifecycle checks never make an irreversible data choice.
!macro harnessRemoveLongPathPayload
  ; The archive extractor supports long dependency paths, but NSIS 3.04's
  ; plain RMDir does not. Use the native extended path form only for the
  ; bundled runtime tree; the builder retains ownership of the install root.
  Push $R0
  Push $R1
  StrCpy $R0 "$INSTDIR\resources\harness"
  ; Add the prefix to drive-letter paths. Preserve UNC and already-prefixed
  ; paths so this does not change their existing NSIS interpretation.
  StrCpy $R1 $INSTDIR 1 1
  ${If} $R1 == ":"
    StrCpy $R0 "\\?\$R0"
  ${EndIf}
  RMDir /r "$R0"
  Pop $R1
  Pop $R0
!macroend

; The default builder check can fall back to a global image-name termination.
; Override only the uninstaller: a matching process (even another isolated
; installation) or a lookup error blocks removal, never authorizes a kill.
!ifdef BUILD_UNINSTALLER
!macro customCheckAppRunning
  !if "${APP_EXECUTABLE_FILENAME}" != "ChatGPT Web Harness Isolated.exe"
    !error "Isolated uninstaller requires the isolated executable name"
  !endif
  Push $R0
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ; nsProcess: 603 = process not running. All other results fail closed.
  ${If} $R0 != 603
    Pop $R0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "隔离版仍在运行或无法确认其状态。请先退出 ChatGPT Web Harness Isolated（隔离版）及由它启动的服务，再重试卸载。$\r$\n本卸载程序不会终止任何进程。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $R0
!macroend
!endif

!macro customDeleteAppData
  ; These compile-time allowlists also protect the builder template's own
  ; --delete-app-data path. A metadata regression must fail the build, not
  ; turn an isolated uninstaller into a remover for the original product.
  !if "${APP_ID}" != "com.chatgpt-web-harness.isolated"
    !error "Isolated uninstaller requires the isolated app ID"
  !endif
  !if "${APP_FILENAME}" != "ChatGPT Web Harness Isolated"
    !if "${APP_FILENAME}" != "chatgpt-web-harness-isolated"
      !error "Refusing non-isolated APP_FILENAME data deletion"
    !endif
  !endif
  !ifdef APP_PRODUCT_FILENAME
    !if "${APP_PRODUCT_FILENAME}" != "ChatGPT Web Harness Isolated"
      !error "Refusing non-isolated APP_PRODUCT_FILENAME data deletion"
    !endif
  !endif
  !ifdef APP_PACKAGE_NAME
    !if "${APP_PACKAGE_NAME}" != "chatgpt-web-harness-isolated"
      !error "Refusing non-isolated APP_PACKAGE_NAME data deletion"
    !endif
  !endif
  RMDir /r "$APPDATA\${APP_FILENAME}"
  !ifdef APP_PRODUCT_FILENAME
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
  !endif
  !ifdef APP_PACKAGE_NAME
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
  !endif
!macroend

!macro customUnInstall
  IfSilent keep_data
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "同时删除隔离版的配置、日志和已安装 Skill？$\r$\n$\r$\n只会删除当前用户的 ChatGPT Web Harness Isolated（隔离版）数据；原版数据不会删除。" IDYES delete_data
  Goto keep_data
delete_data:
  !insertmacro customDeleteAppData
keep_data:
  ; Upgrade removal must retain electron-builder's atomic move/restore path.
  ${IfNot} ${isUpdated}
    !insertmacro harnessRemoveLongPathPayload
  ${EndIf}
!macroend
