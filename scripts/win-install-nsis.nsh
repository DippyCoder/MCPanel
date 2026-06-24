; NSIS post-install hook for MCPanel.
; Writes an initial log entry directly from NSIS so the log always exists
; if this hook runs, even if PowerShell fails before it can write anything.

!macro NSIS_HOOK_POSTINSTALL
  ; --- write initial entry via NSIS (not PowerShell) ---
  FileOpen $R0 "$TEMP\mcpanel-cli-install.log" w
  FileWrite $R0 "=== MCPanel NSIS hook started ===$\r$\n"
  FileWrite $R0 "INSTDIR: $INSTDIR$\r$\n"
  FileClose $R0

  ; --- locate the bundled PS1 (Tauri places resources directly in $INSTDIR) ---
  ${If} ${FileExists} "$INSTDIR\win-install-cli.ps1"
    FileOpen $R0 "$TEMP\mcpanel-cli-install.log" a
    FileWrite $R0 "PS1 found at: $INSTDIR\win-install-cli.ps1$\r$\n"
    FileClose $R0

    DetailPrint "Installing mcpanel-cli..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\win-install-cli.ps1"'
    Pop $R1
    ${If} $R1 != 0
      DetailPrint "mcpanel-cli install exited $R1 - see %TEMP%\mcpanel-cli-install.log"
      FileOpen $R0 "$TEMP\mcpanel-cli-install.log" a
      FileWrite $R0 "PowerShell exited with code: $R1$\r$\n"
      FileClose $R0
    ${EndIf}
  ${Else}
    ; PS1 not in $INSTDIR - log the miss and run pip inline so install still works
    FileOpen $R0 "$TEMP\mcpanel-cli-install.log" a
    FileWrite $R0 "WARNING: win-install-cli.ps1 not found at $INSTDIR$\r$\n"
    FileWrite $R0 "Falling back to inline pip install$\r$\n"
    FileClose $R0

    DetailPrint "mcpanel-cli: bundled script not found, running inline pip install..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { Add-Content -Path ([IO.Path]::Combine($env:TEMP,''mcpanel-cli-install.log'')) -Value ''[inline] attempting pip install...''; foreach ($py in @(''py'',''python'',''python3'')) { $o = & $py -m pip install https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip 2>&1; Add-Content -Path ([IO.Path]::Combine($env:TEMP,''mcpanel-cli-install.log'')) -Value (''[$py] '' + $o + '' exit:'' + $LASTEXITCODE); if ($LASTEXITCODE -eq 0) { break } } }"'
    Pop $R1
    FileOpen $R0 "$TEMP\mcpanel-cli-install.log" a
    FileWrite $R0 "Inline install exited: $R1$\r$\n"
    FileClose $R0
  ${EndIf}

  FileOpen $R0 "$TEMP\mcpanel-cli-install.log" a
  FileWrite $R0 "=== MCPanel NSIS hook finished ===$\r$\n"
  FileClose $R0
!macroend
