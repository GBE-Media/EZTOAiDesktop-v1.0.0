!define MUI_ABORTWARNING

!include "nsDialogs.nsh"

; Variables for desktop shortcut checkbox
Var DesktopShortcutCheckbox
Var DesktopShortcutState

!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\privacy-policy.txt"
  Page custom DesktopShortcutPage DesktopShortcutPageLeave
!macroend

; Custom page for desktop shortcut option
Function DesktopShortcutPage
  ; Create the dialog
  nsDialogs::Create 1018
  Pop $0
  
  ${If} $0 == error
    Abort
  ${EndIf}
  
  ; Add a label for context
  ${NSD_CreateLabel} 0 0 100% 24u "Choose additional installation options:"
  Pop $0
  
  ; Create checkbox for desktop shortcut (checked by default)
  ${NSD_CreateCheckbox} 0 30u 100% 12u "Create a desktop shortcut"
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
