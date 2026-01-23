!define MUI_ABORTWARNING

; Variables for desktop shortcut checkbox
Var DesktopShortcutCheckbox
Var DesktopShortcutState

!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\privacy-policy.txt"
  Page custom DesktopShortcutPage DesktopShortcutPageLeave
!macroend

; Custom page for desktop shortcut option
Function DesktopShortcutPage
  !insertmacro MUI_HEADER_TEXT "Installation Options" "Choose additional options for the installation."
  
  nsDialogs::Create 1018
  Pop $0
  
  ${If} $0 == error
    Abort
  ${EndIf}
  
  ${NSD_CreateCheckbox} 0 0 100% 12u "Create a desktop shortcut"
  Pop $DesktopShortcutCheckbox
  ${NSD_SetState} $DesktopShortcutCheckbox ${BST_CHECKED}
  
  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutState
  ${If} $DesktopShortcutState == ${BST_UNCHECKED}
    StrCpy $isNoDesktopShortcut "1"
  ${Else}
    StrCpy $isNoDesktopShortcut "0"
  ${EndIf}
FunctionEnd
