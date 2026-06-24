; NSIS post-install hook for MCPanel.
; Runs win-install-cli.ps1 after files are extracted to $INSTDIR.
; The PS1 script is bundled as a resource and lands in $INSTDIR before this hook runs.
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing mcpanel-cli (see %TEMP%\mcpanel-cli-install.log for details)..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\win-install-cli.ps1"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "mcpanel-cli install exited with code $0 — check %TEMP%\mcpanel-cli-install.log"
  ${EndIf}
!macroend
