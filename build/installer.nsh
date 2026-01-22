!define MUI_ABORTWARNING

!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\privacy-policy.txt"
!macroend
