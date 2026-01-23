!define MUI_ABORTWARNING

; Privacy policy page after installation directory selection
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\privacy-policy.txt"
!macroend
