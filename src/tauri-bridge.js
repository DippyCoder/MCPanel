/* ═══════════════════════════════════════════════════════
   MCPanel Tauri Bridge — exposes window.mcpanel with the
   same API surface as the Electron preload, but backed by
   Tauri invoke() calls to the Rust backend / mcpanel CLI.
   ═══════════════════════════════════════════════════════ */

(function () {
  // backdrop-filter: blur() crashes WebKit2GTK on Linux when compositing is
  // disabled (WEBKIT_DISABLE_COMPOSITING_MODE=1, needed to avoid Wayland EPROTO).
  // Add a class so CSS can skip it on Linux.
  if (/Linux/.test(navigator.platform)) {
    document.documentElement.classList.add('linux');
  }

  // Tauri v2 with withGlobalTauri:true exposes window.__TAURI_INTERNALS__
  const _invoke = (...a) => window.__TAURI_INTERNALS__.invoke(...a);
  // In Tauri v2, listen is on window.__TAURI__.event, not __TAURI_INTERNALS__
  const _listen = (...a) => window.__TAURI__.event.listen(...a);

  // Resolves true/false after the startup CLI check completes.
  // app.js waits on this before calling init() so no CLI subprocess is ever
  // spawned until we confirm the real CLI tool is present (not the GUI binary).
  let _cliReadyResolve;
  window._cliReady = new Promise(resolve => { _cliReadyResolve = resolve; });

  // ─── CLI helper ─────────────────────────────────────────────────────────────
  // Error contract: the CLI reports every failure as {"error": "<message>",
  // "code": "<code>"}. Those documents come back from cli() as ordinary values
  // (callers check `.error` and show it verbatim - the CLI owns the wording,
  // so an error added in a newer CLI still reads right in this build). Only
  // failures the CLI couldn't report itself are thrown, as Errors with a
  // `.code` of their own.
  function _coded(message, code) {
    return Object.assign(new Error(message), { code: code || 'error' });
  }

  async function cli(args) {
    // Block until check is done AND it passed. This prevents run_cli from
    // spawning subprocesses before we know mcpanel resolves to the CLI tool.
    if (window._cliOk !== true) throw _coded('MCPanel-CLI is not available', 'cli_unavailable');
    let raw;
    try {
      raw = await _invoke('run_cli', { args });
    } catch (e) {
      // run_cli rejects with the CLI's stderr when it printed nothing at all.
      throw _coded(String(e || 'MCPanel-CLI failed'), 'cli_failed');
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw _coded(`MCPanel-CLI returned unreadable output: ${String(raw).slice(0, 300)}`, 'cli_bad_output');
    }
  }

  // cli(), but a failure to run the CLI at all also becomes an {error, code}
  // value - for calls whose callers only ever check `.error`.
  async function cliResult(args) {
    try { return await cli(args); }
    catch (e) { return { error: e.message, code: e.code || 'error' }; }
  }

  // mcpanel.json is the server's own manifest (id, dir, etc.) — not something
  // a user should see or touch from the file browser.
  function _stripMcpanelJson(nodes) {
    if (!Array.isArray(nodes)) return nodes;
    return nodes
      .filter(n => n.name !== 'mcpanel.json')
      .map(n => n.children ? { ...n, children: _stripMcpanelJson(n.children) } : n);
  }

  // ─── Event bridge ────────────────────────────────────────────────────────────
  const _listeners = {};   // channel → [{original, wrapped, unlisten}]

  function on(channel, cb) {
    const allowed = ['server-log', 'server-stopped', 'download-progress', 'backup-progress', 'schedule-fired'];
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
    // Which frontend this is - addon UI scripts (addons-ui.js) read it.
    product: 'mcpanel',
    // Raw `mcpanel api <args…>` for addon UI scripts and the addon browser.
    // CLI failures resolve as {error, code} documents; failing to reach the
    // CLI at all rejects with an Error carrying `.code`.
    cli: (args) => cli(Array.isArray(args) ? args.map(String) : []),

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

    // keepFiles: only remove it from MCPanel's list ("Remove"); otherwise the
    // server's files are deleted too - a linked server's original folder included.
    deleteServer: async (id, { keepFiles = false } = {}) => {
      const args = ['delete', 'server', '-id', id];
      if (keepFiles) args.push('--keep-files');
      return cli(args);
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

    // The server's own logs/ folder (Logs tab). All three resolve to the CLI's
    // document - an {error, code} one included - and never throw.
    listLogFiles: (id) => cliResult(['fetch', 'logfiles', '-id', id]),
    readLogFile: (id, file) => cliResult(['fetch', 'logfile', '-id', id, '-file', file]),
    // Uploads (at most the newest 10k lines / 25 MB of) a log file to mclo.gs.
    uploadLog: (id, file) => cliResult(['upload-log', '-id', id, '-file', file]),

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

    // Which detected JDKs can actually build/run a given software+version —
    // drives the Spigot JDK picker (BuildTools enforces an exact compile-time
    // Java range, so silent auto-detection isn't enough there).
    getJdkCompatibility: (software, version) =>
      cli(['fetch', 'jdk-compat', '-sw', software, '-v', version]),

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
      // Use the folder in place instead of copying it into MCPanel's dir.
      if (data.link) args.push('--link');
      const raw = await _invoke('import_server_cmd', { args });
      return JSON.parse(raw);
    },

    getServerFileTree: async (id) => {
      const r = await cli(['fetch', 'files', '-id', id]);
      if (r && Array.isArray(r.tree)) r.tree = _stripMcpanelJson(r.tree);
      return r;
    },

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

    exportServerFiles: (id, relPaths, destDir) =>
      _invoke('export_server_files', { id, relPaths, destDir }),

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
    exportProfileFiles: (id, relPaths, destDir) =>
      _invoke('export_profile_files', { id, relPaths, destDir }),

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
    // Both go through the CLI, which links transactionally (all files or
    // none) and returns {error, code, failedStep, rolledBack} on failure.
    proxyInfo: (velocityId) =>
      cliResult(['proxy', 'info', '--velocity-id', String(velocityId)]),

    linkToProxy: (paperId, velocityId, serverName, priority, customIp) => {
      const args = ['proxy', 'link', '-id', String(paperId), '--velocity-id', String(velocityId)];
      if (serverName) args.push('--server-name', String(serverName));
      if (priority !== undefined && priority !== null) args.push('--priority', String(priority));
      // A bare host is fine: the CLI appends the backend's port itself.
      if (customIp) args.push('--custom-ip', String(customIp));
      return cliResult(args);
    },

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

    // BuildTools (SpigotMC) — installed/latest build + manual update trigger
    getBuildToolsVersion: () => cli(['buildtools', 'version']),
    updateBuildTools: () => cli(['buildtools', 'update']),

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
    logEvent: (message, level = 'info') => _invoke('log_event', { level, message }),

    // Backups
    createBackup: (id) => _invoke('create_backup', { id }),
    listBackups: (id) => _invoke('list_backups', { id }),
    deleteBackup: (id, backupName) => _invoke('delete_backup', { id, backupName }),
    restoreBackup: (id, backupName) => _invoke('restore_backup', { id, backupName }),

    // Schedules
    getSchedules: (serverId) => _invoke('get_schedules', { serverId }),
    saveSchedule: (schedule) => _invoke('save_schedule', { schedule }),
    deleteSchedule: (scheduleId) => _invoke('delete_schedule', { scheduleId }),
    runScheduleNow: (serverId, action, command) => _invoke('run_schedule_now', { serverId, action, command: command || null }),

    // App settings
    getAppSettings: () => _invoke('get_app_settings'),
    saveAppSettings: (settings) => _invoke('save_app_settings', { settings }),
    listSystemFonts: () => _invoke('list_system_fonts'),
    shutdownAllServers: () => _invoke('shutdown_all_servers'),

    // Events
    on,
    off,

    // Plugin / Mod search + install — routed through mcpanel-cli's own
    // urllib-backed API so it isn't subject to browser CORS at all (Spiget's
    // policy blocks the standard User-Agent header on a plain webview fetch).
    searchPlugins: (platform, query, opts = {}) => {
      const args = ['search', 'plugins', platform, query || ''];
      if (opts.software) args.push('-sw', opts.software);
      if (opts.mcVersion) args.push('-v', opts.mcVersion);
      if (opts.limit) args.push('-n', String(opts.limit));
      if (opts.offset) args.push('-o', String(opts.offset));
      return cli(args);
    },
    installPlugin: (platform, slug, opts = {}) => {
      const args = ['install', 'plugin', platform, slug];
      if (opts.serverId) args.push('-id', opts.serverId);
      if (opts.profileId) args.push('--profile-id', opts.profileId);
      if (opts.mcVersion) args.push('-v', opts.mcVersion);
      if (opts.owner) args.push('--owner', opts.owner);
      if (opts.versionId) args.push('--version', String(opts.versionId));
      return cli(args);
    },
    pluginInfo: (platform, slug, opts = {}) => {
      const args = ['info', 'plugin', platform, slug];
      if (opts.owner) args.push('--owner', opts.owner);
      if (opts.limit) args.push('-n', String(opts.limit));
      if (opts.offset) args.push('-o', String(opts.offset));
      return cli(args);
    },

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
        _cliReadyResolve(true);
        setTimeout(() => {
          if (typeof window.toast === 'function')
            window.toast(`MCPanel-CLI v${result.version || '?'} ready`, 'success');
        }, 600);
      } else {
        window._cliOk = false;
        _cliReadyResolve(false);
        showCliMissingModal();
      }
    }).catch(() => {
      window._cliOk = false;
      _cliReadyResolve(false);
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
