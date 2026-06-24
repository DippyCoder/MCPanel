# Installs mcpanel-cli via pip and adds the Python Scripts directory to the
# machine-level PATH.  Run by the MSI/NSIS installer (elevated), so HKLM is writable.
# Install log: %TEMP%\mcpanel-cli-install.log

$logFile = Join-Path $env:TEMP 'mcpanel-cli-install.log'

function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
    Write-Host $line
}

Write-Log '=== mcpanel-cli install started ==='
Write-Log "Running as: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Write-Log "Script path: $PSCommandPath"
Write-Log "PSScriptRoot: $PSScriptRoot"
Write-Log "Working dir: $(Get-Location)"

$url = 'https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip'
Write-Log "Install URL: $url"

$installed = $false

foreach ($py in @('py', 'python', 'python3')) {
    Write-Log "Trying Python launcher: '$py'"
    try {
        $verOut = & $py --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "  Not found (exit $LASTEXITCODE)"
            continue
        }
        Write-Log "  Found: $verOut"

        # Try system-wide first (works better in elevated installer context).
        # Fall back to --user if system-wide fails (e.g. managed Python installs).
        $pipOut = $null
        foreach ($flags in @('', '--user')) {
            $flagsLabel = if ($flags) { $flags } else { '(system-wide)' }
            Write-Log "  pip install $flagsLabel ..."
            if ($flags) {
                $pipOut = & $py -m pip install $flags $url 2>&1
            } else {
                $pipOut = & $py -m pip install $url 2>&1
            }
            Write-Log "  pip output: $pipOut"
            Write-Log "  pip exit: $LASTEXITCODE"
            if ($LASTEXITCODE -eq 0) { break }
            Write-Log "  pip install $flagsLabel failed — trying next mode"
        }

        if ($LASTEXITCODE -ne 0) {
            Write-Log "  All pip modes failed — trying next Python command"
            continue
        }

        # Determine the scripts directory that pip just wrote to.
        # System-wide first, then nt_user scheme as fallback.
        $scriptsPath = $null
        foreach ($scheme in @('', 'nt_user')) {
            $schemeArg = if ($scheme) { ",`"$scheme`"" } else { '' }
            $out = & $py -c "import sysconfig; print(sysconfig.get_path('scripts'$schemeArg))" 2>&1
            Write-Log "  Scripts path (scheme=$($scheme ? $scheme : 'default')): $out"
            if ($LASTEXITCODE -eq 0 -and $out) { $scriptsPath = $out.Trim(); break }
        }

        if ($scriptsPath) {
            $currentPath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
            if ($currentPath -notlike "*$scriptsPath*") {
                [Environment]::SetEnvironmentVariable(
                    'PATH', $currentPath.TrimEnd(';') + ';' + $scriptsPath, 'Machine')
                Write-Log "  Added to Machine PATH: $scriptsPath"
            } else {
                Write-Log "  Already in Machine PATH: $scriptsPath"
            }
        } else {
            Write-Log "  WARNING: Could not determine scripts directory — PATH not updated"
        }

        $installed = $true
        Write-Log "  Install succeeded with '$py'"
        break
    } catch {
        Write-Log "  Exception with '$py': $_"
        continue
    }
}

if (-not $installed) {
    Write-Log 'WARNING: Could not install mcpanel-cli.'
    Write-Log '  Python was not found or pip failed for all launchers tried.'
    Write-Log "  Manual install: pip install $url"
    Write-Log "  See log: $logFile"
}

Write-Log '=== mcpanel-cli install finished ==='
