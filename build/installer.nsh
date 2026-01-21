!define MUI_ABORTWARNING

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var PrivacyPolicyCheckbox
Var PrivacyPolicyText

!macro addLicenseFiles
  File /oname=$PLUGINSDIR\privacy-policy.txt "${BUILD_RESOURCES_DIR}\privacy-policy.txt"
!macroend

!macro customPageAfterChangeDir
  Page custom PrivacyPolicyPage PrivacyPolicyPageLeave
!macroend

Function PrivacyPolicyPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "Privacy Policy"
  Pop $1
  ${NSD_CreateText} 0 16u 100% 140u ""
  Pop $PrivacyPolicyText
  ${NSD_SetReadOnly} $PrivacyPolicyText 1

  ${NSD_CreateCheckbox} 0 162u 100% 12u "I accept the Privacy Policy"
  Pop $PrivacyPolicyCheckbox

  IfFileExists "$PLUGINSDIR\privacy-policy.txt" 0 +8
  FileOpen $2 "$PLUGINSDIR\privacy-policy.txt" r
  StrCpy $3 ""
  loop:
    FileRead $2 $4
    IfErrors done
    StrCpy $3 "$3$4"
    Goto loop
  done:
    FileClose $2
    ${NSD_SetText} $PrivacyPolicyText $3

  nsDialogs::Show
FunctionEnd

Function PrivacyPolicyPageLeave
  ${NSD_GetState} $PrivacyPolicyCheckbox $0
  ${If} $0 != 1
    MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "You must accept the Privacy Policy to continue."
    Abort
  ${EndIf}
FunctionEnd
