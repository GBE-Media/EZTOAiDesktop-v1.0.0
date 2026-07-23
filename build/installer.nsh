; Custom installer script for BidveraAi
; Adds a user-selectable desktop shortcut option.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var DesktopShortcutCheckbox
Var CreateDesktopShortcutSelection

!macro customHeader
  ; Custom header - no additional configuration needed
!macroend

!macro customInit
  ; Default to checked unless user opts out.
  StrCpy $CreateDesktopShortcutSelection "1"
!macroend

; Custom pages are only used by the installer. electron-builder compiles this
; include again for its temporary uninstaller, where page callbacks are unused.
!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave
!macroend

Function DesktopShortcutPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u "Additional shortcuts:"
  Pop $0

  ${NSD_CreateCheckbox} 0 20u 100% 12u "Create a desktop shortcut"
  Pop $DesktopShortcutCheckbox
  ${NSD_Check} $DesktopShortcutCheckbox

  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $CreateDesktopShortcutSelection "1"
  ${Else}
    StrCpy $CreateDesktopShortcutSelection "0"
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  ${ifNot} ${isUpdated}
    ${If} $CreateDesktopShortcutSelection == "1"
      CreateShortCut "$newDesktopLink" "$appExe"
    ${EndIf}
  ${endIf}
!macroend
