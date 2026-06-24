/* ═══════════════════════════════════════════════════════
   MCPanel Tauri Bridge — exposes window.mcpanel with the
   same API surface as the Electron preload, but backed by
   Tauri invoke() calls to the Rust backend / mcpanel CLI.
   ═══════════════════════════════════════════════════════ */

(function () {
  // Tauri v2 with withGlobalTauri:true exposes window.__TAURI_INTERNALS__
  const _invoke = (...a) => window.__TAURI_INTERNALS__.invoke(...a);
  // In Tauri v2, listen is on window.__TAURI__.event, not __TAURI_INTERNALS__
  const _listen = (...a) => window.__TAURI__.event.listen(...a);

  // ─── CLI helper ─────────────────────────────────────────────────────────────
  async function cli(args) {
    const raw = await _invoke('run_cli', { args });
    return JSON.parse(raw);
  }

  // ─── Event bridge ────────────────────────────────────────────────────────────
  const _listeners = {};   // channel → [{original, wrapped, unlisten}]

  function on(channel, cb) {
    const allowed = ['server-log', 'server-stopped', 'download-progress'];
    if (!allowed.includes(channel)) return;
    if (!_listeners[channel]) _listeners[channel] = [];
    const wrapped = (e) => cb(e.payload);
    const entry = { original: cb, wrapped, unlisten: null };
    _listeners[channel].push(entry);
    _listen(channel, wrapped).then(unlisten => { entry.unlisten = unlisten; });
  }

  function off(channel, cb) {
    if (!_listeners[channel]) return;
    const idx = _listeners[channel].findIndex(e => e.original === cb);
    if (idx !== -1) {
      const e = _listeners[channel].splice(idx, 1)[0];
      if (e.unlisten) e.unlisten();
    }
  }

  // ─── Window controls ─────────────────────────────────────────────────────────
  function _currentWindow() {
    return window.__TAURI__?.window?.getCurrentWindow?.();
  }
  function minimize() {
    const w = _currentWindow();
    if (w) w.minimize(); else _invoke('plugin:window|minimize');
  }
  function maximize() {
    const w = _currentWindow();
    if (w) w.toggleMaximize(); else _invoke('plugin:window|toggle_maximize');
  }
  function close() {
    _invoke('quit_app');
  }
  function startResizeDragging(direction) {
    const w = _currentWindow();
    if (w) w.startResizeDragging(direction);
    else _invoke('plugin:window|start_resize_dragging', { value: direction });
  }

  // ─── Public API ──────────────────────────────────────────────────────────────
  window.mcpanel = {

    // Config
    getConfig: async () => {
      try { return await cli(['config', 'show']); }
      catch { return { servers: [], jdkPaths: [], activeTheme: null }; }
    },
    saveConfig: (cfg) => _invoke('save_config', { config: cfg }),

    // Versions
    fetchVersions: async (software, preRelease = false, unstable = false) => {
      const args = ['versions', '-sw', software];
      if (unstable)   args.push('--unstable');
      if (preRelease) args.push('--prerelease');
      return cli(args);
    },

    // Servers (list comes from getConfig().servers — refreshed there)
    createServer: async (data) => {
      const args = [
        '-t',    data.name,
        '-sw',   data.software,
        '-v',    data.version,
        '-p',    String(data.port),
        '-ram',  data.ram,
      ];
      if (data.javaPath && data.javaPath !== 'java') {
        args.push('-java', data.javaPath);
      }
      if (data.javaArgs) args.push('-jargs', data.javaArgs);
      if (data.profileId) args.push('-profile', data.profileId);
      if (data.storageLimit) args.push('-storage', data.storageLimit);
      if (data.unstableBuilds) args.push('--unstable');
      const raw = await _invoke('create_server', { args });
      return JSON.parse(raw);
    },

    deleteServer: async (id) => {
      return cli(['delete', 'server', '-id', id]);
    },

    updateServer: async (id, updates) => {
      const raw = await _invoke('update_server', { id, updates });
      return JSON.parse(raw);
    },

    // Server control
    startServer: async (id) => {
      const raw = await _invoke('start_server', { id });
      return JSON.parse(raw);
    },

    stopServer: (id) => cli(['stop', 'server', '-id', id]),

    killServer: (id) => cli(['kill', 'server', '-id', id]),

    restartServer: (id) => cli(['restart', 'server', '-id', id]),

    sendCommand: (id, cmd) => {
      return _invoke('send_server_command', { id, cmd });
    },

    getServerLog: async (id) => {
      const result = await cli(['fetch', 'log', '-id', id]);
      return Array.isArray(result) ? result : [];
    },

    // Reads log entries written after `offset` bytes. Returns { lines, offset }.
    // Used by the 15 ms console poll; bypasses the CLI for low-latency file reads.
    getLogSince: (id, offset) => _invoke('get_log_since', { id, offset }),

    isServerRunning: async (id) => {
      const result = await cli(['fetch', 'status', '-id', id]);
      if (typeof result === 'boolean') return result;
      if (result && typeof result.running === 'boolean') return result.running;
      return false;
    },

    pingServer: (host, port) => _invoke('ping_server', { host, port }),

    acceptEula: async (id) => {
      const raw = await _invoke('accept_eula', { id });
      return JSON.parse(raw);
    },

    getServerDirStats: async (id) => {
      const result = await cli(['fetch', 'stats', '-id', id]);
      return result && typeof result.size === 'number' ? result : { size: 0 };
    },

    // Profiles
    getProfiles: async () => {
      try {
        const result = await cli(['list', 'profiles']);
        return Array.isArray(result) ? result : (result.profiles || []);
      } catch { return []; }
    },

    createProfile: (data) => {
      const args = ['-t', data.name];
      if (data.description) args.push('-desc', data.description);
      if (data.software && data.software.length)
        args.push('-sw', data.software.join(','));
      if (data.versions && data.versions.length)
        args.push('-versions', data.versions.join(','));
      return cli(['create', 'profile', ...args]);
    },

    deleteProfile: (id) => cli(['delete', 'profile', '-id', id]),

    openProfileFolder: (id) => cli(['open', 'profile', '-id', id]),

    // JDK
    detectJdk: async () => {
      const result = await cli(['detect-jdk']);
      return Array.isArray(result) ? result : (result.jdks || []);
    },

    browseJava: () => _invoke('browse_file', {
      title: 'Select Java Executable',
      extensions: ['*'],
    }),

    // Import / scan / duplicate
    browseFolder: () => _invoke('browse_folder'),

    scanServerFolder: (path) =>
      cli(['scan', 'server', '-path', path]),

    scanProfileFolder: (path) =>
      cli(['scan', 'profile', '-path', path]),

    importProfile: (data) => {
      const args = ['-path', data.folderPath, '-t', data.name];
      if (data.description) args.push('-desc', data.description);
      if (data.software && data.software.length)
        args.push('-sw', data.software.join(','));
      if (data.versions && data.versions.length)
        args.push('-versions', data.versions.join(','));
      return cli(['import', 'profile', ...args]);
    },

    importServer: async (data) => {
      const args = ['-path', data.folderPath, '-t', data.name];
      if (data.port) args.push('-p', String(data.port));
      if (data.ram) args.push('-ram', data.ram);
      if (data.software) args.push('-sw', data.software);
      if (data.version) args.push('-v', data.version);
      if (data.javaPath) args.push('-java', data.javaPath);
      if (data.javaArgs) args.push('-jargs', data.javaArgs);
      const raw = await _invoke('import_server_cmd', { args });
      return JSON.parse(raw);
    },

    getServerFileTree: (id) => cli(['fetch', 'files', '-id', id]),

    openTerminal: () => _invoke('open_terminal'),
    ptyOpen: () => _invoke('pty_open'),
    ptyWrite: (data) => _invoke('pty_write', { data }),
    ptyResize: (rows, cols) => _invoke('pty_resize', { rows, cols }),
    ptyClose: () => _invoke('pty_close'),

    getServerStartTime: (id) => _invoke('get_server_start_time', { id }),
    checkFirstStartFlag: () => _invoke('check_first_start_flag'),

    writeServerFile: (id, relPath, data) =>
      _invoke('write_server_file', { id, relPath, data }),

    uploadFilesFromPaths: (id, srcPaths, destDir) =>
      _invoke('upload_files_to_server', { id, srcPaths, destDir }),

    deleteServerFile: (id, relPath) =>
      _invoke('delete_server_file', { id, relPath }),

    createServerDir: (id, relPath) =>
      _invoke('create_server_dir', { id, relPath }),

    createServerFile: (id, relPath) =>
      _invoke('create_server_file', { id, relPath }),

    renameServerFile: (id, oldPath, newPath) =>
      _invoke('rename_server_file', { id, oldPath, newPath }),

    readServerFile: (id, relPath) =>
      _invoke('read_server_file', { id, relPath }),

    updateProfile: (id, data) =>
      _invoke('update_profile', { id, ...data }),
    getProfileFileTree: (id) =>
      _invoke('get_profile_file_tree', { id }),
    readProfileFile: (id, relPath) =>
      _invoke('read_profile_file', { id, relPath }),
    writeProfileFile: (id, relPath, data) =>
      _invoke('write_profile_file', { id, relPath, data }),
    deleteProfileFile: (id, relPath) =>
      _invoke('delete_profile_file', { id, relPath }),
    createProfileDir: (id, relPath) =>
      _invoke('create_profile_dir', { id, relPath }),
    createProfileFile: (id, relPath) =>
      _invoke('create_profile_file', { id, relPath }),
    renameProfileFile: (id, oldPath, newPath) =>
      _invoke('rename_profile_file', { id, oldPath, newPath }),
    uploadFilesToProfile: (id, srcPaths, destDir) =>
      _invoke('upload_files_to_profile', { id, srcPaths, destDir }),

    createProfileFromServer: async (id, profileData, selectedPaths) => {
      const args = [
        '-id', id,
        '-t', profileData.name,
        '-paths', selectedPaths.join(','),
      ];
      if (profileData.description) args.push('-desc', profileData.description);
      if (profileData.software && profileData.software.length)
        args.push('-sw', profileData.software.join(','));
      if (profileData.versions && profileData.versions.length)
        args.push('-versions', profileData.versions.join(','));
      return cli(['create', 'profile-from-server', ...args]);
    },

    duplicateServer: async (id, newName) => {
      const raw = await _invoke('duplicate_server', { id, newName });
      return JSON.parse(raw);
    },

    // Velocity proxy link (handled natively in Rust — bypasses CLI)
    proxyInfo: (velocityId) =>
      _invoke('proxy_info', { velocityId }),

    linkToProxy: (paperId, velocityId, serverName, priority, customIp) =>
      _invoke('link_to_proxy', {
        paperId, velocityId, serverName,
        priority,
        customIp: customIp || null,
      }),

    // Velocity
    getVelocitySecret: (id) => _invoke('get_velocity_secret', { id }),

    // System stats (RAM + CPU — for sidebar stats panel)
    getSystemStats: () => _invoke('get_system_stats'),

    // System info
    getVersion: () => _invoke('get_app_version'),

    getSystemInfo: async () => {
      try {
        const result = await cli(['system']);
        return result || { totalRam: null, availableStorage: null, totalStorage: null };
      } catch { return { totalRam: null, availableStorage: null, totalStorage: null }; }
    },

    checkUpdate: async () => {
      try {
        const current = await _invoke('get_app_version');
        const data = await _invoke('check_app_update');
        if (!data) return { current, latest: null, hasUpdate: false };
        const latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
        const hasUpdate = !!(current && latest && semverGt(latest, current));
        return { current, latest, hasUpdate, url: data.html_url || '' };
      } catch {
        return { current: null, latest: null, hasUpdate: false };
      }
    },

    checkCliUpdate: async () => {
      try {
        const cliInfo = await _invoke('check_cli');
        const current = (cliInfo && cliInfo.ok && cliInfo.version) ? cliInfo.version : null;
        const data = await _invoke('check_cli_update');
        if (!data) return { current, latest: null, hasUpdate: false };
        const latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
        const hasUpdate = !!(current && latest && semverGt(latest, current));
        const url = data.html_url || 'https://github.com/dippycoder/mcpanel-cli/releases/latest';
        return { current, latest, hasUpdate, url };
      } catch {
        return { current: null, latest: null, hasUpdate: false };
      }
    },

    openExternal: (url) => _invoke('open_external', { url }),

    // Open server/profile folders via opener plugin
    openServerFolder: async (id) => {
      const cfg = await cli(['config', 'show']);
      const srv = (cfg.servers || []).find(s => s.id === id);
      if (srv && srv.dir) await _invoke('open_path', { path: srv.dir });
      return { success: true };
    },

    // Themes — all handled natively in Rust, no CLI involvement
    ensureBuiltinThemes: () => _invoke('ensure_builtin_themes'),
    getThemes: () => _invoke('get_themes'),
    getThemeCss: (id) => _invoke('get_theme_css', { id }),
    deleteTheme: (id) => _invoke('delete_theme', { id }),
    installThemeUrl: (url) => _invoke('install_theme_from_url', { url }),
    installThemeFile: (filePath) => _invoke('install_theme_from_file', { path: filePath }),
    fetchGithubThemes: () => _invoke('fetch_github_themes'),
    themeExists: (id) => _invoke('theme_exists', { id }),
    installBuiltinTheme: (id, css, json) => _invoke('install_builtin_theme', { id, css, json }),
    getDefaultTheme: () => _invoke('get_default_theme'),
    setDefaultTheme: (id) => _invoke('set_default_theme', { id }),

    browseThemeFile: () => _invoke('browse_file', {
      title: 'Theme Archive',
      extensions: ['zip'],
    }),

    // Logs (open app log file)
    openAppLogs: async () => {
      const path = await _invoke('get_app_log_path');
      await _invoke('open_path', { path });
    },

    // Events
    on,
    off,

    // Window
    minimize,
    maximize,
    close,
    startResizeDragging,
  };

  // ─── Semver helper (used by checkCliUpdate) ──────────────────────────────────
  function semverGt(a, b) {
    const parse = v => String(v).replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0);
    const [aM, am, ap] = parse(a);
    const [bM, bm, bp] = parse(b);
    if (aM !== bM) return aM > bM;
    if (am !== bm) return am > bm;
    return ap > bp;
  }

  // ─── Startup CLI health check ────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    _invoke('check_cli').then(result => {
      if (result && result.ok) {
        window._cliOk = true;
        setTimeout(() => {
          if (typeof window.toast === 'function')
            window.toast(`MCPanel-CLI v${result.version || '?'} ready`, 'success');
        }, 600);
      } else {
        window._cliOk = false;
        showCliMissingModal();
      }
    }).catch(() => {
      window._cliOk = false;
      showCliMissingModal();
    });
  });

  function showCliMissingBanner(message) {
    function tryShow() {
      const banner = document.getElementById('cli-missing-banner');
      const msgEl  = document.getElementById('cli-missing-msg');
      if (banner && msgEl) {
        msgEl.textContent = message;
        banner.classList.remove('hidden');
      }
    }
    if (document.readyState !== 'loading') {
      tryShow();
    } else {
      window.addEventListener('DOMContentLoaded', tryShow);
    }
  }

  function showCliMissingModal() {
    function tryShow() {
      const modal = document.getElementById('modal-cli-missing');
      if (modal) modal.classList.remove('hidden');
    }
    if (document.readyState !== 'loading') tryShow();
    else window.addEventListener('DOMContentLoaded', tryShow);
  }

  function getCliDownloadUrl() {
    const p = (navigator.platform || '').toLowerCase();
    if (p.includes('linux')) return 'https://mcpanel.dippycoder.xyz/download#cli-linux-bash';
    if (p.includes('win')) return 'https://mcpanel.dippycoder.xyz/download#cli-windows';
    return 'https://mcpanel.dippycoder.xyz/download#cli-macos';
  }
  window._cliDownloadUrl = getCliDownloadUrl;

  // ─── In-app CLI installer (called by "Install CLI" button) ───────────────────
  window._installCli = async function () {
    const btn    = document.getElementById('cli-install-btn');
    const msgEl  = document.getElementById('cli-missing-msg');
    const banner = document.getElementById('cli-missing-banner');
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = 'Installing…';
    if (msgEl) msgEl.textContent = 'Installing mcpanel-cli from GitHub…';

    try {
      const result = await _invoke('install_cli');
      if (msgEl) msgEl.textContent = result;
      btn.textContent = 'Installed!';
      btn.style.background = '#226622';
      // Re-check and hide banner after a moment
      setTimeout(async () => {
        const check = await _invoke('check_cli');
        if (check && check.ok) {
          banner.classList.add('hidden');
          window._cliOk = true;
          if (typeof window.toast === 'function')
            window.toast('MCPanel-CLI installed & ready!', 'success');
          // Reload app state
          if (typeof window.init === 'function') window.init();
        }
      }, 1000);
    } catch (e) {
      if (msgEl) msgEl.textContent = String(e);
      btn.textContent = 'Install CLI';
      btn.disabled = false;
    }
  };
})();
