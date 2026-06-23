# Installs mcpanel-cli via pip and adds the Python Scripts directory to the
# machine-level PATH.  Run by the MSI installer (elevated), so HKLM is writable.
$url = 'https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip'
foreach ($py in @('py', 'python', 'python3')) {
    try { & $py -m pip install --user $url 2>&1 | Out-Null } catch { continue }
    if ($LASTEXITCODE -ne 0) { continue }
    $s = (& $py -c 'import sysconfig; print(sysconfig.get_path("scripts","nt_user"))' 2>$null)
    if ($s) {
        $s = $s.Trim()
        $p = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
        if ($p -notlike "*$s*") {
            [Environment]::SetEnvironmentVariable('PATH', $p.TrimEnd(';') + ';' + $s, 'Machine')
        }
    }
    break
}
