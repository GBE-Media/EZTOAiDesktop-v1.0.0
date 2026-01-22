!define MUI_ABORTWARNING

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var PrivacyPolicyCheckbox

!macro customPageAfterChangeDir
  Page custom PrivacyPolicyPage PrivacyPolicyPageLeave
!macroend

Function PrivacyPolicyPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Privacy Policy Agreement"
  Pop $1

  ${NSD_CreateLabel} 0 30u 100% 80u "By installing EZTO Ai, you agree to our Privacy Policy. Your data will be handled securely and in accordance with applicable privacy laws. You can view the full Privacy Policy at eztoai.thebemedia.com/privacy"
  Pop $2

  ${NSD_CreateCheckbox} 0 120u 100% 12u "I have read and accept the Privacy Policy"
  Pop $PrivacyPolicyCheckbox

  nsDialogs::Show
FunctionEnd

Function PrivacyPolicyPageLeave
  ${NSD_GetState} $PrivacyPolicyCheckbox $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "You must accept the Privacy Policy to continue."
    Abort
  ${EndIf}
FunctionEnd
