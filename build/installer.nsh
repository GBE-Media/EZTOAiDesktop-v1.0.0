; Custom installer script for BidveraAi
; Adds a user-selectable desktop shortcut option.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!macro customHeader
  ; Custom header - no additional configuration needed
!macroend

; electron-builder reuses this same include file to compile a temporary,
; standalone uninstaller (with BUILD_UNINSTALLER defined) before embedding it
; into the real installer. In that pass, none of the macros below are ever
; inserted by electron-builder's own templates (customInit/customInstall are
; only invoked outside BUILD_UNINSTALLER, and customPageAfterChangeDir is only
; used by the installer UI). Any Var declared for their exclusive use is
; therefore left unreferenced during that pass, which NSIS reports as
; "warning 6001" - and this project's build config treats warnings as fatal
; errors. Guard everything installer-only behind !ifndef BUILD_UNINSTALLER so
; the uninstaller-only compile never sees these unused variables.
!ifndef BUILD_UNINSTALLER
Var DesktopShortcutCheckbox
Var CreateDesktopShortcutSelection

!macro customInit
  ; Default to checked unless user opts out.
  StrCpy $CreateDesktopShortcutSelection "1"
!macroend

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

!macro customInstall
  ${ifNot} ${isUpdated}
    ${If} $CreateDesktopShortcutSelection == "1"
      CreateShortCut "$newDesktopLink" "$appExe"
    ${EndIf}
  ${endIf}
!macroend
!endif
