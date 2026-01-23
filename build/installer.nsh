!define MUI_ABORTWARNING

; Privacy policy page after installation directory selection
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\privacy-policy.txt"
!macroend

; Use finish page checkbox for desktop shortcut option
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create Desktop Shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut

Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}"
FunctionEnd

; Disable automatic desktop shortcut since we handle it manually
!macro customInstall
  ; Desktop shortcut is handled by the finish page checkbox
!macroend
