/* ═══════════════════════════════════════════════════════
   MCPanel Frontend — app.js
   ═══════════════════════════════════════════════════════ */

let config = { servers: [], jdkPaths: [] };
let profiles = [];
let currentServerId = null;
let systemInfo = { totalRam: null, availableStorage: null, totalStorage: null };
// Host-CPU facts, cached from getSystemStats — used for the detail CPU sub.
let systemCpu = { threads: null, cores: null, freqMhz: null, name: null };
let versionCache = {};
let statusPollInterval = null;
let statusFetchRetryAt = {};   // server id -> ms timestamp to resume polling after a fetch error
let uptimeInterval = null;
let sidebarStatsInterval = null;
let commandHistory = [];
let historyIndex = -1;
let startingServers = new Set();
let serverStartTimes = {};
let pendingEulaServerId = null;
let consoleAutoScroll = true;
let consoleLogOffset = 0;
let consolePollInterval = null;
let detailStatsInterval = null;
let selectedFilePaths = new Set();
let serverPlayerData = {};
let serversSortBy = localStorage.getItem('mcpanel-servers-sort') || 'name';
let profilesSortBy = localStorage.getItem('mcpanel-profiles-sort') || 'name';
let serversSortReversed = localStorage.getItem('mcpanel-servers-sort-dir') === '1';
let profilesSortReversed = localStorage.getItem('mcpanel-profiles-sort-dir') === '1';

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  config = await window.mcpanel.getConfig();
  window.mcpanel.getSystemInfo().then(info => { systemInfo = info; });
  await loadAppSettings();

  // Ensure built-in themes are installed to user themes dir
  await ensureBuiltinThemes();

  const defaultThemeId = await window.mcpanel.getDefaultTheme();

  // Apply saved theme before rendering UI to avoid flash
  if (!config.activeTheme) {
    config.activeTheme = defaultThemeId;
    await window.mcpanel.saveConfig(config);
  }
  await loadAndApplyTheme(config.activeTheme);
  const _initThemes = await window.mcpanel.getThemes();
  const _initTheme = _initThemes.find(t => t.id === config.activeTheme);
  if (_initTheme) {
    document.getElementById('active-theme-name').textContent = _initTheme.name;
  }
  if (config.activeTheme !== defaultThemeId) {
    document.getElementById('reset-theme-btn').style.display = '';
  }
  // Titlebar logo (respects the theme's --app-icon when on Auto)
  applyAppIcon();
  renderAppIconPicker();

  window.mcpanel.getVersion().then(v => {
    const el = document.getElementById('about-version');
    if (el) el.textContent = `MCPanel v${v} · Built for Minecraft server management`;
  });

  profiles = await window.mcpanel.getProfiles();
  const serversSortSel = document.getElementById('servers-sort');
  if (serversSortSel) serversSortSel.value = serversSortBy;
  const profilesSortSel = document.getElementById('profiles-sort');
  if (profilesSortSel) profilesSortSel.value = profilesSortBy;
  _setSortDirBtnState('servers-sort-dir-btn', serversSortReversed);
  _setSortDirBtnState('profiles-sort-dir-btn', profilesSortReversed);
  renderServersGrid();
  renderSidebarServers();
  startStatusPolling();
  startUptimeTicker();
  setupConsoleScroll();

  updateSidebarStats();
  updateServersPageStats();
  if (sidebarStatsInterval) clearInterval(sidebarStatsInterval);
  sidebarStatsInterval = setInterval(updateSidebarStats, 5000);

  // Event listeners
  window.mcpanel.on('server-stopped', ({ id }) => {
    startingServers.delete(id);
    delete serverStartTimes[id];
    const uptimeEl = document.getElementById(`uptime-${id}`);
    if (uptimeEl) uptimeEl.textContent = '-';
    if (id === currentServerId) {
      appendConsoleLine('Server stopped.', 'system');
      updateDetailControls(false);
      const detailUptime = document.getElementById('detail-uptime');
      if (detailUptime) detailUptime.textContent = '-';
    }
    updateServerCardStatus(id, false, 0);
    updateSidebarDot(id, false);
  });

  window.mcpanel.on('download-progress', ({ id, progress, status }) => {
    document.getElementById('download-status-text').textContent = status;
    document.getElementById('progress-bar-fill').style.width = progress + '%';
    document.getElementById('progress-percent').textContent = progress + '%';
  });

  // Silent update checks on startup — populate status and toast if update found
  window.mcpanel.checkUpdate().then(result => applyUpdateResult(result));
  window.mcpanel.checkCliUpdate().then(result => applyCliUpdateResult(result));
  window.mcpanel.getBuildToolsVersion().then(result => {
    applyBuildToolsResult(result);
    if (result && result.version !== 'installed') showBuildToolsMissingModal();
  }).catch(() => {});
  checkPrivacyPolicy();

  // File drag-drop + close notification via the Tauri window handle
  const _win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (_win?.listen) {
    _win.listen('tauri://drag-drop', async (event) => {
      const paths = event.payload?.paths || [];
      if (!paths.length) return;

      const profilePane = document.getElementById('pane-profile-files');
      if (currentProfileId && profilePane && !profilePane.classList.contains('hidden')) {
        document.getElementById('profile-file-drop-zone')?.classList.remove('drop-active');
        document.querySelectorAll('.file-row.drop-target').forEach(r => r.classList.remove('drop-target'));
        await uploadProfileFilesFromPaths(paths, profileNavPaths.join('/'));
        return;
      }

      if (!currentServerId) return;
      const pane = document.getElementById('pane-files');
      if (!pane || pane.classList.contains('hidden')) return;
      document.getElementById('file-drop-zone')?.classList.remove('drop-active');
      document.querySelectorAll('.file-row.drop-target').forEach(r => r.classList.remove('drop-target'));
      await uploadFilesFromPaths(paths, fileNavPaths.join('/'));
    });

  }


  // First-start check
  const debugFlag = await window.mcpanel.checkFirstStartFlag();
  if (debugFlag || !config.firstStartDone) {
    openFirstStart();
  }
}

// ─── App Settings ─────────────────────────────────────────────────────────────
let _appSettings = { runInBackground: true, fonts: { display: 'Poppins', displayWeight: '400', mono: 'JetBrains Mono', monoWeight: '400' } };

async function loadAppSettings() {
  try {
    _appSettings = await window.mcpanel.getAppSettings();
  } catch (e) {
    // defaults already set
  }
  const el = document.getElementById('setting-run-in-bg');
  if (el) el.checked = _appSettings.runInBackground !== false;
  const clearEl = document.getElementById('setting-clear-console-on-start');
  if (clearEl) clearEl.checked = _appSettings.clearConsoleOnStart === true;
  const maxLogFilesEl = document.getElementById('setting-max-log-files');
  if (maxLogFilesEl) maxLogFilesEl.value = _appSettings.maxLogFiles || 10;
  applyFontSettings(_appSettings.fonts || {});
  _syncFontSelects(_appSettings.fonts || {});
  populateFontLists(_appSettings.fonts || {});
  renderAppIconPicker();
}

async function saveRunInBackground() {
  _appSettings.runInBackground = document.getElementById('setting-run-in-bg').checked;
  await window.mcpanel.saveAppSettings(_appSettings);
}

async function saveClearConsoleOnStart() {
  _appSettings.clearConsoleOnStart = document.getElementById('setting-clear-console-on-start').checked;
  await window.mcpanel.saveAppSettings(_appSettings);
}

async function saveMaxLogFiles() {
  const el = document.getElementById('setting-max-log-files');
  const n = Math.max(1, Math.min(100, parseInt(el.value, 10) || 10));
  el.value = n;
  _appSettings.maxLogFiles = n;
  await window.mcpanel.saveAppSettings(_appSettings);
}

// ─── App Icon ─────────────────────────────────────────────────────────────────
// Swaps the in-app titlebar logo (top-left corner) between bundled variants.
// This is purely an in-app HTML image — it does NOT touch the native OS window/
// taskbar icon (that's owned by the .desktop file / platform).
// Resolution order: explicit user choice in Settings > theme's `--app-icon` hint
// > default.
const APP_ICONS = [
  { key: 'default',       label: 'Default' },
  { key: 'blue',          label: 'Blue' },
  { key: 'green',         label: 'Green' },
  { key: 'red',           label: 'Red' },
  { key: 'yellow',        label: 'Yellow' },
  { key: 'black',         label: 'Black' },
  { key: 'white',         label: 'White' },
  { key: 'outline',       label: 'Outline' },
  { key: 'outline-white', label: 'Outline White' },
];
const APP_ICON_KEYS = APP_ICONS.map(i => i.key);

function _iconAssetPath(key) {
  return key === 'default' ? 'assets/icons/icon.png' : `assets/icons/icon-${key}.png`;
}

// Icon suggested by the active theme via `:root { --app-icon: <key>; }`.
// Returns '' when the theme doesn't specify one.
function themeSuggestedIcon() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--app-icon').trim().replace(/['"]/g, '');
  return APP_ICON_KEYS.includes(raw) ? raw : '';
}

// The icon that should actually be shown right now.
function resolveAppIcon() {
  const choice = _appSettings.appIcon || 'auto';
  if (choice !== 'auto' && APP_ICON_KEYS.includes(choice)) return choice;
  return themeSuggestedIcon() || 'default';
}

function applyAppIcon() {
  const img = document.getElementById('titlebar-logo-img');
  if (img) img.src = _iconAssetPath(resolveAppIcon());
}

function renderAppIconPicker() {
  const container = document.getElementById('app-icon-picker');
  if (!container) return;
  const choice = _appSettings.appIcon || 'auto';
  const themed = themeSuggestedIcon();

  const autoResolved = themed || 'default';
  const opts = [
    {
      key: 'auto',
      label: 'Auto',
      hint: `Theme: ${APP_ICONS.find(i => i.key === autoResolved)?.label || 'Default'}`,
      preview: _iconAssetPath(autoResolved),
    },
    ...APP_ICONS.map(i => ({ key: i.key, label: i.label, hint: '', preview: _iconAssetPath(i.key) })),
  ];

  container.innerHTML = opts.map(o => `
    <button class="app-icon-option${choice === o.key ? ' selected' : ''}"
            onclick="selectAppIcon('${o.key}')" title="${escapeHtml(o.label)}">
      <img src="${o.preview}" alt="" width="32" height="32">
      <span class="app-icon-option-label">${escapeHtml(o.label)}</span>
      ${o.hint ? `<span class="app-icon-option-hint">${escapeHtml(o.hint)}</span>` : ''}
    </button>
  `).join('');
}

async function selectAppIcon(key) {
  _appSettings.appIcon = key;
  await window.mcpanel.saveAppSettings(_appSettings);
  applyAppIcon();
  renderAppIconPicker();
}

// ─── Window Close ─────────────────────────────────────────────────────────────
async function requestClose() {
  const runningIds = Object.keys(serverStartTimes);
  const runInBg = _appSettings.runInBackground !== false;
  if (!runInBg && runningIds.length > 0) {
    const n = runningIds.length;
    if (!confirm(`Stop ${n} server${n !== 1 ? 's' : ''} before closing MCPanel?`)) return;
    await window.mcpanel.shutdownAllServers();
  } else if (runInBg && runningIds.length > 0) {
    const n = runningIds.length;
    if (!confirm(`${n} server${n !== 1 ? 's are' : ' is'} still running and will continue after MCPanel closes.\n\nClose anyway?`)) return;
  }
  window.mcpanel.close();
}

// ─── Page Navigation ──────────────────────────────────────────────────────────
function showPage(page) {
  stopConsolePoll();
  if (detailStatsInterval) { clearInterval(detailStatsInterval); detailStatsInterval = null; }
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-' + page).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');

  if (page === 'profiles') renderProfilesGrid();
  if (page === 'servers') renderServersGrid();
  if (page === 'settings') renderInstalledThemes();
}

function openServerDetail(id) {
  currentServerId = id;
  cachedFileTree = null; fileNavStack = []; fileNavPaths = []; selectedFilePaths = new Set();
  const _pluginListEl = document.getElementById('server-plugin-list');
  if (_pluginListEl) _pluginListEl.innerHTML = `<div class="plugin-state-msg">Search for plugins or mods to install them.</div>`;
  const _pluginSearchEl = document.getElementById('server-plugin-search');
  if (_pluginSearchEl) _pluginSearchEl.value = '';
  switchDetailTab('console');
  const srv = config.servers.find(s => s.id === id);
  if (!srv) return;
  window.mcpanel.logEvent(`Opened server panel: ${srv.name} -id ${id}`);

  document.querySelectorAll('.sidebar-server-item').forEach(el => el.classList.remove('active'));
  const sidebarItem = document.querySelector(`[data-server-id="${id}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');

  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-server-detail').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Fill detail
  document.getElementById('detail-server-name').textContent = srv.name;
  document.getElementById('detail-server-subtitle').textContent =
    `${srv.version} · ${capitalise(srv.software)} · Port ${srv.port}`;
  document.getElementById('dtab-plugins-label').textContent = _pluginTabLabel(srv.software);
  document.getElementById('detail-port').textContent = srv.port;
  setRamBar(0, srv.ram);
  setCpuGauge(null, false);

  // Quick settings
  document.getElementById('quick-port').value = srv.port;
  document.getElementById('quick-java-args').value = srv.javaArgs || '';
  populateJdkSelect('quick', 'quick-java-path', srv.javaPath || 'java');
  document.getElementById('quick-group').value = srv.group || '';

  // Show Velocity-specific options only for Velocity servers
  const velocityCard = document.getElementById('velocity-quick-options');
  if (velocityCard) {
    if (srv.software === 'velocity') {
      velocityCard.classList.remove('hidden');
    } else {
      velocityCard.classList.add('hidden');
    }
  }

  // Load console and check running state together
  consoleAutoScroll = true;
  document.getElementById('autoscroll-banner').classList.add('hidden');
  const logEl = document.getElementById('console-output');
  logEl.innerHTML = '';
  stopConsolePoll();
  consoleLogOffset = 0;

  window.mcpanel.isServerRunning(id).then(running => {
    updateDetailControls(running);
    if (running) {
      updateDetailOnline(true);
      // Only load persisted logs when server is actively running (fresh log from rotate_log)
      window.mcpanel.getLogSince(id, 0).then(result => {
        consoleLogOffset = result.offset || 0;
        (result.lines || []).forEach(entry => appendConsoleLine(entry.text || '', entry.type || 'out'));
        startConsolePoll(id);
      });
    } else {
      // Server is stopped — start polling so logs appear when it starts
      startConsolePoll(id);
    }
  });

  // Initialise uptime display
  const detailUptime = document.getElementById('detail-uptime');
  if (detailUptime) {
    detailUptime.textContent = serverStartTimes[id] ? formatUptime(Date.now() - serverStartTimes[id]) : '-';
  }

  // Storage stats — load immediately then refresh every 5 s
  refreshDetailStats(id);
  if (detailStatsInterval) clearInterval(detailStatsInterval);
  detailStatsInterval = setInterval(() => refreshDetailStats(currentServerId), 5000);
}

async function refreshDetailStats(id) {
  if (!id) return;
  const srv = config.servers.find(s => s.id === id);
  if (!srv) return;
  const result = await window.mcpanel.getServerDirStats(id);
  setStorageBar(result.size, srv.storageLimit);
  setRamBar(result.ramBytes || 0, srv.ram);
  const online = result.cpuPct != null;
  setCpuGauge(online ? result.cpuPct : null, online);
}

// ─── Sorting ───────────────────────────────────────────────────────────────────
function onServersSortChange() {
  serversSortBy = document.getElementById('servers-sort').value;
  localStorage.setItem('mcpanel-servers-sort', serversSortBy);
  renderServersGrid();
}

function onProfilesSortChange() {
  profilesSortBy = document.getElementById('profiles-sort').value;
  localStorage.setItem('mcpanel-profiles-sort', profilesSortBy);
  renderProfilesGrid();
}

function _setSortDirBtnState(btnId, reversed) {
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.toggle('reversed', reversed);
}

function onServersSortDirToggle() {
  serversSortReversed = !serversSortReversed;
  localStorage.setItem('mcpanel-servers-sort-dir', serversSortReversed ? '1' : '0');
  _setSortDirBtnState('servers-sort-dir-btn', serversSortReversed);
  renderServersGrid();
}

function onProfilesSortDirToggle() {
  profilesSortReversed = !profilesSortReversed;
  localStorage.setItem('mcpanel-profiles-sort-dir', profilesSortReversed ? '1' : '0');
  _setSortDirBtnState('profiles-sort-dir-btn', profilesSortReversed);
  renderProfilesGrid();
}

function sortServers(list) {
  const sign = serversSortReversed ? -1 : 1;
  const sorted = [...list];
  if (serversSortBy === 'created') {
    sorted.sort((a, b) => sign * ((b.created || 0) - (a.created || 0)));
  } else if (serversSortBy === 'lastBoot') {
    sorted.sort((a, b) => sign * ((b.lastBoot || 0) - (a.lastBoot || 0)));
  } else {
    sorted.sort((a, b) => sign * a.name.localeCompare(b.name));
  }
  return sorted;
}

function sortProfiles(list) {
  const sign = profilesSortReversed ? -1 : 1;
  const sorted = [...list];
  if (profilesSortBy === 'created') {
    sorted.sort((a, b) => sign * ((b.created || 0) - (a.created || 0)));
  } else if (profilesSortBy === 'lastBoot') {
    // Profiles don't boot themselves — sort by the most recent boot among
    // the servers currently using each profile ("last used").
    const lastUsed = {};
    (config.servers || []).forEach(s => {
      if (!s.profileId) return;
      const t = s.lastBoot || 0;
      if (t > (lastUsed[s.profileId] || 0)) lastUsed[s.profileId] = t;
    });
    sorted.sort((a, b) => sign * ((lastUsed[b.id] || 0) - (lastUsed[a.id] || 0)));
  } else {
    sorted.sort((a, b) => sign * a.name.localeCompare(b.name));
  }
  return sorted;
}

// ─── Servers Grid ─────────────────────────────────────────────────────────────
function renderServersGrid() {
  const query = (document.getElementById('servers-search')?.value || '').trim().toLowerCase();
  const grid = document.getElementById('servers-grid');
  const empty = document.getElementById('servers-empty');
  grid.querySelectorAll('.server-card, .group-header, .grid-no-results').forEach(c => c.remove());

  if (config.servers.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const servers = sortServers(query
    ? config.servers.filter(s =>
        s.name.toLowerCase().includes(query) ||
        (s.group || '').toLowerCase().includes(query) ||
        s.software.toLowerCase().includes(query) ||
        s.version.toLowerCase().includes(query)
      )
    : config.servers);

  if (servers.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'grid-no-results';
    msg.textContent = `No servers matching "${query}"`;
    grid.appendChild(msg);
    return;
  }

  if (query) {
    servers.forEach(srv => grid.appendChild(createServerCard(srv)));
    return;
  }

  const hasGroups = servers.some(s => s.group);
  if (!hasGroups) {
    servers.forEach(srv => grid.appendChild(createServerCard(srv)));
    return;
  }

  const groups = {};
  const ungrouped = [];
  servers.forEach(srv => {
    if (srv.group) {
      if (!groups[srv.group]) groups[srv.group] = [];
      groups[srv.group].push(srv);
    } else {
      ungrouped.push(srv);
    }
  });

  Object.entries(groups).forEach(([groupName, srvs]) => {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-name">${escapeHtml(groupName)}</span><span class="group-count">${srvs.length} server${srvs.length !== 1 ? 's' : ''}</span>`;
    grid.appendChild(header);
    srvs.forEach(srv => grid.appendChild(createServerCard(srv)));
  });

  if (ungrouped.length > 0) {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-name">Ungrouped</span><span class="group-count">${ungrouped.length} server${ungrouped.length !== 1 ? 's' : ''}</span>`;
    grid.appendChild(header);
    ungrouped.forEach(srv => grid.appendChild(createServerCard(srv)));
  }
}

function createServerCard(srv) {
  const card = document.createElement('div');
  card.className = 'server-card';
  card.id = `card-${srv.id}`;
  card.innerHTML = `
    <div class="server-card-header">
      <div>
        <div class="server-card-name">${escapeHtml(srv.name)}</div>
        <div class="server-card-sub">${srv.version} · ${capitalise(srv.software)}</div>
      </div>
      <div class="status-badge offline" id="badge-${srv.id}">OFFLINE</div>
    </div>
    <div class="server-card-stats">
      <div class="stat-chip">
        <div class="stat-chip-label">Port</div>
        <div class="stat-chip-value">${srv.port}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">RAM</div>
        <div class="stat-chip-value">${srv.ram}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Players</div>
        <div class="stat-chip-value" id="players-${srv.id}">-</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Storage</div>
        <div class="stat-chip-value" id="storage-${srv.id}">${srv.storageLimit || '∞'}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Uptime</div>
        <div class="stat-chip-value" id="uptime-${srv.id}">-</div>
      </div>
    </div>
    <div class="server-card-footer">
      <button class="btn-ghost" style="font-size:12px;padding:6px 12px" onclick="openServerDetail('${srv.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Manage
      </button>
      <div class="card-quick-controls">
        <button class="quick-ctrl-btn start" id="quick-start-${srv.id}" title="Start" onclick="quickStart('${srv.id}', event)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="quick-ctrl-btn stop" id="quick-stop-${srv.id}" title="Stop" onclick="quickStop('${srv.id}', event)" style="display:none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
      </div>
    </div>
  `;
  return card;
}

function updateServerCardStatus(id, online, players) {
  const badge = document.getElementById(`badge-${id}`);
  const playersEl = document.getElementById(`players-${id}`);
  const startBtn = document.getElementById(`quick-start-${id}`);
  const stopBtn = document.getElementById(`quick-stop-${id}`);
  if (badge) {
    if (online === 'starting') {
      badge.className = 'status-badge starting';
      badge.textContent = 'STARTING';
    } else if (online) {
      badge.className = 'status-badge online';
      badge.textContent = 'ONLINE';
    } else {
      badge.className = 'status-badge offline';
      badge.textContent = 'OFFLINE';
    }
  }
  if (playersEl) playersEl.textContent = online === true ? players : '-';
  if (startBtn) startBtn.style.display = online ? 'none' : '';
  if (stopBtn) stopBtn.style.display = online ? '' : 'none';
}

// ─── Sidebar Servers ──────────────────────────────────────────────────────────
function renderSidebarServers() {
  const container = document.getElementById('sidebar-servers');
  if (config.servers.length === 0) {
    container.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--text-muted);text-align:center">No servers</div>`;
    return;
  }
  container.innerHTML = '';

  // Group servers: null/empty group first (ungrouped), then named groups
  const groups = new Map();
  config.servers.forEach(srv => {
    const key = srv.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(srv);
  });

  const appendServer = (srv) => {
    const btn = document.createElement('button');
    btn.className = 'sidebar-server-item';
    btn.dataset.serverId = srv.id;
    btn.innerHTML = `
      <div class="srv-dot offline" id="sdot-${srv.id}"></div>
      <span class="srv-name">${escapeHtml(srv.name)}</span>
      <button class="srv-quick-btn" title="Quick start/stop" id="sqbtn-${srv.id}" onclick="sidebarQuickToggle('${srv.id}', event)">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
    `;
    btn.onclick = (e) => {
      if (e.target.closest('.srv-quick-btn')) return;
      openServerDetail(srv.id);
    };
    container.appendChild(btn);
  };

  // Ungrouped first (no header)
  if (groups.has('')) {
    groups.get('').forEach(appendServer);
    groups.delete('');
  }

  // Named groups with a label
  groups.forEach((servers, groupName) => {
    const header = document.createElement('div');
    header.className = 'sidebar-category-header';
    header.textContent = groupName;
    container.appendChild(header);
    servers.forEach(appendServer);
  });
}

function updateSidebarDot(id, online) {
  const dot = document.getElementById(`sdot-${id}`);
  if (dot) {
    dot.className = `srv-dot ${online ? 'online' : 'offline'}`;
  }
  const qbtn = document.getElementById(`sqbtn-${id}`);
  if (qbtn) {
    qbtn.innerHTML = online
      ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }
}

// ─── Uptime Ticker ────────────────────────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function startUptimeTicker() {
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, startTime] of Object.entries(serverStartTimes)) {
      const uptime = formatUptime(now - startTime);
      const cardEl = document.getElementById(`uptime-${id}`);
      if (cardEl) cardEl.textContent = uptime;
      if (currentServerId === id) {
        const detailEl = document.getElementById('detail-uptime');
        if (detailEl) detailEl.textContent = uptime;
      }
    }
  }, 1000);
}

// ─── Status Polling ───────────────────────────────────────────────────────────
function startStatusPolling() {
  if (statusPollInterval) clearInterval(statusPollInterval);
  statusPollInterval = setInterval(pollAllStatuses, 5000);
  pollAllStatuses();
}

async function pollAllStatuses() {
  const now = Date.now();
  for (const srv of config.servers) {
    if (statusFetchRetryAt[srv.id] && now < statusFetchRetryAt[srv.id]) continue;
    let running;
    try {
      running = await window.mcpanel.isServerRunning(srv.id);
      delete statusFetchRetryAt[srv.id];
    } catch (e) {
      // Back off this server for a minute instead of hammering a broken
      // CLI/fetch path every 5s — errors already get logged on the Rust side.
      statusFetchRetryAt[srv.id] = now + 60000;
      continue;
    }
    if (running) {
      const status = await window.mcpanel.pingServer('127.0.0.1', parseInt(srv.port));
      if (status && status.players != null) {
        if (!serverStartTimes[srv.id]) {
          const t = await window.mcpanel.getServerStartTime(srv.id);
          serverStartTimes[srv.id] = t || Date.now();
        }
        startingServers.delete(srv.id);
        serverPlayerData[srv.id] = { players: status.players || 0, maxPlayers: status.maxPlayers || 0, isVelocity: srv.software === 'velocity' };
        updateServerCardStatus(srv.id, true, status.players || 0);
        updateSidebarDot(srv.id, true);
        if (currentServerId === srv.id) {
          updateDetailOnline(true, status.players, status.maxPlayers, status.playerList || []);
        }
      } else {
        // Process is running but not accepting connections yet — STARTING
        updateServerCardStatus(srv.id, 'starting', 0);
        updateSidebarDot(srv.id, true);
        if (currentServerId === srv.id) updateDetailStarting();
      }
    } else {
      startingServers.delete(srv.id);
      delete serverPlayerData[srv.id];
      if (serverStartTimes[srv.id]) {
        delete serverStartTimes[srv.id];
        const uptimeEl = document.getElementById(`uptime-${srv.id}`);
        if (uptimeEl) uptimeEl.textContent = '-';
        if (currentServerId === srv.id) {
          const detailUptime = document.getElementById('detail-uptime');
          if (detailUptime) detailUptime.textContent = '-';
        }
      }
      updateServerCardStatus(srv.id, false, 0);
      updateSidebarDot(srv.id, false);
      if (currentServerId === srv.id) {
        updateDetailControls(false);
        setRamBar(0, srv.ram);
        setPlayersBar(0, 0, false);
        setCpuGauge(null, false);
        currentOnlinePlayers = [];
      }
    }
  }
  updateServersPageStats();
}

// ─── EULA Flow ────────────────────────────────────────────────────────────────
async function startServerFlow(id) {
  // Log polling reads incrementally from consoleLogOffset, but that offset
  // sits at 0 while a server is stopped — so on start, the very next poll
  // tick would pull the *entire* on-disk log (previous run included) into
  // the console. Skip straight to the current end of the log before
  // starting so only output from this run appears.
  if (_appSettings.clearConsoleOnStart && currentServerId === id) {
    stopConsolePoll();
    try {
      const tail = await window.mcpanel.getLogSince(id, 0);
      consoleLogOffset = tail.offset || 0;
    } catch {}
    clearConsole();
    startConsolePoll(id);
  }
  const result = await window.mcpanel.startServer(id);
  if (result.needsEula) {
    pendingEulaServerId = id;
    document.getElementById('modal-eula').classList.remove('hidden');
    return;
  }
  if (result.error) { toast(result.error, 'error'); return; }
  startingServers.add(id);
  updateServerCardStatus(id, 'starting', 0);
  updateSidebarDot(id, true);
  if (currentServerId === id) { updateDetailControls(true); updateDetailStarting(); }
  toast('Server starting...', 'info');
  pollAllStatuses();
}

async function confirmEula() {
  if (!pendingEulaServerId) return;
  const id = pendingEulaServerId;
  closeEulaModal();
  const r = await window.mcpanel.acceptEula(id);
  if (r.error) { toast(r.error, 'error'); return; }
  await startServerFlow(id);
}

function closeEulaModal() {
  document.getElementById('modal-eula').classList.add('hidden');
  pendingEulaServerId = null;
}

// ─── Privacy Policy Update Check ─────────────────────────────────────────────
async function checkPrivacyPolicy() {
  try {
    const res = await fetch('https://gist.githubusercontent.com/DippyCoder/559659736b49a56964dae2e5c0f5f5dc/raw');
    if (!res.ok) return;
    const text = await res.text();
    const match = text.match(/\*\*Document Last Updated:\*\*\s*(.+)/);
    if (!match) return;
    const remoteDate = match[1].trim();
    const localDate = localStorage.getItem('privacy_policy_date');
    if (localDate && localDate !== remoteDate) {
      document.getElementById('privacy-update-date').textContent = remoteDate;
      document.getElementById('modal-privacy-update').classList.remove('hidden');
    }
    localStorage.setItem('privacy_policy_date', remoteDate);
  } catch (_) {}
}

function closePrivacyUpdateModal() {
  document.getElementById('modal-privacy-update').classList.add('hidden');
}

function openPrivacyPolicy() {
  window.mcpanel.openExternal('https://get-mcpanel.vercel.app/privacy');
  closePrivacyUpdateModal();
}

function updateDetailStarting() {
  const bigStatus = document.getElementById('big-status-badge');
  if (bigStatus) { bigStatus.className = 'big-status starting'; bigStatus.textContent = 'STARTING'; }
  setPlayersBar(0, 0, false);
  const listEl = document.getElementById('detail-player-list');
  if (listEl) listEl.style.display = 'none';
}

// ─── Detail Tabs ─────────────────────────────────────────────────────────────

function switchDetailTab(name) {
  ['console', 'files', 'plugins', 'settings', 'backups', 'schedule', 'players'].forEach(t => {
    document.getElementById(`dtab-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-${t}`).classList.toggle('hidden', t !== name);
  });
  if (name === 'files') openFilesTab();
  if (name === 'settings') openSettingsTab();
  if (name === 'plugins') openServerPluginsTab();
  if (name === 'backups') openBackupsTab();
  if (name === 'schedule') openScheduleTab();
  if (name === 'players') openPlayersTab();
}

// ─── File Browser ─────────────────────────────────────────────────────────────

let fileNavStack = [];   // stack of children arrays
let fileNavPaths = [];   // stack of name strings for breadcrumb
let cachedFileTree = null;

// "New" toolbar button — a lightweight popover (not a real <select>/<dialog>)
// listing File/Folder. Click the button again, pick an option, or click
// anywhere else to close it.
let _openFileNewMenuId = null;

function toggleFileNewMenu(e, scope) {
  e.stopPropagation();
  const menuId = scope === 'profile' ? 'profile-file-new-menu' : 'file-new-menu';
  const wasOpen = menuId === _openFileNewMenuId;
  closeFileNewMenu();
  if (!wasOpen) {
    document.getElementById(menuId)?.classList.remove('hidden');
    _openFileNewMenuId = menuId;
  }
}

function closeFileNewMenu() {
  if (_openFileNewMenuId) {
    document.getElementById(_openFileNewMenuId)?.classList.add('hidden');
    _openFileNewMenuId = null;
  }
}

document.addEventListener('click', e => {
  if (_openFileNewMenuId && !e.target.closest('.file-new-wrap')) closeFileNewMenu();
});

function fileNewMenuPick(scope, kind) {
  closeFileNewMenu();
  if (scope === 'profile') {
    if (kind === 'file') createNewProfileFile(); else createNewProfileFolder();
  } else {
    if (kind === 'file') createNewFile(); else createNewFolder();
  }
}

async function openFilesTab() {
  if (!currentServerId) return;
  const listEl = document.getElementById('file-list');
  const savedPaths = [...fileNavPaths];
  if (!cachedFileTree) {
    listEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px">Loading…</div>`;
    const r = await window.mcpanel.getServerFileTree(currentServerId);
    if (r.error) {
      listEl.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">${escapeHtml(r.error)}</div>`;
      return;
    }
    cachedFileTree = r.tree || [];
  }
  fileNavStack = [cachedFileTree];
  fileNavPaths = [];
  for (const seg of savedPaths) {
    const dir = fileNavStack[fileNavStack.length - 1].find(n => n.type === 'dir' && n.name === seg);
    if (dir) { fileNavStack.push(dir.children || []); fileNavPaths.push(seg); }
    else break;
  }
  renderFileBrowser();
}

async function reloadFileTree() {
  cachedFileTree = null;
  await openFilesTab();
}

function renderFileBrowser() {
  const children = fileNavStack[fileNavStack.length - 1];
  const listEl = document.getElementById('file-list');
  const bcEl = document.getElementById('file-breadcrumb');

  // Breadcrumb — show server ID (folder name) not the display name
  const parts = [currentServerId, ...fileNavPaths];
  bcEl.innerHTML = parts.map((seg, i) => {
    const isCurrent = i === parts.length - 1;
    return (i > 0 ? `<span class="file-bc-sep">/</span>` : '') +
      `<span class="file-bc-seg${isCurrent ? ' current' : ''}" data-depth="${i}">${escapeHtml(seg)}</span>`;
  }).join('');
  bcEl.querySelectorAll('[data-depth]').forEach(el => {
    const depth = parseInt(el.dataset.depth);
    if (depth < parts.length - 1) {
      el.onclick = () => fileBrowserGoTo(depth);
    }
  });

  // File rows
  listEl.innerHTML = '';
  const sorted = [...children].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });

  for (const node of sorted) {
    const nodePath = [...fileNavPaths, node.name].join('/');
    const row = document.createElement('div');
    row.className = `file-row${node.type === 'dir' ? ' is-dir' : ''}${selectedFilePaths.has(nodePath) ? ' selected' : ''}`;
    row.innerHTML = `
      <input type="checkbox" class="file-row-check" ${selectedFilePaths.has(nodePath) ? 'checked' : ''}>
      <div class="file-row-icon">${fileIcon(node.name, node.type)}</div>
      <span class="file-row-name">${escapeHtml(node.name)}</span>
      <span class="file-row-size">${node.type === 'dir' ? '' : formatBytes(node.size || 0)}</span>
      <div class="file-row-actions">
        <button class="file-action-btn rename-btn" title="Rename">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="file-action-btn delete-btn" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`;

    row.querySelector('.file-row-check').addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) selectedFilePaths.add(nodePath);
      else selectedFilePaths.delete(nodePath);
      row.classList.toggle('selected', e.target.checked);
      _syncFileSelectAllCheckbox('file-select-all', children, fileNavPaths, selectedFilePaths);
      _syncFileSelActions('file-sel-actions', 'file-sel-count', selectedFilePaths);
    });
    row.querySelector('.file-row-check').addEventListener('click', e => e.stopPropagation());
    row.querySelector('.rename-btn').addEventListener('click', e => { e.stopPropagation(); renameFileEntry(nodePath, node.name); });
    row.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteFileEntry(nodePath, node.name, node.type === 'dir');
    });

    if (node.type === 'dir') {
      row.ondblclick = () => {
        fileNavStack.push(node.children || []);
        fileNavPaths.push(node.name);
        renderFileBrowser();
      };
      row.ondragover = e => { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = e => {
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('drop-target');
        _handleDrop(e, [...fileNavPaths, node.name].join('/'));
      };
    } else {
      row.ondblclick = () => openFileEditor(nodePath, node.name);
    }
    listEl.appendChild(row);
  }
  _syncFileSelectAllCheckbox('file-select-all', children, fileNavPaths, selectedFilePaths);
  _syncFileSelActions('file-sel-actions', 'file-sel-count', selectedFilePaths);
}

// Keeps a directory's "select all" checkbox in sync (checked/indeterminate/
// unchecked) with how many of its currently-listed children are selected.
function _syncFileSelectAllCheckbox(checkboxId, children, navPaths, selectedSet) {
  const el = document.getElementById(checkboxId);
  if (!el) return;
  const total = children.length;
  const selectedCount = children.filter(n => selectedSet.has([...navPaths, n.name].join('/'))).length;
  el.checked = total > 0 && selectedCount === total;
  el.indeterminate = selectedCount > 0 && selectedCount < total;
}

// Shows the toolbar's download / move / delete cluster only while something is
// checked. Selection spans directories, so the count is the whole set, not just
// what is visible in the current folder.
function _syncFileSelActions(wrapId, countId, selectedSet) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const n = selectedSet.size;
  wrap.classList.toggle('hidden', n === 0);
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = `${n} selected`;
}

function toggleSelectAllFiles(checked) {
  const children = fileNavStack[fileNavStack.length - 1] || [];
  for (const node of children) {
    const nodePath = [...fileNavPaths, node.name].join('/');
    if (checked) selectedFilePaths.add(nodePath);
    else selectedFilePaths.delete(nodePath);
  }
  renderFileBrowser();
}

function fileBrowserGoTo(depth) {
  while (fileNavStack.length > depth + 1) { fileNavStack.pop(); fileNavPaths.pop(); }
  renderFileBrowser();
}

// On Linux/WebKit2GTK, dataTransfer.files is empty and getData may also be empty
// because Tauri intercepts the drop. Parse whatever we can get.
function getDroppedPaths(e) {
  const uriList = e.dataTransfer.getData('text/uri-list');
  const text    = e.dataTransfer.getData('text/plain');
  console.log('[MCPanel] getDroppedPaths uri-list:', JSON.stringify(uriList), 'text:', JSON.stringify(text));
  const raw = uriList || text;
  if (!raw?.trim()) return [];
  return raw.split(/\r?\n/).map(u => u.trim()).filter(Boolean).map(u => {
    if (u.startsWith('file://')) { try { return decodeURIComponent(new URL(u).pathname); } catch { return null; } }
    if (u.startsWith('/')) return u;
    return null;
  }).filter(Boolean);
}

function _handleDrop(e, destDir) {
  const paths = getDroppedPaths(e);
  if (paths.length) uploadFilesFromPaths(paths, destDir);
  else uploadFiles(e.dataTransfer.files, destDir);
}

function filePanelDragOver(e) { e.preventDefault(); }
function filePanelDragLeave(e) { }
function filePanelDrop(e) {
  e.preventDefault();
  _handleDrop(e, fileNavPaths.join('/'));
}
function fileZoneDragOver(e) {
  e.preventDefault();
  document.getElementById('file-drop-zone').classList.add('drop-active');
}
function fileZoneDragLeave(e) {
  document.getElementById('file-drop-zone').classList.remove('drop-active');
}
function fileZoneDrop(e) {
  e.preventDefault();
  document.getElementById('file-drop-zone').classList.remove('drop-active');
  _handleDrop(e, fileNavPaths.join('/'));
}

function handleFileInputChange(e) {
  uploadFiles(e.target.files, fileNavPaths.join('/'));
  e.target.value = '';
}

async function uploadFiles(fileList, dirPath) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  const total = files.length;
  const progressEl = document.getElementById('file-upload-progress');
  const fillEl = document.getElementById('file-upload-progress-fill');
  const textEl = document.getElementById('file-upload-progress-text');
  const dropZone = document.getElementById('file-drop-zone');

  progressEl.classList.remove('hidden');
  dropZone.style.pointerEvents = 'none';

  let done = 0, errors = 0;
  for (const file of files) {
    fillEl.style.width = `${Math.round((done / total) * 100)}%`;
    textEl.textContent = `Uploading ${file.name} (${done + 1}/${total})`;
    try {
      const buf = await file.arrayBuffer();
      const data = Array.from(new Uint8Array(buf));
      const rel = dirPath ? `${dirPath}/${file.name}` : file.name;
      await window.mcpanel.writeServerFile(currentServerId, rel, data);
      done++;
    } catch (e) {
      errors++;
      textEl.textContent = `Failed: ${file.name}`;
      toast(`Failed to upload ${file.name}: ${e}`, 'error');
    }
  }

  fillEl.style.width = '100%';
  if (errors === 0) {
    textEl.textContent = `Done - ${done} file${done > 1 ? 's' : ''} uploaded`;
    toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`, 'success');
  } else {
    textEl.textContent = `${done} uploaded, ${errors} failed`;
  }
  if (done > 0) {
    window.mcpanel.logEvent(`Uploaded ${done} item(s) to server${dirPath ? ` (/${dirPath})` : ''} -id ${currentServerId}`);
  }

  dropZone.style.pointerEvents = '';
  setTimeout(() => {
    progressEl.classList.add('hidden');
    fillEl.style.width = '0%';
  }, 3000);

  if (done > 0) {
    cachedFileTree = null;
    await openFilesTab();
  }
}

async function uploadFilesFromPaths(paths, destDir) {
  if (!paths.length || !currentServerId) return;
  const progressEl = document.getElementById('file-upload-progress');
  const fillEl = document.getElementById('file-upload-progress-fill');
  const textEl = document.getElementById('file-upload-progress-text');
  progressEl.classList.remove('hidden');
  fillEl.style.width = '40%';
  textEl.textContent = `Copying ${paths.length} file${paths.length !== 1 ? 's' : ''}…`;
  try {
    await window.mcpanel.uploadFilesFromPaths(currentServerId, paths, destDir);
    fillEl.style.width = '100%';
    textEl.textContent = `Done - ${paths.length} file${paths.length !== 1 ? 's' : ''} uploaded`;
    toast(`Uploaded ${paths.length} file${paths.length !== 1 ? 's' : ''}`, 'success');
    cachedFileTree = null;
    await openFilesTab();
  } catch (e) {
    textEl.textContent = 'Upload failed';
    toast(`Upload failed: ${e}`, 'error');
  }
  setTimeout(() => { progressEl.classList.add('hidden'); fillEl.style.width = '0%'; }, 3000);
}

function fileIcon(name, type) {
  if (type === 'dir') {
    return `<svg class="file-icon-dir" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  }
  return `<svg class="file-icon-file" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

// ─── File Input Modal ─────────────────────────────────────────────────────────

let _fileInputCallback = null;

function openFileInput(title, label, defaultVal, cb) {
  _fileInputCallback = cb;
  document.getElementById('file-input-title').textContent = title;
  document.getElementById('file-input-label').textContent = label;
  const inp = document.getElementById('file-input-value');
  inp.value = defaultVal || '';
  openModal('modal-file-input');
  setTimeout(() => { inp.select(); inp.focus(); }, 50);
}

function submitFileInput() {
  const val = document.getElementById('file-input-value').value.trim();
  if (!val) return;
  closeModal('modal-file-input');
  if (_fileInputCallback) { _fileInputCallback(val); _fileInputCallback = null; }
}

// ─── File Editor ──────────────────────────────────────────────────────────────

let _editorRelPath = null;
let _editorCtx = null; // { type: 'server'|'profile', id: string }

let _aceEditor = null;

function _initAceEditor() {
  if (_aceEditor) return;
  _aceEditor = ace.edit('file-editor-content');
  _aceEditor.setOptions({
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    useWorker: false,
    wrap: false,
    scrollPastEnd: 0.3,
  });
  _aceEditor.renderer.setScrollMargin(4, 4, 0, 0);
  _aceEditor.on('change', _runEditorValidation);
}

function _aceTheme() {
  return (config.activeTheme === 'bright-slate')
    ? 'ace/theme/github'
    : 'ace/theme/tomorrow_night';
}

function _aceMode(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    yml: 'yaml', yaml: 'yaml',
    json: 'json',
    properties: 'properties',
    toml: 'toml',
    xml: 'xml', htm: 'xml', html: 'xml',
  };
  return `ace/mode/${map[ext] || 'text'}`;
}

function _runEditorValidation() {
  if (!_aceEditor) return;
  const modeId = _aceEditor.session.getMode().$id || '';
  const src = _aceEditor.getValue();
  const anns = [];

  if (modeId.endsWith('json') && src.trim()) {
    try { JSON.parse(src); }
    catch (e) {
      const m = e.message.match(/position (\d+)/i);
      if (m) {
        const pos = parseInt(m[1]);
        const before = src.slice(0, pos);
        const lines = before.split('\n');
        anns.push({ row: lines.length - 1, column: lines[lines.length - 1].length, text: e.message, type: 'error' });
      } else {
        anns.push({ row: 0, column: 0, text: e.message, type: 'error' });
      }
    }
  } else if (modeId.endsWith('yaml') && src.trim()) {
    try { jsyaml.load(src); }
    catch (e) {
      const row = (e.mark && e.mark.line != null) ? e.mark.line : 0;
      const col = (e.mark && e.mark.column != null) ? e.mark.column : 0;
      anns.push({ row, column: col, text: e.reason || e.message, type: 'error' });
    }
  }

  _aceEditor.session.setAnnotations(anns);
}

async function openFileEditor(relPath, name, ctx) {
  _editorRelPath = relPath;
  _editorCtx = ctx || { type: 'server', id: currentServerId };
  document.getElementById('file-editor-title').textContent = name;
  const saveBtn = document.getElementById('file-editor-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Loading…';
  openModal('modal-file-editor');
  _initAceEditor();
  _aceEditor.setTheme(_aceTheme());
  try {
    const content = _editorCtx.type === 'profile'
      ? await window.mcpanel.readProfileFile(_editorCtx.id, relPath)
      : await window.mcpanel.readServerFile(_editorCtx.id, relPath);
    _aceEditor.session.setMode(_aceMode(name));
    _aceEditor.setValue(content, -1);
    _runEditorValidation();
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
    setTimeout(() => _aceEditor && _aceEditor.resize(), 50);
  } catch (e) {
    closeModal('modal-file-editor');
    toast(String(e), 'error');
  }
}

async function saveFileEditor() {
  if (!_editorRelPath || !_editorCtx || !_aceEditor) return;
  const saveBtn = document.getElementById('file-editor-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  try {
    const content = _aceEditor.getValue();
    const data = Array.from(new TextEncoder().encode(content));
    if (_editorCtx.type === 'profile') {
      await window.mcpanel.writeProfileFile(_editorCtx.id, _editorRelPath, data);
      closeModal('modal-file-editor');
      toast('File saved', 'success');
      profileCachedFileTree = null;
      renderProfileFileBrowser();
    } else {
      await window.mcpanel.writeServerFile(_editorCtx.id, _editorRelPath, data);
      closeModal('modal-file-editor');
      toast('File saved', 'success');
      cachedFileTree = null;
      await openFilesTab();
    }
  } catch (e) {
    toast('Save failed: ' + e, 'error');
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
}

// ─── File Delete / Rename / Create ────────────────────────────────────────────

async function deleteFileEntry(relPath, name, isDir) {
  const ok = await confirmDialog({
    title: isDir ? 'Delete Folder' : 'Delete File',
    message: isDir
      ? `Delete the folder "${name}" and all its contents?\n\nThis action cannot be undone.`
      : `Delete the file "${name}"?\n\nThis action cannot be undone.`,
  });
  if (!ok) return;
  try {
    await window.mcpanel.deleteServerFile(currentServerId, relPath);
    toast(`Deleted "${name}"`, 'info');
    cachedFileTree = null;
    await openFilesTab();
  } catch (e) {
    toast('Delete failed: ' + e, 'error');
  }
}

async function deleteSelectedFiles() {
  const count = selectedFilePaths.size;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'Delete Items',
    message: `Delete ${count} selected item${count !== 1 ? 's' : ''}?\n\nFolders are deleted with all their contents. This action cannot be undone.`,
    confirmLabel: `Delete ${count} Item${count !== 1 ? 's' : ''}`,
  });
  if (!ok) return;
  const paths = [...selectedFilePaths];
  let failed = 0;
  for (const p of paths) {
    try { await window.mcpanel.deleteServerFile(currentServerId, p); }
    catch { failed++; }
  }
  selectedFilePaths.clear();
  if (failed === 0) toast(`Deleted ${paths.length} item${paths.length !== 1 ? 's' : ''}`, 'info');
  else toast(`Deleted ${paths.length - failed}, failed ${failed}`, 'error');
  cachedFileTree = null;
  await openFilesTab();
}

// ─── File Download / Move (selection actions) ─────────────────────────────────

async function downloadSelectedFiles() {
  await _downloadSelection('server');
}

async function downloadSelectedProfileFiles() {
  await _downloadSelection('profile');
}

async function _downloadSelection(scope) {
  const isProfile = scope === 'profile';
  const paths = [...(isProfile ? selectedProfileFilePaths : selectedFilePaths)];
  if (!paths.length) return;
  const dest = await window.mcpanel.browseFolder();
  if (!dest) return;
  const id = isProfile ? currentProfileId : currentServerId;
  try {
    if (isProfile) await window.mcpanel.exportProfileFiles(id, paths, dest);
    else await window.mcpanel.exportServerFiles(id, paths, dest);
    toast(`Downloaded ${paths.length} item${paths.length !== 1 ? 's' : ''} to ${dest}`, 'success');
  } catch (e) {
    toast('Download failed: ' + e, 'error');
  }
}

let _fileMoveCtx = null;              // { scope, paths, dest }  — dest is a rel path, '' = root
let _fileMoveExpanded = new Set();    // rel paths of expanded folders in the picker

function openFileMoveModal(scope) {
  const isProfile = scope === 'profile';
  const paths = [...(isProfile ? selectedProfileFilePaths : selectedFilePaths)];
  if (!paths.length) return;
  _fileMoveCtx = { scope, paths, dest: null };
  // Root is expanded, plus the chain down to where the items currently live so
  // the tree opens near them.
  _fileMoveExpanded = new Set(['', ..._ancestorPaths(paths[0])]);
  document.getElementById('file-move-title').textContent =
    `Move ${paths.length} Item${paths.length !== 1 ? 's' : ''}`;
  renderFileMoveTree();
  openModal('modal-file-move');
}

function _ancestorPaths(relPath) {
  const segs = relPath.split('/');
  segs.pop();
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

function _fileMoveParentOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

// A destination is unusable if it is one of the moved folders or lives inside
// one (you cannot move a folder into itself), or if every selected item is
// already sitting in it.
function _fileMoveDestBlocked(dest) {
  const { paths } = _fileMoveCtx;
  if (paths.some(p => dest === p || dest.startsWith(p + '/'))) return true;
  return paths.every(p => _fileMoveParentOf(p) === dest);
}

function renderFileMoveTree() {
  const { scope, dest } = _fileMoveCtx;
  const tree = scope === 'profile' ? (profileCachedFileTree || []) : (cachedFileTree || []);
  const rootName = scope === 'profile' ? currentProfileId : currentServerId;
  const el = document.getElementById('file-move-tree');
  el.innerHTML = '';

  const chevron = open => `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform:rotate(${open ? 90 : 0}deg);transition:transform .12s;color:var(--text-muted)"><polyline points="9 18 15 12 9 6"/></svg>`;
  const folderIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

  const addRow = (label, path, depth, hasChildren) => {
    const blocked = path !== null && _fileMoveDestBlocked(path);
    const row = document.createElement('div');
    row.className = `file-move-row${dest === path ? ' selected' : ''}${blocked ? ' disabled' : ''}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.innerHTML =
      `<span class="file-move-caret" style="width:12px;display:flex;justify-content:center">${hasChildren ? chevron(_fileMoveExpanded.has(path)) : ''}</span>` +
      folderIcon +
      `<span class="file-move-name">${escapeHtml(label)}</span>`;
    if (hasChildren) {
      row.querySelector('.file-move-caret').addEventListener('click', e => {
        e.stopPropagation();
        if (_fileMoveExpanded.has(path)) _fileMoveExpanded.delete(path);
        else _fileMoveExpanded.add(path);
        renderFileMoveTree();
      });
    }
    if (!blocked) {
      row.addEventListener('click', () => { _fileMoveCtx.dest = path; renderFileMoveTree(); });
    }
    el.appendChild(row);
  };

  const walk = (nodes, parentPath, depth) => {
    const dirs = nodes.filter(n => n.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
    for (const n of dirs) {
      const path = parentPath ? `${parentPath}/${n.name}` : n.name;
      const kids = (n.children || []).filter(c => c.type === 'dir');
      addRow(n.name, path, depth, kids.length > 0);
      if (_fileMoveExpanded.has(path)) walk(n.children || [], path, depth + 1);
    }
  };

  addRow(rootName, '', 0, tree.some(n => n.type === 'dir'));
  if (_fileMoveExpanded.has('')) walk(tree, '', 1);
}

async function submitFileMove() {
  if (!_fileMoveCtx) return;
  const { scope, paths, dest } = _fileMoveCtx;
  if (dest === null) { toast('Pick a destination folder', 'error'); return; }
  closeModal('modal-file-move');

  const isProfile = scope === 'profile';
  const id = isProfile ? currentProfileId : currentServerId;
  let moved = 0, skipped = 0, failed = 0, lastErr = '';
  for (const p of paths) {
    const name = p.split('/').pop();
    if (_fileMoveParentOf(p) === dest || dest === p || dest.startsWith(p + '/')) { skipped++; continue; }
    const newPath = dest ? `${dest}/${name}` : name;
    try {
      if (isProfile) await window.mcpanel.renameProfileFile(id, p, newPath);
      else await window.mcpanel.renameServerFile(id, p, newPath);
      moved++;
    } catch (e) { failed++; lastErr = String(e); }
  }

  const where = dest || (isProfile ? currentProfileId : currentServerId);
  if (failed) toast(`Moved ${moved}, failed ${failed}: ${lastErr}`, 'error');
  else if (moved) toast(`Moved ${moved} item${moved !== 1 ? 's' : ''} to ${where}`, 'success');
  else if (skipped) toast('Nothing to move — items are already there', 'info');

  _fileMoveCtx = null;
  if (isProfile) {
    selectedProfileFilePaths.clear();
    await reloadProfileFileTree();
  } else {
    selectedFilePaths.clear();
    cachedFileTree = null;
    await openFilesTab();
  }
}

function renameFileEntry(relPath, name) {
  openFileInput('Rename', 'New name', name, async (newName) => {
    if (newName === name) return;
    const parts = relPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    try {
      await window.mcpanel.renameServerFile(currentServerId, relPath, newPath);
      toast(`Renamed to "${newName}"`, 'success');
      cachedFileTree = null;
      await openFilesTab();
    } catch (e) {
      toast('Rename failed: ' + e, 'error');
    }
  });
}

function createNewFolder() {
  if (!currentServerId) return;
  openFileInput('New Folder', 'Folder name', '', async (name) => {
    const relPath = fileNavPaths.length ? fileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createServerDir(currentServerId, relPath);
      toast(`Folder "${name}" created`, 'success');
      cachedFileTree = null;
      await openFilesTab();
    } catch (e) {
      toast('Create failed: ' + e, 'error');
    }
  });
}

function createNewFile() {
  if (!currentServerId) return;
  openFileInput('New File', 'File name', '', async (name) => {
    const relPath = fileNavPaths.length ? fileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createServerFile(currentServerId, relPath);
      toast(`File "${name}" created`, 'success');
      cachedFileTree = null;
      await openFilesTab();
    } catch (e) {
      toast('Create failed: ' + e, 'error');
    }
  });
}

// ─── Inline Settings Tab ──────────────────────────────────────────────────────

const PAPER_SOFTWARES = new Set(['paper', 'purpur', 'folia', 'leaf']);

function openSettingsTab() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('tsett-name').value = srv.name || '';
  setRamDropdown('tsett', srv.ram || '2G');
  document.getElementById('tsett-storage').value = srv.storageLimit || '';
  document.getElementById('tsett-port').value = srv.port || '';
  document.getElementById('tsett-group').value = srv.group || '';
  document.getElementById('tsett-java-args').value = srv.javaArgs || '';
  populateJdkSelect('tsett', 'tsett-java-path', srv.javaPath || 'java');
  const proxyBtnRow = document.getElementById('tsett-proxy-btn-row');
  if (proxyBtnRow) proxyBtnRow.classList.toggle('hidden', !PAPER_SOFTWARES.has(srv.software));
}

async function saveTabSettings() {
  const name = document.getElementById('tsett-name').value.trim();
  if (!name) { toast('Server name is required', 'error'); return; }
  const ram = getRamValue('tsett');
  if (!ram) { toast('Please enter a custom RAM value', 'error'); return; }
  const storageLimit = document.getElementById('tsett-storage').value.trim() || null;
  const port = parseInt(document.getElementById('tsett-port').value) || null;
  const group = document.getElementById('tsett-group').value.trim() || null;
  const javaArgs = document.getElementById('tsett-java-args').value.trim();
  const javaPath = document.getElementById('tsett-java-path').value.trim() || 'java';

  if (storageLimit) {
    const bytes = parseStorageLimit(storageLimit);
    if (bytes === null) { toast('Invalid storage limit format', 'error'); return; }
  }
  const deviceErr = validateRamAndStorage(ram, storageLimit);
  if (deviceErr) { toast(deviceErr, 'error'); return; }

  const updates = { name, ram, storageLimit, port, group, javaArgs, javaPath };
  const r = await window.mcpanel.updateServer(currentServerId, updates);
  if (r && r.error) { toast(r.error, 'error'); return; }

  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) config.servers[idx] = { ...config.servers[idx], ...updates };
  const srv = config.servers[idx];

  document.getElementById('detail-server-name').textContent = name;
  document.getElementById('detail-server-subtitle').textContent = `${srv.version} · ${capitalise(srv.software)} · Port ${srv.port}`;
  if (port) document.getElementById('detail-port').textContent = port;
  const nameEl = document.querySelector(`#card-${currentServerId} .server-card-name`);
  if (nameEl) nameEl.textContent = name;
  const sidebarName = document.querySelector(`[data-server-id="${currentServerId}"] .srv-name`);
  if (sidebarName) sidebarName.textContent = name;
  renderSidebarServers();
  refreshDetailStats(currentServerId);

  toast('Settings saved', 'success');
  switchDetailTab('console');
}

async function browseJavaTabSettings() {
  const path = await window.mcpanel.browseJava();
  if (path) setJdkDropdown('tsett', 'tsett-java-path', path);
}

// ─── Plugin / Mod Browser ─────────────────────────────────────────────────────

const MODDED_SOFTWARES = new Set(['fabric']);
const PLUGIN_SOFTWARES = new Set(['paper', 'purpur', 'folia', 'leaf', 'spigot', 'velocity']);

let _serverPluginProvider = 'hangar';
let _profilePluginProvider = 'hangar';
let _pluginSearchTimer = null;
let _pluginInstalledMap = {}; // key: `server_${id}` or `profile_${id}` → { slug: relPath }
let _pluginPageState = {};   // key: ctx → { provider, query, offset, software, mcVersion }
let _pluginDetailCache = {}; // key: ctx → { slug: <raw search result row> }
let _pluginDetailState = null; // { ctx, slug, row, offset } for the currently-open details modal

function _pluginCtxKey(ctx) {
  return ctx === 'server' ? `server_${currentServerId}` : `profile_${currentProfileId}`;
}
function _isPluginInstalled(ctx, slug) {
  return !!(_pluginInstalledMap[_pluginCtxKey(ctx)]?.[slug]);
}
function _markPluginInstalled(ctx, slug, relPath) {
  const k = _pluginCtxKey(ctx);
  if (!_pluginInstalledMap[k]) _pluginInstalledMap[k] = {};
  _pluginInstalledMap[k][slug] = relPath;
}
function _markPluginUninstalled(ctx, slug) {
  const k = _pluginCtxKey(ctx);
  if (_pluginInstalledMap[k]) delete _pluginInstalledMap[k][slug];
}

function _pluginTabLabel(software) {
  return MODDED_SOFTWARES.has(software) ? 'Mods' : 'Plugins';
}

function _pluginDestDir(software) {
  return MODDED_SOFTWARES.has(software) ? 'mods' : 'plugins';
}

function openServerPluginsTab() {
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  const label = _pluginTabLabel(srv.software);
  document.getElementById('dtab-plugins-label').textContent = label;
  _setupPluginProviders(srv.software, 'server');
  const listEl = document.getElementById('server-plugin-list');
  if (listEl.querySelector('.plugin-state-msg')) return;
}

function openProfilePluginsTab() {
  const profile = profiles.find(p => p.id === currentProfileId);
  const software = (profile && profile.software && profile.software.length === 1)
    ? profile.software[0] : 'paper';
  const label = _pluginTabLabel(software);
  document.getElementById('ptab-plugins-label').textContent = label;
  _setupPluginProviders(software, 'profile');
}

function _setupPluginProviders(software, ctx) {
  const isMod = MODDED_SOFTWARES.has(software);
  const hangarBtn = document.getElementById(`${ctx === 'server' ? 's' : 'p'}provider-hangar`);
  const spigotBtn = document.getElementById(`${ctx === 'server' ? 's' : 'p'}provider-spigotmc`);
  if (hangarBtn) hangarBtn.classList.toggle('hidden', isMod);
  if (spigotBtn) spigotBtn.classList.toggle('hidden', isMod);
  const defaultProvider = isMod ? 'modrinth' : 'hangar';
  if (ctx === 'server') _serverPluginProvider = defaultProvider;
  else _profilePluginProvider = defaultProvider;
  document.querySelectorAll(`#${ctx === 'server' ? 'server' : 'profile'}-plugin-providers .plugin-provider-tab`)
    .forEach(btn => btn.classList.toggle('active', btn.id.endsWith(defaultProvider)));
}

function switchPluginProvider(provider, ctx) {
  if (ctx === 'server') _serverPluginProvider = provider;
  else _profilePluginProvider = provider;
  document.querySelectorAll(`#${ctx === 'server' ? 'server' : 'profile'}-plugin-providers .plugin-provider-tab`)
    .forEach(btn => btn.classList.toggle('active', btn.id.endsWith(provider)));
  searchPlugins(ctx);
}

function pluginSearchDebounce(ctx) {
  clearTimeout(_pluginSearchTimer);
  _pluginSearchTimer = setTimeout(() => searchPlugins(ctx), 400);
}

async function searchPlugins(ctx, append = false) {
  const query = (document.getElementById(`${ctx}-plugin-search`)?.value || '').trim();
  const provider = ctx === 'server' ? _serverPluginProvider : _profilePluginProvider;
  const listEl = document.getElementById(`${ctx}-plugin-list`);
  if (!listEl) return;

  const srv = ctx === 'server' ? config.servers.find(s => s.id === currentServerId) : null;
  const profile = ctx === 'profile' ? profiles.find(p => p.id === currentProfileId) : null;
  const software = srv?.software || (profile?.software?.[0]) || 'paper';
  const mcVersion = srv?.version || (profile?.versions?.[0]) || '';

  const PAGE_SIZE = 100;

  if (!append) {
    listEl.innerHTML = `<div class="plugin-state-msg">Searching…</div>`;
    _pluginPageState[ctx] = { provider, query, software, mcVersion, offset: 0 };
    _pluginDetailCache[ctx] = {};
  } else {
    listEl.querySelector('.plugin-load-more')?.remove();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'plugin-state-msg plugin-loading-more';
    loadingEl.textContent = 'Loading…';
    listEl.appendChild(loadingEl);
  }

  const state = _pluginPageState[ctx];
  const requestOffset = append ? state.offset : 0;

  try {
    const { results, hasMore } = await _searchViaCli(state.provider, state.query,
      { software: state.software, mcVersion: state.mcVersion }, PAGE_SIZE, requestOffset);
    state.offset = requestOffset + results.length;
    results.forEach(r => { _pluginDetailCache[ctx][r.slug] = r; });

    if (!append) {
      if (!results.length) {
        listEl.innerHTML = `<div class="plugin-state-msg">No results for "${escapeHtml(state.query || 'featured')}".</div>`;
        return;
      }
      listEl.innerHTML = results.map(r => _renderPluginRow(r, ctx, state.software)).join('');
    } else {
      listEl.querySelector('.plugin-loading-more')?.remove();
      results.forEach(r => listEl.insertAdjacentHTML('beforeend', _renderPluginRow(r, ctx, state.software)));
    }

    if (hasMore) {
      const loadMoreDiv = document.createElement('div');
      loadMoreDiv.className = 'plugin-load-more';
      loadMoreDiv.innerHTML = `<button class="btn-ghost-sm" onclick="_loadMorePlugins('${ctx}')">Load 100 more…</button>`;
      listEl.appendChild(loadMoreDiv);
    }
  } catch (e) {
    if (!append) {
      listEl.innerHTML = `<div class="plugin-state-msg" style="color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
    } else {
      listEl.querySelector('.plugin-loading-more')?.remove();
      toast('Failed to load more: ' + e.message, 'error');
    }
  }
}

function _loadMorePlugins(ctx) { searchPlugins(ctx, true); }

function _fmtDownloads(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function _fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch { return ''; }
}

function _renderPluginRow(r, ctx, software) {
  const isInstalled = _isPluginInstalled(ctx, r.slug);
  const btnId = `pibtn-${ctx}-${r.slug.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const icon = r.iconUrl
    ? `<img class="plugin-icon" src="${escapeHtml(r.iconUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="plugin-icon-placeholder" style="display:none"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`
    : `<div class="plugin-icon-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`;
  // Spiget resources hosted externally usually redirect to a human-facing
  // release page rather than a jar — those can't be auto-installed. A few
  // do link straight to a .jar file (e.g. a GitHub release asset) and are
  // still safe to install directly, matching the same check the CLI backend
  // makes in plugins.get_spiget_download. Purchase-required (premium) Spiget
  // resources never reach here at all — the CLI filters them out of results.
  const isBlockedExternal = !!r.external &&
    !(r.externalUrl && r.externalUrl.toLowerCase().split('?')[0].endsWith('.jar'));
  const externalBadge = isBlockedExternal ? `<span class="plugin-external-badge">EXTERNAL</span>` : '';
  const dataAttrs = `data-slug="${escapeHtml(r.slug)}" data-platform="${escapeHtml(r.platform)}" data-name="${escapeHtml(r.name)}" data-author="${escapeHtml(r.author)}" data-owner="${escapeHtml(r.ownerName || '')}" data-ctx="${ctx}" data-software="${escapeHtml(software)}" data-external-url="${escapeHtml(r.externalUrl || '')}"`;
  let btnClass, btnText, btnOnclick;
  if (isBlockedExternal) {
    btnClass = 'plugin-install-btn'; btnText = 'View Page';
    btnOnclick = r.externalUrl
      ? `onclick="event.stopPropagation();window.mcpanel.openExternal('${escapeHtml(r.externalUrl)}')"`
      : `onclick="event.stopPropagation();toast('This plugin is hosted externally - check its SpigotMC resource page','info')"`;
  } else if (isInstalled) {
    btnClass = 'plugin-install-btn installed'; btnText = 'Installed';
    btnOnclick = `onclick="event.stopPropagation();_pluginBtnClick(this)" title="Click to remove"`;
  } else {
    btnClass = 'plugin-install-btn'; btnText = 'Install';
    btnOnclick = `onclick="event.stopPropagation();_pluginBtnClick(this)"`;
  }
  return `<div class="plugin-row clickable" onclick="_openPluginDetails('${ctx}','${escapeHtml(r.slug)}')">
    ${icon}
    <div class="plugin-info">
      <div class="plugin-name">${escapeHtml(r.name)}${externalBadge}</div>
      <div class="plugin-author">by ${escapeHtml(r.author)}</div>
      ${r.description ? `<div class="plugin-desc">${escapeHtml(r.description)}</div>` : ''}
    </div>
    <div class="plugin-meta">
      <span class="plugin-meta-downloads">⬇ ${_fmtDownloads(r.downloads)}</span>
      ${r.latestVersion ? `<span class="plugin-meta-version">${escapeHtml(r.latestVersion)}</span>` : ''}
      ${r.updatedAt ? `<span class="plugin-meta-updated">${_fmtDate(r.updatedAt)}</span>` : ''}
    </div>
    <button class="${btnClass}" id="${btnId}" ${btnOnclick} ${dataAttrs}>${btnText}</button>
  </div>`;
}

function _pluginBtnClick(btn) {
  const ctx = btn.dataset.ctx;
  const software = btn.dataset.software;
  if (_isPluginInstalled(ctx, btn.dataset.slug)) {
    removePlugin(btn, ctx);
  } else {
    installPlugin({
      slug: btn.dataset.slug, platform: btn.dataset.platform,
      name: btn.dataset.name, author: btn.dataset.author,
      ownerName: btn.dataset.owner,
      externalUrl: btn.dataset.externalUrl || null,
    }, ctx, software);
  }
}

// ─── Plugin / Mod Details Modal ───────────────────────────────────────────────

function _openPluginDetails(ctx, slug) {
  const row = _pluginDetailCache[ctx]?.[slug];
  if (!row) return;

  document.getElementById('pdetail-name').textContent = row.name;
  document.getElementById('pdetail-author').textContent = row.author;
  document.getElementById('pdetail-desc').textContent = row.description || '';
  document.getElementById('pdetail-longdesc').textContent = 'Loading…';
  document.getElementById('pdetail-icon-wrap').innerHTML = row.iconUrl
    ? `<img class="plugin-detail-icon" src="${escapeHtml(row.iconUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="plugin-detail-icon-placeholder" style="display:none"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`
    : `<div class="plugin-detail-icon-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`;
  document.getElementById('pdetail-versions').innerHTML = `<div class="plugin-state-msg">Loading…</div>`;

  const websiteBtn = document.getElementById('pdetail-website-btn');
  websiteBtn.onclick = null;
  websiteBtn.disabled = true;

  const srv = ctx === 'server' ? config.servers.find(s => s.id === currentServerId) : null;
  const software = srv?.software || row.software || 'paper';
  const isInstalled = _isPluginInstalled(ctx, slug);
  const installBtn = document.getElementById('pdetail-install-btn');
  installBtn.dataset.slug = slug;
  installBtn.textContent = isInstalled ? 'Installed' : 'Install';
  installBtn.disabled = false;
  installBtn.className = isInstalled ? 'plugin-install-btn installed' : 'plugin-install-btn';
  installBtn.onclick = () => _installFromDetailModal(installBtn, row, ctx, software);

  _pluginDetailState = { ctx, slug, row, software, offset: 0 };
  openModal('modal-plugin-details');
  _loadPluginInfo(false);
}

async function _loadPluginInfo(append = false) {
  const state = _pluginDetailState;
  if (!state) return;
  const versionsEl = document.getElementById('pdetail-versions');
  const LIMIT = 25;

  if (append) {
    versionsEl.querySelector('.plugin-detail-loadmore')?.remove();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'plugin-state-msg plugin-loading-more';
    loadingEl.textContent = 'Loading…';
    versionsEl.appendChild(loadingEl);
  }

  try {
    const data = await window.mcpanel.pluginInfo(state.row.platform, state.slug, {
      owner: state.row.ownerName, limit: LIMIT, offset: state.offset,
    });
    if (data.error) throw new Error(data.error);
    if (_pluginDetailState !== state) return; // modal closed/switched while awaiting

    const websiteBtn = document.getElementById('pdetail-website-btn');
    if (data.websiteUrl) {
      websiteBtn.disabled = false;
      websiteBtn.onclick = () => window.mcpanel.openExternal(data.websiteUrl);
    }

    if (!append) {
      document.getElementById('pdetail-longdesc').textContent =
        data.longDescription || state.row.description || 'No description available.';
    }

    const versions = data.versions || [];
    if (!append) {
      if (!versions.length) {
        versionsEl.innerHTML = `<div class="plugin-state-msg">No version history available.</div>`;
        return;
      }
      versionsEl.innerHTML = versions.map(v => _renderVersionRow(v, state)).join('');
    } else {
      versionsEl.querySelector('.plugin-loading-more')?.remove();
      versions.forEach(v => versionsEl.insertAdjacentHTML('beforeend', _renderVersionRow(v, state)));
    }
    state.offset += versions.length;

    if (data.hasMoreVersions) {
      const loadMoreDiv = document.createElement('div');
      loadMoreDiv.className = 'plugin-detail-loadmore';
      loadMoreDiv.innerHTML = `<button class="btn-ghost-sm" onclick="_loadPluginInfo(true)">Load more…</button>`;
      versionsEl.appendChild(loadMoreDiv);
    }
  } catch (e) {
    if (_pluginDetailState !== state) return;
    if (!append) {
      document.getElementById('pdetail-longdesc').textContent = state.row.description || '';
      versionsEl.innerHTML = `<div class="plugin-state-msg" style="color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
    } else {
      versionsEl.querySelector('.plugin-loading-more')?.remove();
      toast('Failed to load more versions: ' + e.message, 'error');
    }
  }
}

function _renderVersionRow(v, state) {
  const rowId = `pvrow-${state.ctx}-${String(v.id).replace(/[^a-zA-Z0-9]/g, '_')}`;
  const title = v.changelog ? ` title="${escapeHtml(v.changelog)}"` : '';
  return `<div class="plugin-version-row" id="${rowId}"${title} onclick="_installPluginVersion(this, '${escapeHtml(String(v.id))}')">
    <div class="plugin-version-name">${escapeHtml(v.name || '?')}</div>
    ${v.date ? `<div class="plugin-version-date">${_fmtDate(v.date)}</div>` : ''}
  </div>`;
}

function _installPluginVersion(row, versionId) {
  const state = _pluginDetailState;
  if (!state || row.classList.contains('installing')) return;
  const originalName = row.querySelector('.plugin-version-name').textContent;
  row.classList.add('installing');
  row.querySelector('.plugin-version-name').textContent = 'Installing…';
  // Pass the top-level Install button as an override so it also reflects the
  // (just-changed) installed state, matching what installing from the row's
  // own button already does.
  const installBtn = _pluginDetailState === state ? document.getElementById('pdetail-install-btn') : null;
  installPlugin(state.row, state.ctx, state.software, versionId, installBtn).finally(() => {
    if (row.isConnected) {
      row.classList.remove('installing');
      row.querySelector('.plugin-version-name').textContent = originalName;
    }
  });
}

function _installFromDetailModal(btn, row, ctx, software) {
  if (_isPluginInstalled(ctx, row.slug)) {
    removePlugin(btn, ctx).then(() => {
      // Keep the row behind the modal (if still rendered) in sync too.
      const rowBtn = document.getElementById(`pibtn-${ctx}-${row.slug.replace(/[^a-zA-Z0-9]/g, '_')}`);
      if (rowBtn && !_isPluginInstalled(ctx, row.slug)) {
        rowBtn.textContent = 'Install'; rowBtn.disabled = false; rowBtn.className = 'plugin-install-btn';
      }
    });
  } else {
    installPlugin(row, ctx, software, undefined, btn);
  }
}

// Search is routed through mcpanel-cli's own `search plugins` API instead of
// fetch()ing each platform directly — that avoids browser CORS entirely.
async function _searchViaCli(platform, query, { software, mcVersion } = {}, limit = 100, offset = 0) {
  const data = await window.mcpanel.searchPlugins(platform, query, { software, mcVersion, limit, offset });
  if (data.error) throw new Error(data.error);
  return { results: data.results || [], hasMore: !!data.hasMore };
}

async function installPlugin(pluginData, ctx, software, versionId, btnOverride) {
  const serverId = ctx === 'server' ? currentServerId : null;
  const profileId = ctx === 'profile' ? currentProfileId : null;
  if (!serverId && !profileId) return;

  const btnId = `pibtn-${ctx}-${pluginData.slug.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const rowBtn = document.getElementById(btnId);
  const btns = [...new Set([rowBtn, btnOverride].filter(Boolean))];
  const setBtns = (text, disabled, cls) => btns.forEach(b => {
    b.textContent = text; b.disabled = disabled; b.className = cls;
  });
  setBtns('Installing', true, 'plugin-install-btn installing');

  const srv = serverId ? config.servers.find(s => s.id === serverId) : null;
  const effectiveSoftware = software || srv?.software || 'paper';
  const mcVersion = srv?.version || '';
  const destDir = _pluginDestDir(effectiveSoftware);

  // If a different version of this plugin is already installed, its filename
  // (e.g. embeds a version number) usually differs from the one we're about
  // to write — remove it first so switching versions doesn't leave the old
  // jar sitting alongside the new one (both would get loaded by the server).
  const existingRelPath = _pluginInstalledMap[_pluginCtxKey(ctx)]?.[pluginData.slug];
  if (existingRelPath) {
    try {
      if (serverId) await window.mcpanel.deleteServerFile(serverId, existingRelPath);
      else await window.mcpanel.deleteProfileFile(profileId, existingRelPath);
    } catch { /* best-effort — proceed with install regardless */ }
  }

  toast(`Installing ${pluginData.name}…`, 'info');
  try {
    // mcpanel-cli's `install plugin` resolves the download (including Hangar's
    // owner lookup and Spiget's external/non-jar checks) and writes the file
    // itself — no separate URL-resolution step needed here.
    const result = await window.mcpanel.installPlugin(pluginData.platform, pluginData.slug, {
      serverId, profileId, mcVersion,
      owner: pluginData.ownerName || pluginData.author,
      versionId,
    });
    if (result?.error) {
      toast('Install failed: ' + result.error, 'error');
      if (existingRelPath) _markPluginUninstalled(ctx, pluginData.slug); // old file was already removed above
      setBtns('Install', false, 'plugin-install-btn');
    } else {
      const relPath = `${destDir}/${result.filename}`;
      toast(`Installed ${pluginData.name} → ${relPath}`, 'success');
      _markPluginInstalled(ctx, pluginData.slug, relPath);
      setBtns('Installed', false, 'plugin-install-btn installed');
    }
  } catch (e) {
    toast('Install failed: ' + e.message, 'error');
    if (existingRelPath) _markPluginUninstalled(ctx, pluginData.slug);
    setBtns('Install', false, 'plugin-install-btn');
  }
}

async function removePlugin(btn, ctx) {
  const slug = btn.dataset.slug;
  const k = _pluginCtxKey(ctx);
  const relPath = _pluginInstalledMap[k]?.[slug];
  if (!relPath) return;
  const ok = await confirmDialog({
    title: 'Remove Plugin',
    message: `Remove "${btn.dataset.name || slug}"?\n\nThis deletes ${relPath} from disk and cannot be undone.`,
    confirmLabel: 'Remove Plugin',
  });
  if (!ok) return;
  btn.textContent = 'Removing…';
  btn.disabled = true;
  try {
    if (ctx === 'server') {
      await window.mcpanel.deleteServerFile(currentServerId, relPath);
    } else {
      await window.mcpanel.deleteProfileFile(currentProfileId, relPath);
    }
    _markPluginUninstalled(ctx, slug);
    toast('Plugin removed', 'info');
    btn.textContent = 'Install';
    btn.disabled = false;
    btn.className = 'plugin-install-btn';
  } catch (e) {
    toast('Remove failed: ' + e, 'error');
    btn.textContent = 'Installed';
    btn.disabled = false;
  }
}

// ─── Velocity Proxy Link ─────────────────────────────────────────────────────

async function openVelocityLinkModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  await loadProxySection(srv);
  openModal('modal-velocity-link');
}

async function loadProxySection(srv) {
  const velocityServers = config.servers.filter(s => s.software === 'velocity');
  const sel = document.getElementById('tsett-proxy-velocity');
  if (velocityServers.length === 0) {
    sel.innerHTML = '<option value="">No Velocity servers found</option>';
  } else {
    sel.innerHTML = velocityServers
      .map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`)
      .join('');
  }

  const safeName = (srv.name || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
  document.getElementById('tsett-proxy-name').value = safeName;
  document.getElementById('tsett-proxy-custom-ip-toggle').checked = false;
  document.getElementById('tsett-proxy-custom-ip-wrap').classList.add('hidden');
  document.getElementById('tsett-proxy-custom-ip').value = '';

  if (velocityServers.length > 0) await updateProxyPrioritySlider(velocityServers[0].id);
}

async function onProxyVelocityChange() {
  const id = document.getElementById('tsett-proxy-velocity').value;
  if (id) await updateProxyPrioritySlider(id);
}

async function updateProxyPrioritySlider(velocityId) {
  try {
    const info = await window.mcpanel.proxyInfo(velocityId);
    const tryList = (info && info.tryList) ? info.tryList : [];
    const slider = document.getElementById('tsett-proxy-priority');
    const valEl = document.getElementById('tsett-proxy-priority-val');
    const labelsEl = document.getElementById('tsett-proxy-priority-labels');
    slider.max = tryList.length;
    slider.value = tryList.length;
    valEl.textContent = tryList.length;
    labelsEl.innerHTML = tryList.length > 0
      ? tryList.map((n, i) => `<span>${i}: ${escapeHtml(n)}</span>`).join('') + `<span>${tryList.length}: (end)</span>`
      : '<span style="opacity:0.55">Try list is empty - this will be the first server</span>';
  } catch { /* ignore */ }
}

async function linkToVelocityProxy(btn) {
  const velocityId = document.getElementById('tsett-proxy-velocity').value;
  const serverName = document.getElementById('tsett-proxy-name').value.trim();
  const priority = parseInt(document.getElementById('tsett-proxy-priority').value) || 0;
  const useCustomIp = document.getElementById('tsett-proxy-custom-ip-toggle').checked;
  const customIp = useCustomIp ? document.getElementById('tsett-proxy-custom-ip').value.trim() : null;

  if (!velocityId) { toast('Please select a Velocity proxy server', 'error'); return; }
  if (!serverName) { toast('Please enter a server name', 'error'); return; }

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Linking…';

  try {
    const result = await window.mcpanel.linkToProxy(currentServerId, velocityId, serverName, priority, customIp);
    if (result && result.error) {
      toast('Link failed: ' + result.error, 'error');
    } else {
      toast('Server linked to Velocity proxy!', 'success');
      closeModal('modal-velocity-link');
    }
  } catch (e) {
    toast('Link failed: ' + e, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ─── Quick Controls ───────────────────────────────────────────────────────────
async function quickStart(id, e) {
  e.stopPropagation();
  await startServerFlow(id);
}

async function quickStop(id, e) {
  e.stopPropagation();
  await window.mcpanel.stopServer(id);
  toast('Stop command sent', 'info');
}

async function sidebarQuickToggle(id, e) {
  e.stopPropagation();
  const running = await window.mcpanel.isServerRunning(id);
  if (running) {
    await window.mcpanel.stopServer(id);
    toast('Stop command sent', 'info');
  } else {
    await startServerFlow(id);
  }
}

// ─── Detail Controls ──────────────────────────────────────────────────────────
function updateDetailControls(running) {
  const actionsEl = document.getElementById('detail-actions');
  const statusDot = document.getElementById('console-status-dot');
  const bigStatus = document.getElementById('big-status-badge');

  statusDot.className = `status-dot ${running ? 'online' : ''}`;
  bigStatus.className = `big-status ${running ? 'online' : ''}`;
  bigStatus.textContent = running ? 'ONLINE' : 'OFFLINE';

  actionsEl.innerHTML = '';

  // Start / Stop / Restart / Kill all live in the detail header.
  const controls = !running ? [
    { label: 'Start', cls: 'start', icon: `<polygon points="5 3 19 12 5 21 5 3"/>`, fill: true, action: () => startServerFlow(currentServerId) },
  ] : [
    { label: 'Stop', cls: 'stop', icon: `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`, fill: true, action: async () => {
      await window.mcpanel.stopServer(currentServerId);
      toast('Stop command sent', 'info');
    }},
    { label: 'Restart', cls: 'restart', icon: `<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>`, action: async () => {
      toast('Restarting server...', 'info');
      const r = await window.mcpanel.restartServer(currentServerId);
      if (r && r.error) toast(r.error, 'error');
      else if (r && r.success) {
        startingServers.add(currentServerId);
        updateDetailControls(true);
        updateDetailStarting();
        updateServerCardStatus(currentServerId, 'starting', 0);
        updateSidebarDot(currentServerId, true);
        pollAllStatuses();
      }
    }},
    { label: 'Kill', cls: 'kill', icon: `<path d="M18 6L6 18M6 6l12 12"/>`, action: async () => { await window.mcpanel.killServer(currentServerId); updateDetailControls(false); toast('Server killed', 'error'); } },
  ];

  controls.forEach(({ label, cls, icon, fill, action }) => {
    const btn = document.createElement('button');
    btn.className = `btn-control ${cls}`;
    const svg = fill
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">${icon}</svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>`;
    btn.innerHTML = `${svg}${label}`;
    btn.onclick = () => action();
    actionsEl.appendChild(btn);
  });
}

// Mini donut gauges in the detail status bar. Circumference = 2π × 26.
const DETAIL_CIRC = 163.363;
function setMiniCircle(arcId, pct, colorClass) {
  const arc = document.getElementById(arcId);
  if (!arc) return;
  const p = Math.min(Math.max(pct, 0), 100);
  arc.style.strokeDashoffset = DETAIL_CIRC * (1 - p / 100);
  arc.className = 'mini-circle-arc' + (colorClass ? ' ' + colorClass : '');
}

// Show one decimal when a value rounds to 0% (e.g. a nearly-idle CPU) so it
// doesn't flatten to a bare "0%".
function fmtPct(p) {
  return Math.round(p) === 0 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

function setPlayersBar(current, max, online) {
  const textEl = document.getElementById('detail-players');
  if (!textEl) return;
  if (!online) {
    setMiniCircle('detail-players-arc', 0);
    textEl.textContent = '0/0';
    return;
  }
  const pct = max > 0 ? (current / max) * 100 : 0;
  setMiniCircle('detail-players-arc', pct, 'arc-green');
  textEl.textContent = `${current}/${max}`;
}

function setCpuGauge(pct, online) {
  const valEl = document.getElementById('detail-cpu');
  const subEl = document.getElementById('detail-cpu-sub');
  if (!valEl) return;
  // Offline (or no reading) still reads 0.0% rather than a bare dash.
  const p = (online && pct != null) ? Math.min(100, Math.max(0, pct)) : 0;
  setMiniCircle('detail-cpu-arc', p, p > 85 ? 'arc-danger' : p > 65 ? 'arc-warn' : '');
  valEl.textContent = fmtPct(p);
  if (subEl) {
    const model = stripCpuName(systemCpu.name) || systemCpu.name;
    subEl.textContent = model || '-';
    subEl.title = systemCpu.name || '';
  }
}

function formatCap(capStr) {
  const bytes = parseStorageLimit(capStr);
  return bytes !== null ? formatBytes(bytes) : (capStr || '-');
}

function setRamBar(usedBytes, capStr) {
  const valEl = document.getElementById('detail-ram');
  const subEl = document.getElementById('detail-ram-sub');
  if (!valEl) return;
  const capBytes = parseStorageLimit(capStr);
  const used = usedBytes || 0;
  if (capBytes !== null && capBytes > 0) {
    const pct = Math.min(100, (used / capBytes) * 100);
    setMiniCircle('detail-ram-arc', pct, pct > 90 ? 'arc-danger' : pct > 75 ? 'arc-warn' : '');
    valEl.textContent = fmtPct(pct);
    if (subEl) subEl.textContent = `${formatBytes(used)} / ${formatCap(capStr)}`;
  } else {
    setMiniCircle('detail-ram-arc', 0);
    valEl.textContent = used > 0 ? formatBytes(used) : '-';
    if (subEl) subEl.textContent = formatCap(capStr);
  }
}

function setStorageBar(usedBytes, limitStr) {
  const valEl = document.getElementById('detail-storage');
  const subEl = document.getElementById('detail-storage-sub');
  if (!valEl) return;
  const used = usedBytes || 0;
  const usedFmt = formatBytes(used);
  const limitBytes = limitStr ? parseStorageLimit(limitStr) : null;
  const capBytes = limitBytes !== null ? limitBytes : (systemInfo.totalStorage || null);
  const capFmt = limitBytes !== null ? formatCap(limitStr)
    : (capBytes ? formatBytes(capBytes) : null);
  if (capBytes && capBytes > 0) {
    const ratio = (used / capBytes) * 100;
    const over = used > capBytes;
    setMiniCircle('detail-storage-arc', ratio, over ? 'arc-danger' : ratio > 90 ? 'arc-warn' : '');
    valEl.textContent = fmtPct(ratio);
    valEl.style.color = over ? 'var(--red)' : '';
    if (subEl) subEl.textContent = `${usedFmt} / ${capFmt}`;
    return;
  }
  setMiniCircle('detail-storage-arc', 0);
  valEl.textContent = usedFmt;
  valEl.style.color = '';
  if (subEl) subEl.textContent = '';
}

function updateDetailOnline(online, players = 0, maxPlayers = 0, playerList = []) {
  const bigStatus = document.getElementById('big-status-badge');
  bigStatus.className = `big-status ${online ? 'online' : ''}`;
  bigStatus.textContent = online ? 'ONLINE' : 'OFFLINE';
  currentOnlinePlayers = online ? (playerList || []) : [];
  setPlayersBar(players, maxPlayers, online);
  const listEl = document.getElementById('detail-player-list');
  if (listEl) {
    if (online && playerList.length > 0) {
      const shown = playerList.slice(0, 5);
      const extra = playerList.length - shown.length;
      listEl.textContent = shown.join(', ') + (extra > 0 ? ` +${extra} more` : '');
      listEl.style.display = '';
    } else {
      listEl.style.display = 'none';
    }
  }
}

// ─── Players tab ──────────────────────────────────────────────────────────────
let currentOnlinePlayers = [];
let playerData = { players: [], banned: [] };
let _selectedPlayerName = null;

// Player-head avatar. minotar resolves by UUID (dashless) or, failing that, by
// name; unknown players fall back to the default Steve head.
function playerHeadUrl(p, size = 38) {
  const id = p && p.uuid ? p.uuid.replace(/-/g, '') : encodeURIComponent((p && p.name) || 'Steve');
  return `https://minotar.net/helm/${id}/${size}.png`;
}

async function _readServerJson(id, rel) {
  try {
    return JSON.parse(await window.mcpanel.readServerFile(id, rel));
  } catch { return null; }
}

function _isServerRunning() {
  return !!(currentServerId && serverStartTimes[currentServerId]);
}

// Aggregate the roster from the server's own JSON files (each optional) plus the
// currently-online sample. Banned players are split into their own list.
async function loadPlayerData(id) {
  const [whitelist, ops, banned, usercache] = await Promise.all([
    _readServerJson(id, 'whitelist.json'),
    _readServerJson(id, 'ops.json'),
    _readServerJson(id, 'banned-players.json'),
    _readServerJson(id, 'usercache.json'),
  ]);

  const map = new Map(); // lowercased name → player
  const put = (name, uuid) => {
    if (!name) return null;
    const key = String(name).toLowerCase();
    let p = map.get(key);
    if (!p) { p = { name, uuid: uuid || null, whitelisted: false, op: false, online: false }; map.set(key, p); }
    if (!p.uuid && uuid) p.uuid = uuid;
    return p;
  };

  (Array.isArray(usercache) ? usercache : []).forEach(e => put(e.name, e.uuid));
  (Array.isArray(whitelist) ? whitelist : []).forEach(e => { const p = put(e.name, e.uuid); if (p) p.whitelisted = true; });
  (Array.isArray(ops) ? ops : []).forEach(e => { const p = put(e.name, e.uuid); if (p) { p.op = true; p.opLevel = e.level; } });
  (currentOnlinePlayers || []).forEach(n => { const p = put(n); if (p) p.online = true; });

  const bannedList = (Array.isArray(banned) ? banned : []).map(e => ({
    name: e.name, uuid: e.uuid || null, reason: e.reason || '', source: e.source || '', created: e.created || '',
  }));
  const bannedKeys = new Set(bannedList.map(b => String(b.name || '').toLowerCase()));

  const players = [...map.values()].filter(p => !bannedKeys.has(p.name.toLowerCase()));
  players.sort((a, b) => (b.online - a.online) || (b.op - a.op) || a.name.localeCompare(b.name));

  return { players, banned: bannedList };
}

async function openPlayersTab() {
  showPlayerRoster();
  await reloadPlayers();
}

async function reloadPlayers() {
  const id = currentServerId;
  if (!id) return;
  playerData = await loadPlayerData(id);
  renderPlayerRoster();
  // Keep an open control panel in sync with the freshly-loaded data.
  if (_selectedPlayerName && !document.getElementById('player-view-detail').classList.contains('hidden')) {
    renderPlayerDetail(_selectedPlayerName);
  }
}

// ── Sub-tab switching ──
function showPlayerRoster() {
  document.getElementById('psub-list').classList.add('active');
  document.getElementById('psub-detail').classList.remove('active');
  document.getElementById('player-view-roster').classList.remove('hidden');
  document.getElementById('player-view-detail').classList.add('hidden');
}
function showPlayerDetailTab() {
  const detailTab = document.getElementById('psub-detail');
  detailTab.classList.remove('hidden');
  detailTab.classList.add('active');
  document.getElementById('psub-list').classList.remove('active');
  document.getElementById('player-view-roster').classList.add('hidden');
  document.getElementById('player-view-detail').classList.remove('hidden');
}

// ── Roster rendering ──
function renderPlayerRoster() {
  const grid = document.getElementById('player-grid');
  if (!grid) return;
  const running = _isServerRunning();
  const players = playerData.players || [];
  document.getElementById('player-count').textContent = players.length;
  document.getElementById('player-empty').classList.toggle('hidden', players.length > 0);
  grid.innerHTML = players.map(playerItemHtml).join('');

  const banned = playerData.banned || [];
  document.getElementById('player-banned-count').textContent = banned.length;
  document.getElementById('player-banned-head').style.display = banned.length ? '' : 'none';
  document.getElementById('player-banned-grid').innerHTML = banned.map(b => bannedItemHtml(b, running)).join('');
}

function playerItemHtml(p) {
  const tags = [];
  if (p.online) tags.push('<span class="ptag online">Online</span>');
  if (p.op) tags.push('<span class="ptag op">OP</span>');
  if (p.whitelisted) tags.push('<span class="ptag wl">Whitelist</span>');
  if (!tags.length) tags.push('<span class="ptag" style="color:var(--text-muted);background:var(--bg-base)">Known</span>');
  const enc = encodeURIComponent(p.name);
  return `<div class="player-item" onclick="openPlayerControl('${enc}')">
    <img class="player-head" src="${playerHeadUrl(p, 38)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="player-item-info">
      <span class="player-item-name">${escapeHtml(p.name)}</span>
      <div class="player-tags">${tags.join('')}</div>
    </div>
  </div>`;
}

function bannedItemHtml(b, running) {
  const enc = encodeURIComponent(b.name);
  const reasonAttr = b.reason ? ` title="${escapeHtml(b.reason)}"` : '';
  return `<div class="player-item" onclick="openPlayerControl('${enc}')">
    <img class="player-head" src="${playerHeadUrl(b, 38)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="player-item-info">
      <span class="player-item-name">${escapeHtml(b.name)}</span>
      <div class="player-tags"><span class="ptag banned"${reasonAttr}>Banned</span></div>
    </div>
    <button class="btn-ghost-sm player-unban" ${running ? '' : 'disabled'}
      onclick="event.stopPropagation(); unbanPlayer('${enc}')">Unban</button>
  </div>`;
}

// ── Control panel ──
function findPlayerByName(name) {
  const key = name.toLowerCase();
  const p = (playerData.players || []).find(x => x.name.toLowerCase() === key);
  if (p) return { ...p, banned: false };
  const b = (playerData.banned || []).find(x => String(x.name || '').toLowerCase() === key);
  if (b) return { ...b, banned: true, whitelisted: false, op: false, online: false };
  return { name, uuid: null, banned: false, whitelisted: false, op: false, online: false };
}

function openPlayerControl(enc) {
  const name = decodeURIComponent(enc);
  _selectedPlayerName = name;
  renderPlayerDetail(name);
  showPlayerDetailTab();
}

function renderPlayerDetail(name) {
  const p = findPlayerByName(name);
  const view = document.getElementById('player-view-detail');
  if (!view) return;
  const running = _isServerRunning();
  const dis = running ? '' : 'disabled';
  const enc = encodeURIComponent(p.name);

  const tags = [];
  if (p.online) tags.push('<span class="ptag online">Online</span>');
  if (p.op) tags.push('<span class="ptag op">OP</span>');
  if (p.whitelisted) tags.push('<span class="ptag wl">Whitelist</span>');
  if (p.banned) tags.push('<span class="ptag banned">Banned</span>');

  let actions;
  if (p.banned) {
    actions = `<button class="btn-control start" ${dis} onclick="unbanPlayer('${enc}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Unban</button>`;
  } else {
    actions = `
      <button class="btn-control wl" ${dis} onclick="togglePlayerWhitelist('${enc}', ${p.whitelisted})">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        ${p.whitelisted ? 'Remove from whitelist' : 'Add to whitelist'}</button>
      <button class="btn-control op" ${dis} onclick="togglePlayerOp('${enc}', ${p.op})">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.6 5.8 21 7 14 2 9.3 9 8.5 12 2"/></svg>
        ${p.op ? 'Deop' : 'Op'}</button>
      <button class="btn-control warn" ${(p.online && running) ? '' : 'disabled'} onclick="kickPlayer('${enc}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>
        Kick</button>
      <button class="btn-control stop" ${dis} onclick="banPlayer('${enc}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/></svg>
        Ban</button>`;
  }

  const note = running ? '' : `<div class="player-offline-note">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    Start the server to manage this player.</div>`;

  view.innerHTML = `
    <div class="player-detail-head">
      <img class="player-head lg" src="${playerHeadUrl(p, 72)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="player-detail-meta">
        <div class="player-detail-name">${escapeHtml(p.name)}</div>
        ${p.uuid ? `<div class="player-detail-uuid">${escapeHtml(p.uuid)}</div>` : ''}
        <div class="player-detail-tags player-tags">${tags.join('')}</div>
      </div>
    </div>
    ${note}
    <div class="player-detail-actions">${actions}</div>`;

  document.getElementById('psub-detail-name').textContent = p.name;
}

// ── Actions (routed through the console; require a running server) ──
async function _playerCmd(cmd, okMsg) {
  if (!currentServerId) return false;
  const r = await window.mcpanel.sendCommand(currentServerId, cmd);
  if (r && r.error) { toast(r.error, 'error'); return false; }
  toast(okMsg, 'success');
  setTimeout(reloadPlayers, 700); // let the server write its JSON files first
  return true;
}
function togglePlayerWhitelist(enc, isWl) {
  const name = decodeURIComponent(enc);
  _playerCmd(`whitelist ${isWl ? 'remove' : 'add'} ${name}`, isWl ? `Removed ${name} from whitelist` : `Added ${name} to whitelist`);
}
function togglePlayerOp(enc, isOp) {
  const name = decodeURIComponent(enc);
  _playerCmd(`${isOp ? 'deop' : 'op'} ${name}`, isOp ? `Deopped ${name}` : `Opped ${name}`);
}
function kickPlayer(enc) {
  const name = decodeURIComponent(enc);
  _playerCmd(`kick ${name}`, `Kicked ${name}`);
}
function banPlayer(enc) {
  const name = decodeURIComponent(enc);
  _playerCmd(`ban ${name}`, `Banned ${name}`);
}
function unbanPlayer(enc) {
  const name = decodeURIComponent(enc);
  _playerCmd(`pardon ${name}`, `Unbanned ${name}`);
}

// ─── ANSI → HTML ─────────────────────────────────────────────────────────────
const ANSI_16 = [
  '#000000','#cc3333','#33cc55','#d4c84a','#4466cc','#cc44cc','#33cccc','#cccccc',
  '#666666','#ff5555','#55ff77','#ffff55','#5588ff','#ff55ff','#55ffff','#ffffff',
];

function ansi256(n) {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) { const g = 8 + 10 * (n - 232); return `rgb(${g},${g},${g})`; }
  n -= 16;
  const v = i => i === 0 ? 0 : 55 + 40 * i;
  return `rgb(${v(Math.floor(n/36))},${v(Math.floor(n/6)%6)},${v(n%6)})`;
}

function ansiToHtml(text) {
  const re = /\x1b\[([0-9;]*)m/g;
  let html = '', lastIdx = 0;
  let fg = null, bg = null, bold = false, openSpan = false;

  const flush = () => {
    if (openSpan) { html += '</span>'; openSpan = false; }
    if (fg || bg || bold) {
      let s = '';
      if (fg) s += `color:${fg};`;
      if (bg) s += `background:${bg};`;
      if (bold) s += 'font-weight:600;';
      html += `<span style="${s}">`;
      openSpan = true;
    }
  };

  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) html += escapeHtml(text.slice(lastIdx, m.index));
    lastIdx = re.lastIndex;

    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    let changed = false, i = 0;
    while (i < codes.length) {
      const c = codes[i];
      if (c === 0 || isNaN(c))           { fg = null; bg = null; bold = false; changed = true; }
      else if (c === 1)                   { bold = true; changed = true; }
      else if (c === 22)                  { bold = false; changed = true; }
      else if (c >= 30 && c <= 37)        { fg = ANSI_16[c - 30]; changed = true; }
      else if (c === 38) {
        if (codes[i+1] === 5 && codes[i+2] != null)             { fg = ansi256(codes[i+2]); i += 2; changed = true; }
        else if (codes[i+1] === 2 && codes[i+4] != null)         { fg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; changed = true; }
      }
      else if (c === 39)                  { fg = null; changed = true; }
      else if (c >= 40 && c <= 47)        { bg = ANSI_16[c - 40]; changed = true; }
      else if (c === 48) {
        if (codes[i+1] === 5 && codes[i+2] != null)             { bg = ansi256(codes[i+2]); i += 2; changed = true; }
        else if (codes[i+1] === 2 && codes[i+4] != null)         { bg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; changed = true; }
      }
      else if (c === 49)                  { bg = null; changed = true; }
      else if (c >= 90 && c <= 97)        { fg = ANSI_16[c - 82]; changed = true; }
      else if (c >= 100 && c <= 107)      { bg = ANSI_16[c - 92]; changed = true; }
      i++;
    }
    if (changed) flush();
  }

  if (lastIdx < text.length) html += escapeHtml(text.slice(lastIdx));
  if (openSpan) html += '</span>';
  return html;
}

// ─── Console Poll ─────────────────────────────────────────────────────────────
async function _pollStep(id) {
  if (consolePollInterval === null || id !== currentServerId) return;
  let delay = 50;
  try {
    const result = await window.mcpanel.getLogSince(id, consoleLogOffset);
    if (result && id === currentServerId) {
      consoleLogOffset = result.offset;
      (result.lines || []).forEach(entry => appendConsoleLine(entry.text || '', entry.type || 'out'));
    }
  } catch {
    // Don't hammer a broken read every 50ms — back off for a minute.
    delay = 60000;
  }
  if (consolePollInterval !== null && id === currentServerId) {
    consolePollInterval = setTimeout(() => _pollStep(id), delay);
  }
}

function startConsolePoll(id) {
  stopConsolePoll();
  consolePollInterval = setTimeout(() => _pollStep(id), 50);
}

function stopConsolePoll() {
  if (consolePollInterval) { clearTimeout(consolePollInterval); consolePollInterval = null; }
}

// ─── Console Autoscroll ───────────────────────────────────────────────────────
function setupConsoleScroll() {
  const el = document.getElementById('console-output');
  el.addEventListener('scroll', () => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    if (atBottom && !consoleAutoScroll) {
      consoleAutoScroll = true;
      document.getElementById('autoscroll-banner').classList.add('hidden');
    } else if (!atBottom && consoleAutoScroll) {
      consoleAutoScroll = false;
      document.getElementById('autoscroll-banner').classList.remove('hidden');
    }
  });
}

function resumeAutoscroll() {
  const el = document.getElementById('console-output');
  consoleAutoScroll = true;
  document.getElementById('autoscroll-banner').classList.add('hidden');
  el.scrollTop = el.scrollHeight;
}

// ─── Console ──────────────────────────────────────────────────────────────────
function appendConsoleLine(text, type = 'out') {
  const el = document.getElementById('console-output');
  if (!el) return;
  const line = document.createElement('div');

  if (type === 'system') {
    line.className = 'log-line system';
  } else {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    if (type === 'err' || /\b(ERROR|SEVERE|FATAL)\b/i.test(plain)) line.className = 'log-line err';
    else if (/\b(WARN(?:ING)?)\b/i.test(plain))                     line.className = 'log-line warn';
    else                                                              line.className = 'log-line';
  }

  const time = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const body = type === 'system' ? escapeHtml(text) : ansiToHtml(text);
  line.innerHTML = `<span class="log-time">[${time}]</span><span class="log-text">${body}</span>`;
  el.appendChild(line);
  if (consoleAutoScroll) el.scrollTop = el.scrollHeight;
}

function clearConsole() {
  const el = document.getElementById('console-output');
  if (el) el.innerHTML = '';
  consoleAutoScroll = true;
  document.getElementById('autoscroll-banner').classList.add('hidden');
}

function handleConsoleKey(e) {
  if (e.key === 'Enter') {
    sendConsoleCommand();
  } else if (e.key === 'ArrowUp') {
    historyIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
    e.target.value = commandHistory[commandHistory.length - 1 - historyIndex] || '';
  } else if (e.key === 'ArrowDown') {
    historyIndex = Math.max(historyIndex - 1, -1);
    e.target.value = historyIndex === -1 ? '' : commandHistory[commandHistory.length - 1 - historyIndex];
  }
}

async function sendConsoleCommand() {
  const input = document.getElementById('console-input');
  const cmd = input.value.trim();
  if (!cmd || !currentServerId) return;
  commandHistory.push(cmd);
  historyIndex = -1;
  input.value = '';
  appendConsoleLine('> ' + cmd, 'system');
  const r = await window.mcpanel.sendCommand(currentServerId, cmd);
  if (r.error) toast(r.error, 'error');
}

// ─── Quick Settings ───────────────────────────────────────────────────────────
async function applyQuickPort() {
  const port = parseInt(document.getElementById('quick-port').value);
  if (!port || !currentServerId) return;
  const r = await window.mcpanel.updateServer(currentServerId, { port });
  if (r.error) { toast(r.error, 'error'); return; }
  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) config.servers[idx].port = port;
  document.getElementById('detail-port').textContent = port;
  document.getElementById('detail-server-subtitle').textContent =
    `${config.servers[idx].version} · ${capitalise(config.servers[idx].software)} · Port ${port}`;
  toast('Port updated', 'success');
}

async function saveQuickSettings() {
  if (!currentServerId) return;
  const javaArgs = document.getElementById('quick-java-args').value;
  const javaPath = document.getElementById('quick-java-path').value;
  const group = document.getElementById('quick-group').value.trim() || null;
  const r = await window.mcpanel.updateServer(currentServerId, { javaArgs, javaPath, group });
  if (r.error) { toast(r.error, 'error'); return; }
  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) {
    config.servers[idx].javaArgs = javaArgs;
    config.servers[idx].javaPath = javaPath;
    config.servers[idx].group = group;
  }
  renderServersGrid();
  toast('Settings saved', 'success');
}

async function browseJava() {
  const p = await window.mcpanel.browseJava();
  if (p) setJdkDropdown('quick', 'quick-java-path', p);
}

// ─── Server Settings Modal ────────────────────────────────────────────────────
function openServerSettingsModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('ss-name').value = srv.name;
  setRamDropdown('ss', srv.ram || '2G');
  document.getElementById('ss-storage').value = srv.storageLimit || '';
  document.getElementById('ss-port').value = srv.port;
  document.getElementById('ss-group').value = srv.group || '';
  document.getElementById('ss-java-args').value = srv.javaArgs || '';
  populateJdkSelect('ss', 'ss-java-path', srv.javaPath || 'java');
  openModal('modal-server-settings');
}

async function saveServerSettings() {
  if (!currentServerId) return;
  const name = document.getElementById('ss-name').value.trim();
  if (!name) { toast('Please enter a server name', 'error'); return; }
  const ram = getRamValue('ss');
  if (!ram) { toast('Please enter a custom RAM value (e.g. 3G, 2048M)', 'error'); return; }
  const storageLimit = document.getElementById('ss-storage').value.trim() || null;
  const port = parseInt(document.getElementById('ss-port').value) || null;
  const group = document.getElementById('ss-group').value.trim() || null;
  const javaArgs = document.getElementById('ss-java-args').value.trim();
  const javaPath = document.getElementById('ss-java-path').value.trim() || 'java';

  if (storageLimit) {
    const bytes = parseStorageLimit(storageLimit);
    if (bytes === null) { toast('Invalid storage limit format (e.g. 10GB, 2048MB)', 'error'); return; }
    if (bytes < 500 * 1048576) { toast('Storage limit must be at least 500MB', 'error'); return; }
  }
  const deviceErr = validateRamAndStorage(ram, storageLimit);
  if (deviceErr) { toast(deviceErr, 'error'); return; }

  const updates = { name, ram, storageLimit, javaArgs, javaPath, group };
  if (port) updates.port = port;

  const r = await window.mcpanel.updateServer(currentServerId, updates);
  if (r.error) { toast(r.error, 'error'); return; }

  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) config.servers[idx] = { ...config.servers[idx], ...updates };
  const srv = config.servers[idx];

  document.getElementById('detail-server-name').textContent = name;
  document.getElementById('detail-server-subtitle').textContent = `${srv.version} · ${capitalise(srv.software)} · Port ${srv.port}`;
  refreshDetailStats(currentServerId);
  if (port) document.getElementById('detail-port').textContent = port;

  const nameEl = document.querySelector(`#card-${currentServerId} .server-card-name`);
  if (nameEl) nameEl.textContent = name;
  const sidebarName = document.querySelector(`[data-server-id="${currentServerId}"] .srv-name`);
  if (sidebarName) sidebarName.textContent = name;

  // Keep quick settings fields in sync
  if (port) document.getElementById('quick-port').value = port;
  document.getElementById('quick-java-args').value = javaArgs;
  document.getElementById('quick-java-path').value = javaPath;
  document.getElementById('quick-group').value = group || '';

  closeModal('modal-server-settings');
  renderServersGrid();
  toast('Settings saved', 'success');
}

async function browseJavaSettings() {
  const p = await window.mcpanel.browseJava();
  if (p) setJdkDropdown('ss', 'ss-java-path', p);
}

async function browseJavaCreate() {
  const path = await window.mcpanel.browseJava();
  if (path) setJdkDropdown('cs', 'cs-java', path);
}

function onRamChange(prefix) {
  const sel = document.getElementById(`${prefix}-ram`);
  const customEl = document.getElementById(`${prefix}-ram-custom`);
  if (!customEl) return;
  const isCustom = sel.value === 'custom';
  customEl.style.display = isCustom ? '' : 'none';
  if (isCustom) customEl.focus();
}

function getRamValue(prefix) {
  const sel = document.getElementById(`${prefix}-ram`);
  if (sel.value === 'custom') {
    return document.getElementById(`${prefix}-ram-custom`).value.trim() || null;
  }
  return sel.value;
}

function setRamDropdown(prefix, value) {
  const sel = document.getElementById(`${prefix}-ram`);
  const customEl = document.getElementById(`${prefix}-ram-custom`);
  const knownValues = ['512M','1G','2G','4G','6G','8G','12G','16G'];
  if (knownValues.includes(value)) {
    sel.value = value;
    if (customEl) customEl.style.display = 'none';
  } else {
    sel.value = 'custom';
    if (customEl) { customEl.value = value || ''; customEl.style.display = ''; }
  }
}

// ─── JDK picker (dropdown of detected JDKs + a custom-path fallback) ──────────
// The underlying text input (`inputId`) is always kept in sync with the
// resolved choice, so existing save/read code that reads that input's
// `.value` needs no changes — the dropdown is purely a UI layer on top.
async function populateJdkSelect(prefix, inputId, currentValue) {
  const sel = document.getElementById(`${prefix}-java-select`);
  if (!sel) return;
  sel.innerHTML = '<option value="java" title="java">Auto-detect (recommended)</option>';
  let jdks = [];
  try { jdks = await window.mcpanel.detectJdk(); } catch { jdks = []; }
  jdks.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.path;
    opt.title = j.path;
    opt.textContent = `Java ${j.version}`;
    sel.appendChild(opt);
  });
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Custom path…';
  sel.appendChild(custom);

  setJdkDropdown(prefix, inputId, currentValue);
}

// The dropdown's visible option text is just the JDK name — the actual
// install path only shows as a tooltip (on the closed select, reflecting the
// current selection; on each option, while the dropdown is open), so long
// paths don't get truncated or clutter the option list.
function _updateJdkSelectTooltip(sel, customPath) {
  sel.title = sel.value === '__custom__' ? (customPath || '') : (sel.selectedOptions[0]?.title || sel.value);
}

function setJdkDropdown(prefix, inputId, value) {
  const sel = document.getElementById(`${prefix}-java-select`);
  const customRow = document.getElementById(`${prefix}-java-custom-row`);
  const input = document.getElementById(inputId);
  if (!sel) return;
  const v = value || 'java';
  const known = Array.from(sel.options).some(o => o.value === v);
  if (known) {
    sel.value = v;
    if (customRow) customRow.style.display = 'none';
  } else {
    sel.value = '__custom__';
    if (customRow) customRow.style.display = '';
  }
  if (input) input.value = v;
  _updateJdkSelectTooltip(sel, v);
}

function onJdkSelectChange(prefix, inputId) {
  const sel = document.getElementById(`${prefix}-java-select`);
  const customRow = document.getElementById(`${prefix}-java-custom-row`);
  const input = document.getElementById(inputId);
  if (!sel) return;
  const isCustom = sel.value === '__custom__';
  if (customRow) customRow.style.display = isCustom ? '' : 'none';
  if (isCustom) {
    if (input) input.focus();
  } else if (input) {
    input.value = sel.value;
  }
  _updateJdkSelectTooltip(sel, input?.value);
}

function validateRamAndStorage(ram, storageLimit) {
  const ramBytes = parseStorageLimit(ram);
  if (ramBytes !== null && systemInfo.totalRam !== null && ramBytes > systemInfo.totalRam) {
    return `RAM limit cannot exceed your system's total RAM (${formatBytes(systemInfo.totalRam)})`;
  }
  if (storageLimit) {
    const storageBytes = parseStorageLimit(storageLimit);
    if (storageBytes !== null && systemInfo.availableStorage !== null && storageBytes > systemInfo.availableStorage) {
      return `Storage limit cannot exceed available disk space (${formatBytes(systemInfo.availableStorage)})`;
    }
  }
  return null;
}

function parseStorageLimit(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|K|M|G|T)?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = ((m[2] || 'B').toUpperCase()).replace(/B$/, '');
  const mult = { '': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776 };
  return num * (mult[unit] ?? 1);
}

function openServerFolder() {
  if (currentServerId) window.mcpanel.openServerFolder(currentServerId);
}

// ─── Rename Server (redirects to settings modal) ──────────────────────────────
function openRenameModal() {
  openServerSettingsModal();
}

// ─── Delete Server ────────────────────────────────────────────────────────────
async function confirmDeleteServer() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  const ok = await confirmDialog({
    title: 'Delete Server',
    message: `Permanently delete "${srv?.name || currentServerId}" and all its files?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Server',
  });
  if (ok) await executeDeleteServer();
}

async function executeDeleteServer() {
  if (!currentServerId) return;
  const r = await window.mcpanel.deleteServer(currentServerId);
  if (r.error) { toast(r.error, 'error'); return; }
  config.servers = config.servers.filter(s => s.id !== currentServerId);
  currentServerId = null;
  renderServersGrid();
  renderSidebarServers();
  showPage('servers');
  toast('Server deleted', 'info');
}

// ─── Create Server Modal ──────────────────────────────────────────────────────
async function openCreateServerModal() {
  const pre = document.getElementById('cs-prerelease');
  if (pre) pre.checked = false;
  const unstable = document.getElementById('cs-unstable');
  if (unstable) unstable.checked = false;
  setRamDropdown('cs', '2G');
  populateJdkSelect('cs', 'cs-java', 'java');
  await loadProfilesForCreate();
  openModal('modal-create-server');
  onSoftwareChange();
}

async function onSoftwareChange() {
  const software = document.getElementById('cs-software').value;
  const versionSel = document.getElementById('cs-version');
  const spigotWarn = document.getElementById('cs-spigot-warning');
  spigotWarn.classList.toggle('hidden', software !== 'spigot');

  // Snapshot checkbox: Vanilla & Fabric only
  const preReleaseEl = document.getElementById('cs-prerelease');
  const preReleaseLbl = document.getElementById('lbl-prerelease');
  const supportsSnapshot = ['vanilla', 'fabric'].includes(software);
  if (preReleaseEl) {
    preReleaseEl.disabled = !supportsSnapshot;
    if (!supportsSnapshot) preReleaseEl.checked = false;
  }
  if (preReleaseLbl) preReleaseLbl.style.opacity = supportsSnapshot ? '' : '0.35';

  // Unstable builds checkbox: Paper, Purpur, Folia, Leaf, Velocity
  const unstableEl = document.getElementById('cs-unstable');
  const unstableLbl = document.getElementById('lbl-unstable');
  const supportsUnstable = ['paper', 'purpur', 'folia', 'leaf', 'velocity'].includes(software);
  if (unstableEl) {
    unstableEl.disabled = !supportsUnstable;
    if (!supportsUnstable) unstableEl.checked = false;
  }
  if (unstableLbl) unstableLbl.style.opacity = supportsUnstable ? '' : '0.35';

  const preRelease = preReleaseEl?.checked || false;
  const unstable = unstableEl?.checked || false;

  if (software !== 'spigot') {
    document.getElementById('cs-spigot-jdk-warning').classList.add('hidden');
  }

  versionSel.innerHTML = '<option>Loading...</option>';
  const cacheKey = `${software}_${preRelease}_${unstable}`;
  if (versionCache[cacheKey]) {
    populateVersions(versionCache[cacheKey]);
    filterProfilesForSoftware(software);
    await onVersionChange();
    return;
  }

  const r = await window.mcpanel.fetchVersions(software, preRelease, unstable);
  if (r.error) {
    versionSel.innerHTML = '<option>Failed to load</option>';
    toast('Failed to fetch versions: ' + r.error, 'error');
    return;
  }
  versionCache[cacheKey] = r.versions;
  populateVersions(r.versions);
  filterProfilesForSoftware(software);
  await onVersionChange();
}

// Re-checks the JDK picker whenever the version changes — Spigot's required
// Java range is per-version (e.g. 1.21.11 needs 21, 26.2 needs 25-26), so a
// JDK that was fine for one version may not be for another.
async function onVersionChange() {
  const software = document.getElementById('cs-software').value;
  const version = document.getElementById('cs-version').value;

  if (software !== 'spigot') {
    document.getElementById('cs-spigot-jdk-warning')?.classList.add('hidden');
    populateJdkSelect('cs', 'cs-java', document.getElementById('cs-java').value || 'java');
    return;
  }
  if (!version || version === 'Loading...' || version === 'Failed to load') return;
  await updateSpigotJdkPicker(version);
}

// Spigot-specific JDK picker: BuildTools enforces an exact compile-time Java
// range that also matches what the compiled server needs to run, so this
// shows real per-version compatibility instead of a generic "Auto-detect".
async function updateSpigotJdkPicker(version) {
  const sel = document.getElementById('cs-java-select');
  const warnEl = document.getElementById('cs-spigot-jdk-warning');
  if (!sel) return;

  sel.innerHTML = '<option value="java">Checking installed JDKs…</option>';

  let compat = null;
  try {
    compat = await window.mcpanel.getJdkCompatibility('spigot', version);
  } catch (e) {
    compat = null;
  }

  const jdks = compat?.jdks || [];
  const recommended = compat?.recommended || null;
  const rng = compat?.range;
  const reqText = rng ? `Java ${rng.min}${rng.max ? '–' + rng.max : '+'}` : 'an unknown Java version';

  sel.innerHTML = '';
  jdks.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.path;
    opt.disabled = !j.compatible;
    const recTag = j.path === recommended ? ' (recommended)' : '';
    opt.textContent = j.compatible
      ? `Java ${j.version} - ${j.path}${recTag}`
      : `Java ${j.version} - ${j.path}  (${j.reason})`;
    sel.appendChild(opt);
  });
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = jdks.length ? 'Custom path…' : 'No JDKs detected - enter a path manually';
  sel.appendChild(custom);

  if (recommended) {
    setJdkDropdown('cs', 'cs-java', recommended);
  } else {
    sel.value = '__custom__';
    document.getElementById('cs-java-custom-row').style.display = '';
  }

  if (warnEl) {
    if (!recommended) {
      warnEl.textContent = `⚠ None of your installed JDKs support ${reqText} for Spigot ${version} - install one, or enter a path manually below.`;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }
  }
}

function populateVersions(versions) {
  const sel = document.getElementById('cs-version');
  sel.innerHTML = '';
  versions.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
}

function filterProfilesForSoftware(software) {
  const profileSel = document.getElementById('cs-profile');
  const version = document.getElementById('cs-version').value;
  const hint = document.getElementById('cs-profile-hint');
  
  profileSel.innerHTML = '<option value="">- No profile (plain server) -</option>';
  
  profiles.forEach(p => {
    const softwareOk = p.software.length === 0 || p.software.includes(software);
    const versionOk = p.versions.length === 0 || p.versions.includes(version);
    if (softwareOk && versionOk) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.description ? ` - ${p.description}` : '');
      profileSel.appendChild(opt);
    }
  });
  
  const compatible = profiles.filter(p => {
    return p.software.length === 0 || p.software.includes(software);
  });
  hint.textContent = compatible.length > 0 ? `${compatible.length} compatible profile(s) available` : '';
}

async function loadProfilesForCreate() {
  profiles = await window.mcpanel.getProfiles();
  filterProfilesForSoftware(document.getElementById('cs-software')?.value || 'paper');
}

async function createServer() {
  const name = document.getElementById('cs-name').value.trim();
  const software = document.getElementById('cs-software').value;
  const version = document.getElementById('cs-version').value;
  const port = parseInt(document.getElementById('cs-port').value) || 25565;
  const ram = getRamValue('cs');
  const storageLimit = document.getElementById('cs-storage').value.trim();
  const javaPath = document.getElementById('cs-java').value.trim() || 'java';
  const javaArgs = document.getElementById('cs-java-args').value.trim();
  const profileId = document.getElementById('cs-profile').value;

  if (!name) { toast('Please enter a server name', 'error'); return; }
  if (!ram) { toast('Please enter a custom RAM value (e.g. 3G, 2048M)', 'error'); return; }
  if (!version || version === 'Loading...' || version === 'Failed to load') {
    toast('Please select a version', 'error'); return;
  }
  if (storageLimit) {
    const bytes = parseStorageLimit(storageLimit);
    if (bytes === null) { toast('Invalid storage limit format (e.g. 10GB, 2048MB)', 'error'); return; }
    if (bytes < 500 * 1048576) { toast('Storage limit must be at least 500MB', 'error'); return; }
  }
  const deviceErr = validateRamAndStorage(ram, storageLimit);
  if (deviceErr) { toast(deviceErr, 'error'); return; }

  const btn = document.getElementById('cs-submit');
  btn.disabled = true; btn.textContent = 'Creating...';

  closeModal('modal-create-server');
  openModal('modal-download');

  const r = await window.mcpanel.createServer({
    name, software, version, port, ram,
    storageLimit: storageLimit || null,
    javaPath, javaArgs,
    profileId: profileId || null,
    unstableBuilds: document.getElementById('cs-unstable')?.checked || false,
  });

  closeModal('modal-download');
  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg> Create Server`;

  if (r.error) { toast('Error: ' + r.error, 'error'); return; }

  config.servers.push(r.server);
  renderServersGrid();
  renderSidebarServers();
  toast(`Server "${name}" created!`, 'success');
}

// ─── Profiles ─────────────────────────────────────────────────────────────────
// ─── Profile File Browser ─────────────────────────────────────────────────────

let currentProfileId = null;
let currentProfile = null;
let profileNavStack = [];
let profileNavPaths = [];
let profileCachedFileTree = null;
let selectedProfileFilePaths = new Set();

function _profileSubtitle(profile) {
  const sw = profile.software && profile.software.length ? profile.software.map(capitalise).join(', ') : 'Any Software';
  const ver = profile.versions && profile.versions.length ? profile.versions.join(', ') : 'Any Version';
  return `${sw} · ${ver}`;
}

function openProfileDetail(profileId) {
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;
  window.mcpanel.logEvent(`Opened profile panel: ${profile.name} -id ${profileId}`);
  currentProfileId = profileId;
  currentProfile = profile;
  profileNavStack = [];
  profileNavPaths = [];
  profileCachedFileTree = null;
  selectedProfileFilePaths.clear();
  const _pPluginListEl = document.getElementById('profile-plugin-list');
  if (_pPluginListEl) _pPluginListEl.innerHTML = `<div class="plugin-state-msg">Search for plugins or mods to install them.</div>`;
  const _pPluginSearchEl = document.getElementById('profile-plugin-search');
  if (_pPluginSearchEl) _pPluginSearchEl.value = '';

  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-profile-detail').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById('pd-name').textContent = profile.name;
  document.getElementById('pd-subtitle').textContent = _profileSubtitle(profile);
  document.getElementById('pd-id').textContent = profile.id;
  document.getElementById('pd-created').textContent = profile.created
    ? new Date(profile.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '-';

  _renderProfileSidebarTags();
  switchProfileTab('overview');
}

function _renderProfileSidebarTags() {
  const profile = currentProfile;
  const swEl = document.getElementById('pd-sw-tags');
  const verEl = document.getElementById('pd-ver-tags');
  const swList = profile.software && profile.software.length ? profile.software : [];
  const verList = profile.versions && profile.versions.length ? profile.versions : [];
  swEl.innerHTML = swList.length
    ? swList.map(s => `<span class="profile-tag">${escapeHtml(capitalise(s))}</span>`).join('')
    : `<span style="font-size:12px;color:var(--text-muted)">Any software</span>`;
  verEl.innerHTML = verList.length
    ? verList.map(v => `<span class="profile-tag">${escapeHtml(v)}</span>`).join('')
    : `<span style="font-size:12px;color:var(--text-muted)">Any version</span>`;
}

function switchProfileTab(name) {
  ['overview', 'files', 'plugins', 'settings'].forEach(t => {
    document.getElementById(`ptab-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-profile-${t}`).classList.toggle('hidden', t !== name);
  });
  if (name === 'overview') openProfileOverviewTab();
  if (name === 'files') openProfileFileBrowser();
  if (name === 'settings') openProfileSettingsTab();
  if (name === 'plugins') openProfilePluginsTab();
}

function openProfileOverviewTab() {
  const using = (config.servers || []).filter(s => s.profileId === currentProfileId);
  const listEl = document.getElementById('pd-server-list');
  const descEl = document.getElementById('pd-description');

  if (using.length === 0) {
    listEl.innerHTML = `<div class="pd-server-empty">No servers are currently using this profile.</div>`;
  } else {
    listEl.innerHTML = using.map(srv => `
      <div class="pd-server-row">
        <div class="pd-server-info">
          <span class="pd-server-name">${escapeHtml(srv.name)}</span>
          <span class="pd-server-meta">${escapeHtml(srv.version)} · ${escapeHtml(capitalise(srv.software))}</span>
        </div>
        <button class="btn-xs" onclick="openServerDetail('${srv.id}')">Go to Server</button>
      </div>
    `).join('');
  }

  const desc = currentProfile.description || '';
  descEl.innerHTML = desc
    ? `<p class="pd-desc-text">${escapeHtml(desc)}</p>`
    : `<p class="pd-desc-text" style="color:var(--text-muted)">No description.</p>`;
}

function openProfileSettingsTab() {
  const profile = currentProfile;
  document.getElementById('ps-name').value = profile.name || '';
  document.getElementById('ps-desc').value = profile.description || '';
  document.getElementById('ps-versions').value = (profile.versions || []).join(', ');
  document.querySelectorAll('#ps-software-checks input[type=checkbox]').forEach(cb => {
    cb.checked = (profile.software || []).includes(cb.value);
  });
}

async function saveProfileSettings() {
  const name = document.getElementById('ps-name').value.trim();
  if (!name) { toast('Profile name is required', 'error'); return; }
  const description = document.getElementById('ps-desc').value.trim();
  const software = [...document.querySelectorAll('#ps-software-checks input:checked')].map(cb => cb.value);
  const versionsRaw = document.getElementById('ps-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];

  try {
    await window.mcpanel.updateProfile(currentProfileId, { name, description, software, versions });
    currentProfile = { ...currentProfile, name, description, software, versions };
    document.getElementById('pd-name').textContent = name;
    document.getElementById('pd-subtitle').textContent = _profileSubtitle(currentProfile);
    _renderProfileSidebarTags();
    profiles = profiles.map(p => p.id === currentProfileId ? currentProfile : p);
    toast('Profile updated', 'success');
    switchProfileTab('overview');
  } catch (e) {
    toast('Save failed: ' + e, 'error');
  }
}

async function deleteCurrentProfile() {
  const ok = await confirmDialog({
    title: 'Delete Profile',
    message: `Permanently delete the profile "${currentProfile.name}" and all its files?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Profile',
  });
  if (!ok) return;
  const r = await window.mcpanel.deleteProfile(currentProfileId);
  if (r && r.error) { toast(r.error, 'error'); return; }
  profiles = profiles.filter(p => p.id !== currentProfileId);
  toast('Profile deleted', 'info');
  showPage('profiles');
}

async function openProfileFileBrowser() {
  if (!currentProfileId) return;
  const listEl = document.getElementById('profile-file-list');
  const savedPaths = [...profileNavPaths];
  if (!profileCachedFileTree) {
    listEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px">Loading…</div>`;
    const r = await window.mcpanel.getProfileFileTree(currentProfileId);
    if (r.error) {
      listEl.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">${escapeHtml(r.error)}</div>`;
      return;
    }
    profileCachedFileTree = r.tree || [];
  }
  profileNavStack = [profileCachedFileTree];
  profileNavPaths = [];
  for (const seg of savedPaths) {
    const dir = profileNavStack[profileNavStack.length - 1].find(n => n.type === 'dir' && n.name === seg);
    if (dir) { profileNavStack.push(dir.children || []); profileNavPaths.push(seg); }
    else break;
  }
  renderProfileFileBrowser();
}

async function reloadProfileFileTree() {
  profileCachedFileTree = null;
  await openProfileFileBrowser();
}

function renderProfileFileBrowser() {
  const children = profileNavStack[profileNavStack.length - 1];
  const listEl = document.getElementById('profile-file-list');
  const bcEl = document.getElementById('profile-file-breadcrumb');

  const parts = [currentProfileId, ...profileNavPaths];
  bcEl.innerHTML = parts.map((seg, i) => {
    const isCurrent = i === parts.length - 1;
    return (i > 0 ? `<span class="file-bc-sep">/</span>` : '') +
      `<span class="file-bc-seg${isCurrent ? ' current' : ''}" data-depth="${i}">${escapeHtml(seg)}</span>`;
  }).join('');
  bcEl.querySelectorAll('[data-depth]').forEach(el => {
    const depth = parseInt(el.dataset.depth);
    if (depth < parts.length - 1) el.onclick = () => profileFileBrowserGoTo(depth);
  });

  listEl.innerHTML = '';
  const sorted = [...children].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });

  for (const node of sorted) {
    const nodePath = [...profileNavPaths, node.name].join('/');
    const row = document.createElement('div');
    row.className = `file-row${node.type === 'dir' ? ' is-dir' : ''}${selectedProfileFilePaths.has(nodePath) ? ' selected' : ''}`;
    row.innerHTML = `
      <input type="checkbox" class="file-row-check" ${selectedProfileFilePaths.has(nodePath) ? 'checked' : ''}>
      <div class="file-row-icon">${fileIcon(node.name, node.type)}</div>
      <span class="file-row-name">${escapeHtml(node.name)}</span>
      <span class="file-row-size">${node.type === 'dir' ? '' : formatBytes(node.size || 0)}</span>
      <div class="file-row-actions">
        <button class="file-action-btn rename-btn" title="Rename">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="file-action-btn delete-btn" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`;

    row.querySelector('.file-row-check').addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) selectedProfileFilePaths.add(nodePath);
      else selectedProfileFilePaths.delete(nodePath);
      row.classList.toggle('selected', e.target.checked);
      _syncFileSelectAllCheckbox('profile-file-select-all', children, profileNavPaths, selectedProfileFilePaths);
      _syncFileSelActions('profile-file-sel-actions', 'profile-file-sel-count', selectedProfileFilePaths);
    });
    row.querySelector('.file-row-check').addEventListener('click', e => e.stopPropagation());
    row.querySelector('.rename-btn').addEventListener('click', e => { e.stopPropagation(); renameProfileFileEntry(nodePath, node.name); });
    row.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteProfileFileEntry(nodePath, node.name, node.type === 'dir');
    });

    if (node.type === 'dir') {
      row.ondblclick = () => {
        profileNavStack.push(node.children || []);
        profileNavPaths.push(node.name);
        renderProfileFileBrowser();
      };
      row.ondragover = e => { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = e => {
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('drop-target');
        _handleProfileDrop(e, [...profileNavPaths, node.name].join('/'));
      };
    } else {
      row.ondblclick = () => openFileEditor(nodePath, node.name, { type: 'profile', id: currentProfileId });
    }
    listEl.appendChild(row);
  }
  _syncFileSelectAllCheckbox('profile-file-select-all', children, profileNavPaths, selectedProfileFilePaths);
  _syncFileSelActions('profile-file-sel-actions', 'profile-file-sel-count', selectedProfileFilePaths);
}

function toggleSelectAllProfileFiles(checked) {
  const children = profileNavStack[profileNavStack.length - 1] || [];
  for (const node of children) {
    const nodePath = [...profileNavPaths, node.name].join('/');
    if (checked) selectedProfileFilePaths.add(nodePath);
    else selectedProfileFilePaths.delete(nodePath);
  }
  renderProfileFileBrowser();
}

function profileFileBrowserGoTo(depth) {
  while (profileNavStack.length > depth + 1) { profileNavStack.pop(); profileNavPaths.pop(); }
  renderProfileFileBrowser();
}

function _handleProfileDrop(e, destDir) {
  const paths = getDroppedPaths(e);
  if (paths.length) uploadProfileFilesFromPaths(paths, destDir);
  else uploadProfileFiles(e.dataTransfer.files, destDir);
}

function profileFilePanelDragOver(e) { e.preventDefault(); }
function profileFilePanelDrop(e) {
  e.preventDefault();
  _handleProfileDrop(e, profileNavPaths.join('/'));
}
function profileFileZoneDragOver(e) {
  e.preventDefault();
  document.getElementById('profile-file-drop-zone').classList.add('drop-active');
}
function profileFileZoneDragLeave(e) {
  document.getElementById('profile-file-drop-zone').classList.remove('drop-active');
}
function profileFileZoneDrop(e) {
  e.preventDefault();
  document.getElementById('profile-file-drop-zone').classList.remove('drop-active');
  _handleProfileDrop(e, profileNavPaths.join('/'));
}

function handleProfileFileInputChange(e) {
  uploadProfileFiles(e.target.files, profileNavPaths.join('/'));
  e.target.value = '';
}

async function uploadProfileFiles(fileList, dirPath) {
  if (!fileList || fileList.length === 0 || !currentProfileId) return;
  const files = Array.from(fileList);
  const total = files.length;
  const progressEl = document.getElementById('profile-file-upload-progress');
  const fillEl = document.getElementById('profile-file-upload-progress-fill');
  const textEl = document.getElementById('profile-file-upload-progress-text');
  const dropZone = document.getElementById('profile-file-drop-zone');
  progressEl.classList.remove('hidden');
  dropZone.style.pointerEvents = 'none';
  let done = 0, errors = 0;
  for (const file of files) {
    fillEl.style.width = `${Math.round((done / total) * 100)}%`;
    textEl.textContent = `Uploading ${file.name} (${done + 1}/${total})`;
    try {
      const buf = await file.arrayBuffer();
      const data = Array.from(new Uint8Array(buf));
      const rel = dirPath ? `${dirPath}/${file.name}` : file.name;
      await window.mcpanel.writeProfileFile(currentProfileId, rel, data);
      done++;
    } catch (e) {
      errors++;
      toast(`Failed to upload ${file.name}: ${e}`, 'error');
    }
  }
  fillEl.style.width = '100%';
  if (errors === 0) {
    textEl.textContent = `Done - ${done} file${done > 1 ? 's' : ''} uploaded`;
    toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`, 'success');
  } else {
    textEl.textContent = `${done} uploaded, ${errors} failed`;
  }
  if (done > 0) {
    window.mcpanel.logEvent(`Uploaded ${done} item(s) to profile${dirPath ? ` (/${dirPath})` : ''} -id ${currentProfileId}`);
  }
  dropZone.style.pointerEvents = '';
  setTimeout(() => { progressEl.classList.add('hidden'); fillEl.style.width = '0%'; }, 3000);
  if (done > 0) { profileCachedFileTree = null; await openProfileFileBrowser(); }
}

async function uploadProfileFilesFromPaths(paths, destDir) {
  if (!paths.length || !currentProfileId) return;
  const progressEl = document.getElementById('profile-file-upload-progress');
  const fillEl = document.getElementById('profile-file-upload-progress-fill');
  const textEl = document.getElementById('profile-file-upload-progress-text');
  progressEl.classList.remove('hidden');
  textEl.textContent = `Copying ${paths.length} file${paths.length > 1 ? 's' : ''}…`;
  try {
    await window.mcpanel.uploadFilesToProfile(currentProfileId, paths, destDir);
    fillEl.style.width = '100%';
    textEl.textContent = `Done - ${paths.length} file${paths.length > 1 ? 's' : ''} copied`;
    toast(`Copied ${paths.length} file${paths.length > 1 ? 's' : ''}`, 'success');
  } catch (e) {
    toast('Upload failed: ' + e, 'error');
    fillEl.style.width = '0%';
  }
  setTimeout(() => { progressEl.classList.add('hidden'); fillEl.style.width = '0%'; }, 3000);
  profileCachedFileTree = null;
  await openProfileFileBrowser();
}

async function deleteProfileFileEntry(relPath, name, isDir) {
  const ok = await confirmDialog({
    title: isDir ? 'Delete Folder' : 'Delete File',
    message: isDir
      ? `Delete the folder "${name}" and all its contents?\n\nThis action cannot be undone.`
      : `Delete the file "${name}"?\n\nThis action cannot be undone.`,
  });
  if (!ok) return;
  try {
    await window.mcpanel.deleteProfileFile(currentProfileId, relPath);
    toast(`Deleted "${name}"`, 'info');
    profileCachedFileTree = null;
    await openProfileFileBrowser();
  } catch (e) { toast('Delete failed: ' + e, 'error'); }
}

async function deleteSelectedProfileFiles() {
  const count = selectedProfileFilePaths.size;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'Delete Items',
    message: `Delete ${count} selected item${count !== 1 ? 's' : ''}?\n\nFolders are deleted with all their contents. This action cannot be undone.`,
    confirmLabel: `Delete ${count} Item${count !== 1 ? 's' : ''}`,
  });
  if (!ok) return;
  const paths = [...selectedProfileFilePaths];
  let failed = 0;
  for (const p of paths) {
    try { await window.mcpanel.deleteProfileFile(currentProfileId, p); }
    catch { failed++; }
  }
  selectedProfileFilePaths.clear();
  if (failed === 0) toast(`Deleted ${paths.length} item${paths.length !== 1 ? 's' : ''}`, 'info');
  else toast(`Deleted ${paths.length - failed}, failed ${failed}`, 'error');
  profileCachedFileTree = null;
  await openProfileFileBrowser();
}

function renameProfileFileEntry(relPath, name) {
  openFileInput('Rename', 'New name', name, async (newName) => {
    if (newName === name) return;
    const parts = relPath.split('/');
    parts[parts.length - 1] = newName;
    try {
      await window.mcpanel.renameProfileFile(currentProfileId, relPath, parts.join('/'));
      toast(`Renamed to "${newName}"`, 'success');
      profileCachedFileTree = null;
      await openProfileFileBrowser();
    } catch (e) { toast('Rename failed: ' + e, 'error'); }
  });
}

function createNewProfileFolder() {
  if (!currentProfileId) return;
  openFileInput('New Folder', 'Folder name', '', async (name) => {
    const relPath = profileNavPaths.length ? profileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createProfileDir(currentProfileId, relPath);
      toast(`Folder "${name}" created`, 'success');
      profileCachedFileTree = null;
      await openProfileFileBrowser();
    } catch (e) { toast('Create failed: ' + e, 'error'); }
  });
}

function createNewProfileFile() {
  if (!currentProfileId) return;
  openFileInput('New File', 'File name', '', async (name) => {
    const relPath = profileNavPaths.length ? profileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createProfileFile(currentProfileId, relPath);
      toast(`File "${name}" created`, 'success');
      profileCachedFileTree = null;
      await openProfileFileBrowser();
    } catch (e) { toast('Create failed: ' + e, 'error'); }
  });
}

// ─── Profiles Grid ────────────────────────────────────────────────────────────

function renderProfilesGrid() {
  window.mcpanel.getProfiles().then(p => {
    profiles = p;
    const query = (document.getElementById('profiles-search')?.value || '').trim().toLowerCase();
    const grid = document.getElementById('profiles-grid');
    const empty = document.getElementById('profiles-empty');
    grid.querySelectorAll('.server-card.profile-card, .grid-no-results').forEach(c => c.remove());
    if (p.length === 0) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    const filtered = sortProfiles(query
      ? p.filter(pr =>
          pr.name.toLowerCase().includes(query) ||
          (pr.description || '').toLowerCase().includes(query) ||
          (pr.software || []).some(sw => sw.toLowerCase().includes(query))
        )
      : p);
    if (filtered.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'grid-no-results';
      msg.textContent = `No profiles matching "${query}"`;
      grid.appendChild(msg);
      return;
    }
    filtered.forEach(profile => grid.appendChild(createProfileCard(profile)));
  });
}

function createProfileCard(profile) {
  const card = document.createElement('div');
  card.className = 'server-card profile-card';
  card.id = `pcard-${profile.id}`;

  const swList = profile.software || [];
  const verList = profile.versions || [];
  const usingCount = (config.servers || []).filter(s => s.profileId === profile.id).length;

  const swDisplay = swList.length === 0
    ? 'Any'
    : swList.length <= 2
      ? swList.map(capitalise).join(', ')
      : `${swList.slice(0, 2).map(capitalise).join(', ')} +${swList.length - 2}`;

  const verDisplay = verList.length === 0
    ? 'Any'
    : verList.length <= 2
      ? verList.join(', ')
      : `${verList.slice(0, 2).join(', ')} +${verList.length - 2}`;

  const sub = profile.description
    ? escapeHtml(profile.description)
    : '<span style="color:var(--text-muted)">No description</span>';

  card.innerHTML = `
    <div class="server-card-header">
      <div>
        <div class="server-card-name">${escapeHtml(profile.name)}</div>
        <div class="server-card-sub">${sub}</div>
      </div>
      <div class="profile-server-count">${usingCount} server${usingCount !== 1 ? 's' : ''}</div>
    </div>
    <div class="server-card-stats">
      <div class="stat-chip">
        <div class="stat-chip-label">Software</div>
        <div class="stat-chip-value">${escapeHtml(swDisplay)}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Versions</div>
        <div class="stat-chip-value">${escapeHtml(verDisplay)}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Used By</div>
        <div class="stat-chip-value">${usingCount} server${usingCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Created</div>
        <div class="stat-chip-value">${profile.created ? new Date(profile.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : '-'}</div>
      </div>
    </div>
    <div class="server-card-footer">
      <button class="btn-ghost" style="font-size:12px;padding:6px 12px" onclick="openProfileDetail('${profile.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Manage
      </button>
    </div>
  `;
  return card;
}

async function deleteProfile(id) {
  const p = profiles.find(x => x.id === id);
  const ok = await confirmDialog({
    title: 'Delete Profile',
    message: `Permanently delete the profile "${p?.name || id}" and all its files?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Profile',
  });
  if (!ok) return;
  const r = await window.mcpanel.deleteProfile(id);
  if (r.error) { toast(r.error, 'error'); return; }
  profiles = profiles.filter(p => p.id !== id);
  renderProfilesGrid();
  toast('Profile deleted', 'info');
}

function openCreateProfileModal() {
  // Reset form
  document.getElementById('cp-name').value = '';
  document.getElementById('cp-desc').value = '';
  document.getElementById('cp-versions').value = '';
  document.querySelectorAll('#cp-software-checks input').forEach(cb => cb.checked = false);
  openModal('modal-create-profile');
}

async function createProfile() {
  const name = document.getElementById('cp-name').value.trim();
  if (!name) { toast('Please enter a profile name', 'error'); return; }
  const description = document.getElementById('cp-desc').value.trim();
  const software = Array.from(document.querySelectorAll('#cp-software-checks input:checked')).map(cb => cb.value);
  const versionsRaw = document.getElementById('cp-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];

  const r = await window.mcpanel.createProfile({ name, description, software, versions });
  if (r.error) { toast(r.error, 'error'); return; }
  profiles.push(r.profile);
  closeModal('modal-create-profile');
  renderProfilesGrid();
  toast(`Profile "${name}" created! Open the folder to add files.`, 'success');
  // Auto-open folder
  window.mcpanel.openProfileFolder(r.profile.id);
}

// ─── Import Profile ───────────────────────────────────────────────────────────
function openImportProfileModal() {
  document.getElementById('ip-folder-path').value = '';
  document.getElementById('ip-name').value = '';
  document.getElementById('ip-desc').value = '';
  document.getElementById('ip-versions').value = '';
  document.querySelectorAll('#ip-software-checks input').forEach(cb => cb.checked = false);
  openModal('modal-import-profile');
}

async function browseImportProfileFolder() {
  const folderPath = await window.mcpanel.browseFolder();
  if (!folderPath) return;
  document.getElementById('ip-folder-path').value = folderPath;
  const scan = await window.mcpanel.scanProfileFolder(folderPath);
  if (scan.name) document.getElementById('ip-name').value = scan.name;
  if (scan.description) document.getElementById('ip-desc').value = scan.description;
  if (scan.software && scan.software.length > 0) {
    document.querySelectorAll('#ip-software-checks input').forEach(cb => {
      cb.checked = scan.software.includes(cb.value);
    });
  }
  if (scan.versions && scan.versions.length > 0) {
    document.getElementById('ip-versions').value = scan.versions.join(', ');
  }
  // Auto-fill name from folder if profile.json had none
  if (!document.getElementById('ip-name').value) {
    document.getElementById('ip-name').value = folderPath.split(/[/\\]/).pop();
  }
}

async function importProfile() {
  const folderPath = document.getElementById('ip-folder-path').value.trim();
  const name = document.getElementById('ip-name').value.trim();
  if (!folderPath) { toast('Please select a folder', 'error'); return; }
  if (!name) { toast('Please enter a profile name', 'error'); return; }

  const description = document.getElementById('ip-desc').value.trim();
  const software = Array.from(document.querySelectorAll('#ip-software-checks input:checked')).map(cb => cb.value);
  const versionsRaw = document.getElementById('ip-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];

  const btn = document.getElementById('ip-submit');
  btn.disabled = true; btn.textContent = 'Importing...';

  const r = await window.mcpanel.importProfile({ folderPath, name, description, software, versions });
  btn.disabled = false; btn.textContent = 'Import Profile';

  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  profiles.push(r.profile);
  closeModal('modal-import-profile');
  renderProfilesGrid();
  toast(`Profile "${name}" imported!`, 'success');
}

// ─── Import Server ────────────────────────────────────────────────────────────
function openImportServerModal() {
  document.getElementById('is-folder-path').value = '';
  document.getElementById('is-name').value = '';
  document.getElementById('is-version').value = '';
  document.getElementById('is-port').value = '25565';
  document.getElementById('is-software').value = 'paper';
  setRamDropdown('is', '2G');
  document.getElementById('is-java').value = 'java';
  document.getElementById('is-java-args').value = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200';
  openModal('modal-import-server');
}

async function browseImportServerFolder() {
  const folderPath = await window.mcpanel.browseFolder();
  if (!folderPath) return;
  document.getElementById('is-folder-path').value = folderPath;
  const scan = await window.mcpanel.scanServerFolder(folderPath);
  if (scan.port) document.getElementById('is-port').value = scan.port;
  if (scan.software) document.getElementById('is-software').value = scan.software;
  if (scan.version) document.getElementById('is-version').value = scan.version;
  if (!document.getElementById('is-name').value) {
    document.getElementById('is-name').value = folderPath.split(/[/\\]/).pop();
  }
}

async function browseJavaImport() {
  const p = await window.mcpanel.browseJava();
  if (p) document.getElementById('is-java').value = p;
}

async function importServer() {
  const folderPath = document.getElementById('is-folder-path').value.trim();
  const name = document.getElementById('is-name').value.trim();
  if (!folderPath) { toast('Please select a server folder', 'error'); return; }
  if (!name) { toast('Please enter a server name', 'error'); return; }

  const software = document.getElementById('is-software').value;
  const version = document.getElementById('is-version').value.trim() || 'Unknown';
  const port = parseInt(document.getElementById('is-port').value) || 25565;
  const ram = getRamValue('is');
  if (!ram) { toast('Please enter a custom RAM value (e.g. 3G, 2048M)', 'error'); return; }
  const deviceErr = validateRamAndStorage(ram, null);
  if (deviceErr) { toast(deviceErr, 'error'); return; }
  const javaPath = document.getElementById('is-java').value.trim() || 'java';
  const javaArgs = document.getElementById('is-java-args').value.trim();

  const btn = document.getElementById('is-submit');
  btn.disabled = true; btn.textContent = 'Importing...';

  closeModal('modal-import-server');
  document.getElementById('modal-download-title').textContent = 'Importing Server';
  openModal('modal-download');

  const r = await window.mcpanel.importServer({ folderPath, name, software, version, port, ram, javaPath, javaArgs });

  closeModal('modal-download');
  document.getElementById('modal-download-title').textContent = 'Creating Server';
  btn.disabled = false; btn.textContent = 'Import Server';

  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  config.servers.push(r.server);
  renderServersGrid();
  renderSidebarServers();
  toast(`Server "${name}" imported!`, 'success');
}

// ─── Update checker ───────────────────────────────────────────────────────────
function applyUpdateResult(result) {
  const statusEl = document.getElementById('update-status-text');
  const pillEl = document.getElementById('update-pill');
  if (result.hasUpdate) {
    if (statusEl) {
      statusEl.innerHTML = `MCPanel: <span style="color:var(--yellow)">v${result.latest} available - </span><a href="#" style="color:var(--purple-300)" onclick="window.mcpanel.openExternal('${result.url}');return false">View release</a>`;
    }
    if (pillEl) pillEl.classList.remove('hidden');
    toast(`MCPanel v${result.latest} is available on GitHub`, 'info');
  } else if (result.latest) {
    if (statusEl) statusEl.textContent = `MCPanel: up to date (v${result.current})`;
  } else {
    if (statusEl) statusEl.textContent = `MCPanel: could not reach GitHub (v${result.current} installed)`;
  }
}

async function checkForUpdates() {
  const statusEl = document.getElementById('update-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  const result = await window.mcpanel.checkUpdate();
  applyUpdateResult(result);
}

function applyCliUpdateResult(result) {
  const statusEl = document.getElementById('cli-update-status-text');
  if (result.hasUpdate) {
    if (statusEl) {
      statusEl.innerHTML = `MCPanel-CLI: <span style="color:var(--yellow)">v${result.latest} available - </span><a href="#" style="color:var(--purple-300)" onclick="window.mcpanel.openExternal('${result.url}');return false">View on GitHub</a>`;
    }
    toast(`MCPanel-CLI v${result.latest} is available on GitHub`, 'info');
  } else if (result.latest) {
    if (statusEl) statusEl.textContent = `MCPanel-CLI: up to date (v${result.current})`;
  } else {
    if (statusEl) statusEl.textContent = result.current ? `MCPanel-CLI: could not reach GitHub (v${result.current} installed)` : 'MCPanel-CLI: could not check version';
  }
}

async function checkForCliUpdates() {
  const statusEl = document.getElementById('cli-update-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  const result = await window.mcpanel.checkCliUpdate();
  applyCliUpdateResult(result);
}

// ─── BuildTools (SpigotMC) status + Spigot enable/disable ─────────────────────
let spigotDisabled = false;

function enableSpigotFunctionality() {
  spigotDisabled = false;
  const opt = document.getElementById('cs-opt-spigot');
  if (opt) { opt.disabled = false; opt.textContent = 'Spigot'; }
}

function disableSpigotFunctionality() {
  spigotDisabled = true;
  const opt = document.getElementById('cs-opt-spigot');
  if (opt) {
    opt.disabled = true;
    opt.textContent = 'Spigot (unavailable)';
  }
  const sel = document.getElementById('cs-software');
  if (sel && sel.value === 'spigot') {
    sel.value = 'paper';
    onSoftwareChange();
  }
}

function showBuildToolsMissingModal() {
  openModal('modal-buildtools-missing');
}

function ignoreBuildToolsMissing() {
  closeModal('modal-buildtools-missing');
  disableSpigotFunctionality();
  toast('Spigot support hidden - BuildTools could not be loaded', 'info');
}

// result: { version: "installed" | "none", path?, error?, helpUrl? }
function applyBuildToolsResult(result) {
  const statusEl = document.getElementById('buildtools-status-text');
  if (!result) {
    if (statusEl) statusEl.textContent = 'BuildTools: could not check status';
    return;
  }
  if (result.version === 'installed') {
    if (statusEl) statusEl.textContent = 'BuildTools: installed, operational';
    enableSpigotFunctionality();
  } else {
    if (statusEl) {
      statusEl.innerHTML = `BuildTools: <span style="color:var(--red)">unavailable - ${result.error || 'could not be downloaded'}</span>`;
    }
    disableSpigotFunctionality();
  }
}

async function checkBuildToolsVersion() {
  const statusEl = document.getElementById('buildtools-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  try {
    const result = await window.mcpanel.getBuildToolsVersion();
    applyBuildToolsResult(result);
  } catch (e) {
    if (statusEl) statusEl.textContent = `BuildTools: ${e}`;
  }
}

async function updateBuildToolsNow() {
  const btn = document.getElementById('buildtools-update-btn');
  const statusEl = document.getElementById('buildtools-status-text');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  if (statusEl) statusEl.textContent = 'Updating BuildTools…';
  try {
    const result = await window.mcpanel.updateBuildTools();
    applyBuildToolsResult(result);
    if (result && result.version === 'installed') toast('BuildTools is up to date', 'success');
  } catch (e) {
    if (statusEl) statusEl.textContent = `BuildTools: ${e}`;
    toast(String(e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Update Now'; }
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function detectJdk() {
  const list = document.getElementById('jdk-list');
  list.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Scanning...</div>';
  const found = await window.mcpanel.detectJdk();
  list.innerHTML = '';
  if (found.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No Java installations detected automatically.</div>';
    return;
  }
  found.forEach(jdk => {
    const item = document.createElement('div');
    item.className = 'jdk-item';
    item.innerHTML = `
      <span class="jdk-path">${escapeHtml(jdk.path)}</span>
      <span class="jdk-version">Java ${jdk.version}</span>
    `;
    list.appendChild(item);
  });
}

// ─── Duplicate Server ─────────────────────────────────────────────────────────
function openDuplicateServerModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('dup-name').value = `Copy of ${srv.name}`;
  closeModal('modal-server-settings');
  openModal('modal-duplicate-server');
}

async function executeDuplicateServer() {
  const newName = document.getElementById('dup-name').value.trim();
  if (!newName) { toast('Please enter a name', 'error'); return; }
  const btn = document.getElementById('dup-submit');
  btn.disabled = true; btn.textContent = 'Duplicating…';
  closeModal('modal-duplicate-server');
  document.getElementById('modal-download-title').textContent = 'Duplicating Server';
  openModal('modal-download');
  const r = await window.mcpanel.duplicateServer(currentServerId, newName);
  closeModal('modal-download');
  document.getElementById('modal-download-title').textContent = 'Creating Server';
  btn.disabled = false; btn.textContent = 'Duplicate';
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  config.servers.push(r.server);
  renderServersGrid();
  renderSidebarServers();
  toast(`Server "${newName}" duplicated!`, 'success');
}

// ─── Create Profile from Server ───────────────────────────────────────────────
const FTREE_SELECTED_DEFAULTS = new Set(['mods', 'plugins']);

async function openCreateProfileFromServerModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('pfs-name').value = srv.name + ' Profile';
  document.getElementById('pfs-desc').value = '';
  document.getElementById('pfs-versions').value = '';
  document.querySelectorAll('#pfs-software-checks input').forEach(cb => cb.checked = false);
  document.getElementById('pfs-submit').disabled = false;
  document.getElementById('pfs-submit').textContent = 'Create Profile';
  closeModal('modal-server-settings');
  openModal('modal-profile-from-server');
  const ftreeEl = document.getElementById('pfs-ftree');
  ftreeEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">Loading files…</div>`;
  const r = await window.mcpanel.getServerFileTree(currentServerId);
  ftreeEl.innerHTML = '';
  if (r.error) {
    ftreeEl.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">${escapeHtml(r.error)}</div>`;
    return;
  }
  if (!r.tree || r.tree.length === 0) {
    ftreeEl.innerHTML = `<div style="padding:24px;color:var(--text-muted);font-size:12px">No files found.</div>`;
    return;
  }
  r.tree.forEach(node => ftreeEl.appendChild(buildFtreeNode(node, 0, false)));
}

function buildFtreeNode(node, depth, parentSelected) {
  const selected = parentSelected || FTREE_SELECTED_DEFAULTS.has(node.name);
  const wrap = document.createElement('div');

  if (node.type === 'dir') {
    const row = document.createElement('div');
    row.className = 'ftree-item';
    row.style.paddingLeft = `${depth * 16 + 6}px`;

    const toggle = document.createElement('button');
    toggle.className = 'ftree-toggle';
    toggle.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`;

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ftree-check';
    cb.dataset.path = node.path; cb.dataset.ftype = 'dir';
    cb.checked = selected;

    const icon = document.createElement('span');
    icon.className = 'ftree-icon';
    icon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

    const label = document.createElement('span');
    label.className = 'ftree-name dir';
    label.textContent = node.name;

    row.append(toggle, cb, icon, label);

    const children = document.createElement('div');
    children.className = 'ftree-children';
    children.style.display = 'none'; // always start collapsed
    node.children.forEach(child => children.appendChild(buildFtreeNode(child, depth + 1, selected)));

    toggle.onclick = () => {
      const collapsed = children.style.display === 'none';
      children.style.display = collapsed ? '' : 'none';
      toggle.style.transform = collapsed ? 'rotate(90deg)' : '';
    };

    cb.onchange = () => {
      children.querySelectorAll('.ftree-check').forEach(c => { c.checked = cb.checked; c.indeterminate = false; });
    };
    children.addEventListener('change', () => ftreeSyncParent(cb, children));

    wrap.append(row, children);
  } else {
    const row = document.createElement('div');
    row.className = 'ftree-item';
    row.style.paddingLeft = `${depth * 16 + 22}px`;

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ftree-check';
    cb.dataset.path = node.path; cb.dataset.ftype = 'file';
    cb.checked = selected;

    const icon = document.createElement('span');
    icon.className = 'ftree-icon';
    icon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

    const label = document.createElement('span');
    label.className = 'ftree-name';
    label.textContent = node.name;

    const size = document.createElement('span');
    size.className = 'ftree-size';
    size.textContent = formatBytes(node.size);

    row.append(cb, icon, label, size);
    wrap.appendChild(row);
  }
  return wrap;
}

function ftreeSyncParent(parentCb, childrenEl) {
  const all = Array.from(childrenEl.querySelectorAll(':scope > div > .ftree-item > .ftree-check'));
  if (!all.length) return;
  const checked = all.filter(c => c.checked && !c.indeterminate).length;
  const indeterminate = all.some(c => c.indeterminate) || (checked > 0 && checked < all.length);
  parentCb.indeterminate = indeterminate;
  parentCb.checked = indeterminate ? true : checked === all.length;
}

function ftreeSelectAll() {
  document.querySelectorAll('#pfs-ftree .ftree-check').forEach(cb => { cb.checked = true; cb.indeterminate = false; });
}

function ftreeSelectNone() {
  document.querySelectorAll('#pfs-ftree .ftree-check').forEach(cb => { cb.checked = false; cb.indeterminate = false; });
}

async function submitCreateProfileFromServer() {
  const name = document.getElementById('pfs-name').value.trim();
  if (!name) { toast('Please enter a profile name', 'error'); return; }
  const selectedPaths = Array.from(document.querySelectorAll('#pfs-ftree .ftree-check[data-ftype="file"]:checked'))
    .map(cb => cb.dataset.path);
  if (selectedPaths.length === 0) { toast('Select at least one file', 'error'); return; }
  const btn = document.getElementById('pfs-submit');
  btn.disabled = true; btn.textContent = 'Creating…';
  const software = Array.from(document.querySelectorAll('#pfs-software-checks input:checked')).map(cb => cb.value);
  const versionsRaw = document.getElementById('pfs-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];
  const r = await window.mcpanel.createProfileFromServer(
    currentServerId,
    { name, description: document.getElementById('pfs-desc').value.trim(), software, versions },
    selectedPaths
  );
  btn.disabled = false; btn.textContent = 'Create Profile';
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  profiles.push(r.profile);
  closeModal('modal-profile-from-server');
  toast(`Profile "${name}" created!`, 'success');
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      const id = overlay.id;
      if (id === 'modal-confirm') { resolveConfirmDialog(false); return; }
      if (id !== 'modal-download' && id !== 'modal-cli-missing' && id !== 'modal-buildtools-missing') closeModal(id);
    }
  });
});

// ─── Confirm dialog ───────────────────────────────────────────────────────────
// Every destructive action goes through this instead of window.confirm(), so
// deletions look like the rest of the app. Returns a promise resolving to
// true only when the user hits the confirm button.
let _confirmResolve = null;

function confirmDialog({ title = 'Confirm', message = '', confirmLabel = 'Delete' } = {}) {
  // A second dialog while one is open would orphan the first promise.
  if (_confirmResolve) resolveConfirmDialog(false);
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-ok').textContent = confirmLabel;
  openModal('modal-confirm');
  return new Promise(resolve => { _confirmResolve = resolve; });
}

function resolveConfirmDialog(ok) {
  closeModal('modal-confirm');
  const resolve = _confirmResolve;
  _confirmResolve = null;
  if (resolve) resolve(ok);
}

// Escape cancels. Enter is deliberately not bound: key auto-repeat from
// whatever opened the dialog could confirm a delete the user never read.
document.addEventListener('keydown', e => {
  if (_confirmResolve && e.key === 'Escape') resolveConfirmDialog(false);
});

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0'; el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function capitalise(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function stripCpuName(full) {
  if (!full || full === 'Unknown CPU') return full;
  return full
    .replace(/\(R\)/g, '').replace(/\(TM\)/g, '')
    .replace(/\bCPU\b\s*/g, '')                      // drop bare "CPU" word, keep clock speed
    .replace(/\s+\d+-Core\s+Processor.*/i, '')
    .replace(/\s+\d+-Core.*/i, '')
    .replace(/\s+Processor\b.*/i, '')
    .replace(/\s+/g, ' ').trim();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

// ─── Themes ───────────────────────────────────────────────────────────────────
let installedThemes = [];

const BUILTIN_THEMES = ['purple-dark', 'clean-dark', 'dark-slate', 'bright-slate'];

async function ensureBuiltinThemes() {
  await window.mcpanel.ensureBuiltinThemes();
}

async function loadAndApplyTheme(id) {
  const styleEl = document.getElementById('theme-override');
  if (!id) {
    styleEl.textContent = '';
    return;
  }
  const css = await window.mcpanel.getThemeCss(id);
  styleEl.textContent = css || '';
}

async function applyTheme(id) {
  await loadAndApplyTheme(id);
  config.activeTheme = id;
  await window.mcpanel.saveConfig(config);
  const defaultId = await window.mcpanel.getDefaultTheme();
  const theme = installedThemes.find(t => t.id === id);
  document.getElementById('active-theme-name').textContent = theme ? theme.name : id;
  document.getElementById('reset-theme-btn').style.display = id !== defaultId ? '' : 'none';
  renderInstalledThemes();
  // A theme may hint an icon via --app-icon; re-resolve if the user is on Auto.
  applyAppIcon();
  renderAppIconPicker();
  window.mcpanel.logEvent(`Applied theme: ${theme?.name || id}`);
  toast(`Theme "${theme?.name || id}" applied`, 'success');
}

async function resetTheme() {
  const defaultId = await window.mcpanel.getDefaultTheme();
  await loadAndApplyTheme(defaultId);
  config.activeTheme = defaultId;
  await window.mcpanel.saveConfig(config);
  const themes = await window.mcpanel.getThemes();
  const theme = themes.find(t => t.id === defaultId);
  document.getElementById('active-theme-name').textContent = theme ? theme.name : defaultId;
  document.getElementById('reset-theme-btn').style.display = 'none';
  renderInstalledThemes();
  applyAppIcon();
  renderAppIconPicker();
  toast('Theme reset to default', 'info');
}

async function renderInstalledThemes() {
  installedThemes = await window.mcpanel.getThemes();
  const container = document.getElementById('installed-themes-list');
  if (!container) return;
  container.innerHTML = '';

  if (installedThemes.length === 0) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No themes installed. Browse online or import a ZIP.</div>`;
    return;
  }

  installedThemes.forEach(theme => {
    const isActive = config.activeTheme === theme.id;
    const item = document.createElement('div');
    item.className = `installed-theme-item${isActive ? ' active-theme' : ''}`;

    const creatorHtml = theme.creatorUrl
      ? `<a href="#" onclick="window.mcpanel.openExternal('${escapeHtml(theme.creatorUrl)}');return false" style="color:var(--accent)">${escapeHtml(theme.creator || 'Unknown')}</a>`
      : escapeHtml(theme.creator || 'Unknown');

    item.innerHTML = `
      <div class="theme-item-info">
        <div class="theme-item-name">${escapeHtml(theme.name)}${isActive ? ' <span style="font-size:10px;color:var(--accent);font-weight:400">(active)</span>' : ''}</div>
        <div class="theme-item-meta">by ${creatorHtml} · v${escapeHtml(theme.version || '?')} · for MCPanel ${escapeHtml(theme.appVersion || '?')}</div>
        ${theme.description ? `<div class="theme-item-meta" style="margin-top:2px">${escapeHtml(theme.description)}</div>` : ''}
      </div>
      <div class="theme-item-actions">
        ${!isActive ? `<button class="btn-xs" style="color:var(--accent);border-color:rgba(168,85,247,0.3)" onclick="applyTheme('${theme.id}')">Apply</button>` : ''}
        ${!theme.builtin ? `<button class="btn-xs" style="color:var(--red);border-color:rgba(239,68,68,0.25)" onclick="confirmDeleteTheme('${theme.id}')">Delete</button>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

async function confirmDeleteTheme(id) {
  const theme = installedThemes.find(t => t.id === id);
  const ok = await confirmDialog({
    title: 'Delete Theme',
    message: `Delete the theme "${theme?.name || id}"?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Theme',
  });
  if (!ok) return;
  const r = await window.mcpanel.deleteTheme(id);
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  if (config.activeTheme === id) await resetTheme();
  await renderInstalledThemes();
  toast('Theme deleted', 'info');
}

async function importThemeFromFile() {
  const filePath = await window.mcpanel.browseThemeFile();
  if (!filePath) return;
  toast('Installing theme…', 'info');
  const r = await window.mcpanel.installThemeFile(filePath);
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  await renderInstalledThemes();
  toast(`Theme "${r.theme.name}" installed!`, 'success');
}

function openThemeUrlModal() {
  document.getElementById('theme-url-input').value = '';
  openModal('modal-theme-url');
}

async function installThemeFromUrl() {
  const url = document.getElementById('theme-url-input').value.trim();
  if (!url) { toast('Please enter a URL', 'error'); return; }

  const btn = document.getElementById('theme-url-submit');
  btn.disabled = true; btn.textContent = 'Installing…';

  const r = await window.mcpanel.installThemeUrl(url);

  btn.disabled = false; btn.textContent = 'Install';

  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  closeModal('modal-theme-url');
  await renderInstalledThemes();
  toast(`Theme "${r.theme.name}" installed!`, 'success');
}

async function openThemeBrowser() {
  openModal('modal-theme-browser');
  const content = document.getElementById('theme-browser-content');
  content.innerHTML = `<div style="text-align:center;padding:40px 0;color:var(--text-muted)">Fetching themes from GitHub…</div>`;

  const r = await window.mcpanel.fetchGithubThemes();

  if (!r.themes || r.themes.length === 0) {
    content.innerHTML = `
      <div class="theme-browser-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <p>No online themes available yet.</p>
        <p style="margin-top:6px;font-size:11px">Import a local ZIP or install from a direct URL instead.</p>
      </div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'theme-browser-grid';

  r.themes.forEach(theme => {
    const card = document.createElement('div');
    card.className = 'theme-browser-card';

    const creatorHtml = theme.creatorUrl
      ? `<a href="#" onclick="window.mcpanel.openExternal('${escapeHtml(theme.creatorUrl)}');return false" style="color:var(--accent)">${escapeHtml(theme.creator || 'Unknown')}</a>`
      : escapeHtml(theme.creator || 'Unknown');

    card.innerHTML = `
      <div class="theme-browser-card-name">${escapeHtml(theme.name)}</div>
      <div class="theme-browser-card-by">by ${creatorHtml}</div>
      <div class="theme-browser-card-desc">${escapeHtml(theme.description || '')}</div>
      <div class="theme-browser-card-footer">
        <span class="theme-version-tag">v${escapeHtml(theme.version || '?')} · MCPanel ${escapeHtml(theme.appVersion || '?')}</span>
        <button class="btn-sm" onclick="installOnlineTheme('${escapeHtml(theme.downloadUrl)}', this)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Install
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  content.innerHTML = '';
  content.appendChild(grid);
}

async function installOnlineTheme(url, btn) {
  btn.disabled = true; btn.textContent = 'Installing…';
  const r = await window.mcpanel.installThemeUrl(url);
  if (r.error) {
    btn.disabled = false; btn.textContent = 'Install';
    toast('Error: ' + r.error, 'error');
    return;
  }
  btn.textContent = 'Installed';
  await renderInstalledThemes();
  toast(`Theme "${r.theme.name}" installed!`, 'success');
}

// ─── Embedded Terminal ────────────────────────────────────────────────────────
let _term = null;
let _termFit = null;
let _ptyUnlisten = null;
let _ptyClosedUnlisten = null;

async function openTerminal() {
  openModal('modal-terminal');
  const container = document.getElementById('terminal-container');

  if (!_term) {
    _term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: {
        background: '#0a0a10',
        foreground: '#f0eeff',
        cursor: '#a855f7',
        selectionBackground: 'rgba(168,85,247,0.3)',
        black: '#000000', red: '#ff6b6b', green: '#22c55e', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#a855f7', cyan: '#22d3ee', white: '#cccccc',
        brightBlack: '#666666', brightRed: '#ff8888', brightGreen: '#55ff77',
        brightYellow: '#ffff55', brightBlue: '#7cb9ff', brightMagenta: '#c084fc',
        brightCyan: '#55ffff', brightWhite: '#ffffff',
      },
    });
    if (window.FitAddon) {
      _termFit = new FitAddon.FitAddon();
      _term.loadAddon(_termFit);
    }
    _term.open(container);
    if (_termFit) _termFit.fit();
    // Ctrl+Shift+C copies the selection instead of sending ^C to the shell.
    _term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = _term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false; // handled — don't forward to the PTY
      }
      return true;
    });
    _term.onData(data => window.__TAURI_INTERNALS__.invoke('pty_write', { data }).catch(() => {}));
    _term.onResize(({ rows, cols }) => {
      window.__TAURI_INTERNALS__.invoke('pty_resize', { rows, cols }).catch(() => {});
    });
    window.addEventListener('resize', () => { if (_termFit) _termFit.fit(); });
  }

  if (_ptyUnlisten) { _ptyUnlisten(); _ptyUnlisten = null; }
  if (_ptyClosedUnlisten) { _ptyClosedUnlisten(); _ptyClosedUnlisten = null; }

  try {
    await window.__TAURI_INTERNALS__.invoke('pty_open');
    _ptyUnlisten = await window.__TAURI__.event.listen('pty-data', e => _term.write(e.payload));
    _ptyClosedUnlisten = await window.__TAURI__.event.listen('pty-closed', () => {
      _term.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n');
    });
    setTimeout(() => {
      if (_termFit) _termFit.fit();
      if (_term) window.__TAURI_INTERNALS__.invoke('pty_resize', { rows: _term.rows, cols: _term.cols }).catch(() => {});
      _term.focus();
    }, 50);
  } catch (e) {
    toast('Failed to open terminal: ' + String(e), 'error');
    closeModal('modal-terminal');
  }
}

function closeTerminal() {
  if (_ptyUnlisten) { _ptyUnlisten(); _ptyUnlisten = null; }
  if (_ptyClosedUnlisten) { _ptyClosedUnlisten(); _ptyClosedUnlisten = null; }
  window.__TAURI_INTERNALS__.invoke('pty_close').catch(() => {});
  closeModal('modal-terminal');
}

// ─── First Start ─────────────────────────────────────────────────────────────
function openFirstStart() {
  openModal('modal-first-start');
}

async function dismissFirstStart() {
  closeModal('modal-first-start');
  if (!config.firstStartDone) {
    config.firstStartDone = true;
    await window.mcpanel.saveConfig(config);
  }
}

// ─── Sidebar Stats ───────────────────────────────────────────────────────────
async function updateSidebarStats() {
  const serversEl    = document.getElementById('stat-servers');
  const ramEl        = document.getElementById('stat-ram');
  const ramBar       = document.getElementById('stat-ram-bar');
  const cpuEl        = document.getElementById('stat-cpu');
  const cpuBar       = document.getElementById('stat-cpu-bar');
  const storageEl    = document.getElementById('stat-storage');
  const storageBar   = document.getElementById('stat-storage-bar');

  const total  = config.servers.length;
  const online = Object.keys(serverStartTimes).length;
  if (serversEl) serversEl.textContent = `${online} / ${total}`;

  try {
    const stats = await window.mcpanel.getSystemStats();
    if (stats && !stats.error) {
      const ramPct = stats.totalRam > 0 ? Math.round((stats.usedRam / stats.totalRam) * 100) : 0;
      if (ramEl)  ramEl.textContent = `${ramPct}%`;
      if (ramBar) {
        ramBar.style.width = ramPct + '%';
        ramBar.className = 'sidebar-stat-bar-fill' +
          (ramPct > 85 ? ' bar-danger' : ramPct > 65 ? ' bar-warn' : '');
      }
      const cpuPct = Math.min(stats.cpuPct, 100);
      if (cpuEl)  cpuEl.textContent = `${cpuPct}%`;
      if (cpuBar) {
        cpuBar.style.width = cpuPct + '%';
        cpuBar.className = 'sidebar-stat-bar-fill' +
          (cpuPct > 85 ? ' bar-danger' : cpuPct > 65 ? ' bar-warn' : '');
      }
    }
  } catch {}

  if (systemInfo && systemInfo.totalStorage > 0) {
    const used = systemInfo.totalStorage - (systemInfo.availableStorage || 0);
    const pct  = Math.round((used / systemInfo.totalStorage) * 100);
    const GB = 1024 ** 3, TB = 1024 ** 4;
    const useTB = systemInfo.totalStorage >= TB;
    const div   = useTB ? TB : GB;
    const unit  = useTB ? 'TB' : 'GB';
    const fmt   = useTB ? 2 : 1;
    if (storageEl) storageEl.textContent =
      `${(used / div).toFixed(fmt)}/${(systemInfo.totalStorage / div).toFixed(fmt)}${unit}`;
    if (storageBar) {
      storageBar.style.width = pct + '%';
      storageBar.className = 'sidebar-stat-bar-fill' +
        (pct > 85 ? ' bar-danger' : pct > 65 ? ' bar-warn' : '');
    }
  }

  updateServersPageStats();
}

async function updateServersPageStats() {
  const CIRC = 402.12; // 2π × 64

  function setCircle(arcId, pct, colorClass) {
    const arc = document.getElementById(arcId);
    if (!arc) return;
    arc.style.strokeDashoffset = CIRC * (1 - Math.min(Math.max(pct, 0), 100) / 100);
    arc.className = 'stat-circle-arc' + (colorClass ? ' ' + colorClass : '');
  }

  // Servers
  const total  = config.servers.length;
  const online = Object.keys(serverStartTimes).length;
  const offline = total - online;
  const serversOnlineEl    = document.getElementById('sco-servers-online');
  const serversOfflineEl   = document.getElementById('sco-servers-offline');
  const serversDetOnlineEl = document.getElementById('sco-servers-detail-online');
  const serversDetOfflineEl= document.getElementById('sco-servers-detail-offline');
  if (serversOnlineEl)     serversOnlineEl.textContent     = online;
  if (serversOfflineEl)    serversOfflineEl.textContent    = offline;
  if (serversDetOnlineEl)  serversDetOnlineEl.textContent  = `${online} online`;
  if (serversDetOfflineEl) serversDetOfflineEl.textContent = `${offline} offline`;
  setCircle('sco-servers-arc', total > 0 ? (online / total) * 100 : 0, 'arc-green');

  // RAM & CPU
  try {
    const stats = await window.mcpanel.getSystemStats();
    if (stats && !stats.error) {
      systemCpu = { threads: stats.cpuThreads ?? null, cores: stats.cpuCores ?? null, freqMhz: stats.cpuFreqMhz ?? null, name: stats.cpuName ?? null };
      const ramPct = stats.totalRam > 0 ? Math.round((stats.usedRam / stats.totalRam) * 100) : 0;
      const ramValEl  = document.getElementById('sco-ram-val');
      const ramDetEl  = document.getElementById('sco-ram-detail');
      if (ramValEl) ramValEl.textContent = `${ramPct}%`;
      if (ramDetEl) ramDetEl.textContent = `${formatBytes(stats.usedRam)} / ${formatBytes(stats.totalRam)}`;
      setCircle('sco-ram-arc', ramPct, ramPct > 85 ? 'arc-danger' : ramPct > 65 ? 'arc-warn' : '');

      const cpuPct = Math.min(Math.round(stats.cpuPct), 100);
      const cpuValEl   = document.getElementById('sco-cpu-val');
      const cpuNameEl  = document.getElementById('sco-cpu-name');
      const cpuCoresEl = document.getElementById('sco-cpu-cores');
      if (cpuValEl)   cpuValEl.textContent   = `${cpuPct}%`;
      const cpuFreq = stats.cpuFreqMhz || 0;
      const cpuFreqStr = cpuFreq >= 1000
        ? `${(cpuFreq / 1000).toFixed(2)} GHz`
        : cpuFreq > 0 ? `${Math.round(cpuFreq)} MHz` : '';
      const cpuTooltip = [stats.cpuName, cpuFreqStr ? `@ ${cpuFreqStr}` : ''].filter(Boolean).join(' ');
      if (cpuNameEl)  { cpuNameEl.textContent = stripCpuName(stats.cpuName) || '-'; cpuNameEl.title = cpuTooltip; }
      if (cpuCoresEl) {
        cpuCoresEl.textContent = stats.cpuCores != null
          ? `${stats.cpuCores}C / ${stats.cpuThreads}T`
          : '-';
        cpuCoresEl.title = cpuTooltip;
      }
      const cpuCardEl = document.getElementById('sco-cpu-card');
      if (cpuCardEl) cpuCardEl.title = cpuTooltip;
      setCircle('sco-cpu-arc', cpuPct, cpuPct > 85 ? 'arc-danger' : cpuPct > 65 ? 'arc-warn' : '');
    }
  } catch {}

  // Storage
  if (systemInfo && systemInfo.totalStorage > 0) {
    const used = systemInfo.totalStorage - (systemInfo.availableStorage || 0);
    const pct  = Math.round((used / systemInfo.totalStorage) * 100);
    const storageValEl = document.getElementById('sco-storage-val');
    const storageDetEl = document.getElementById('sco-storage-detail');
    if (storageValEl) storageValEl.textContent = `${pct}%`;
    if (storageDetEl) storageDetEl.textContent = `${formatBytes(used)} / ${formatBytes(systemInfo.totalStorage)}`;
    setCircle('sco-storage-arc', pct, pct > 85 ? 'arc-danger' : pct > 65 ? 'arc-warn' : '');
  }

  // Players
  let totalPlayers = 0, totalMaxPlayers = 0, velocityPlayers = 0, inGamePlayers = 0;
  for (const d of Object.values(serverPlayerData)) {
    totalPlayers    += d.players    || 0;
    totalMaxPlayers += d.maxPlayers || 0;
    if (d.isVelocity) velocityPlayers += d.players || 0;
    else              inGamePlayers   += d.players || 0;
  }
  const hasVelocityServer = config.servers.some(s => s.software === 'velocity');
  const playersOnlineEl   = document.getElementById('sco-players-online');
  const playersMaxEl      = document.getElementById('sco-players-max');
  const playersIngameEl   = document.getElementById('sco-players-detail-ingame');
  const playersVelocityEl = document.getElementById('sco-players-detail-velocity');
  if (playersOnlineEl) playersOnlineEl.textContent = totalPlayers;
  if (playersMaxEl)    playersMaxEl.textContent    = totalMaxPlayers;
  if (playersIngameEl) playersIngameEl.textContent = `${inGamePlayers} ingame`;
  if (playersVelocityEl) {
    playersVelocityEl.textContent = `${velocityPlayers} velocity`;
    playersVelocityEl.classList.toggle('hidden', !hasVelocityServer);
  }
  const playersPct = totalMaxPlayers > 0 ? (totalPlayers / totalMaxPlayers) * 100 : 0;
  setCircle('sco-players-arc', playersPct, '');
}

// ─── Velocity ────────────────────────────────────────────────────────────────
async function copyVelocitySecret() {
  if (!currentServerId) return;
  try {
    const result = await window.mcpanel.getVelocitySecret(currentServerId);
    if (result && result.secret) {
      await navigator.clipboard.writeText(result.secret);
      toast('Forwarding secret copied!', 'success');
    } else {
      toast(result?.error || 'Forwarding secret not found', 'error');
    }
  } catch {
    toast('Failed to read forwarding secret', 'error');
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
window._cliReady.then(ok => {
  if (ok) {
    init();
  } else {
    // CLI missing: skip full init, but still apply the default theme so the
    // app isn't unstyled behind the "CLI not found" modal. Theme handling is
    // entirely Rust-native and doesn't touch the CLI.
    applyDefaultThemeNoCli();
  }
});

async function applyDefaultThemeNoCli() {
  try {
    await ensureBuiltinThemes();
    const defaultThemeId = await window.mcpanel.getDefaultTheme();
    await loadAndApplyTheme(defaultThemeId);
  } catch (e) {
    console.error('Failed to apply default theme without CLI:', e);
  }
}

// ─── Font Settings ────────────────────────────────────────────────────────────

async function populateFontLists(currentFonts) {
  const BUNDLED_DISPLAY = ['Poppins', 'system-ui'];
  const BUNDLED_MONO = ['JetBrains Mono', 'monospace'];
  const display = currentFonts?.display || 'Poppins';
  const mono = currentFonts?.mono || 'JetBrains Mono';

  let systemFonts = [];
  try { systemFonts = await window.mcpanel.listSystemFonts(); } catch (_) {}

  function fillSelect(id, bundled, all, selected) {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '';
    const seen = new Set();
    const bundledSet = new Set(bundled);
    const all_fonts = [...bundled, selected, ...all].filter(Boolean);
    for (const f of all_fonts) {
      if (seen.has(f)) continue;
      seen.add(f);
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = bundledSet.has(f) ? `${f} (built-in)` : f;
      if (f === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  fillSelect('font-display-select', BUNDLED_DISPLAY, systemFonts, display);
  fillSelect('font-mono-select', BUNDLED_MONO, systemFonts, mono);
  _syncWeightSelects(currentFonts);
  applyFontPreview();
}

function _syncWeightSelects(fonts) {
  const dw = document.getElementById('font-display-weight');
  const mw = document.getElementById('font-mono-weight');
  if (dw) dw.value = fonts?.displayWeight || '400';
  if (mw) mw.value = fonts?.monoWeight || '400';
}

function _getDisplayFontValue() {
  const sel = document.getElementById('font-display-select');
  return (sel && sel.value) || 'Poppins';
}

function _getMonoFontValue() {
  const sel = document.getElementById('font-mono-select');
  return (sel && sel.value) || 'JetBrains Mono';
}

function _getDisplayWeightValue() {
  const sel = document.getElementById('font-display-weight');
  return (sel && sel.value) || '400';
}

function _getMonoWeightValue() {
  const sel = document.getElementById('font-mono-weight');
  return (sel && sel.value) || '400';
}

function _syncFontSelects(fonts) {
  const dSel = document.getElementById('font-display-select');
  const mSel = document.getElementById('font-mono-select');
  if (dSel) dSel.value = fonts?.display || 'Poppins';
  if (mSel) mSel.value = fonts?.mono || 'JetBrains Mono';
  _syncWeightSelects(fonts);
  applyFontPreview();
}

function applyFontSettings(fonts) {
  const display = fonts.display || 'Poppins';
  const mono = fonts.mono || 'JetBrains Mono';
  const dw = fonts.displayWeight || '400';
  const mw = fonts.monoWeight || '400';
  let el = document.getElementById('font-override');
  if (!el) { el = document.createElement('style'); el.id = 'font-override'; document.head.appendChild(el); }
  el.textContent = `:root { --font-display: '${display}', system-ui, -apple-system, 'Segoe UI', sans-serif; --font-mono: '${mono}', 'Cascadia Code', Consolas, monospace; --font-display-weight: ${dw}; --font-mono-weight: ${mw}; }`;
}

function applyFontPreview() {
  const display = _getDisplayFontValue();
  const mono = _getMonoFontValue();
  const dw = _getDisplayWeightValue();
  const mw = _getMonoWeightValue();
  const dEl = document.getElementById('font-preview-display');
  const mEl = document.getElementById('font-preview-mono');
  if (dEl) { dEl.style.fontFamily = `'${display}', system-ui, sans-serif`; dEl.style.fontWeight = dw; }
  if (mEl) { mEl.style.fontFamily = `'${mono}', monospace`; mEl.style.fontWeight = mw; }
}

async function saveFontSettings() {
  const fonts = { display: _getDisplayFontValue(), displayWeight: _getDisplayWeightValue(), mono: _getMonoFontValue(), monoWeight: _getMonoWeightValue() };
  _appSettings.fonts = fonts;
  await window.mcpanel.saveAppSettings(_appSettings);
  applyFontSettings(fonts);
  toast('Fonts applied');
}

async function resetFontSettings() {
  const fonts = { display: 'Poppins', displayWeight: '400', mono: 'JetBrains Mono', monoWeight: '400' };
  _appSettings.fonts = fonts;
  await window.mcpanel.saveAppSettings(_appSettings);
  applyFontSettings(fonts);
  _syncFontSelects(fonts);
  toast('Fonts reset to default');
}

// ─── Backups ──────────────────────────────────────────────────────────────────

let backupProgressListener = null;

async function openBackupsTab() {
  if (!currentServerId) return;
  await loadBackupList();
}

async function loadBackupList() {
  const res = await window.mcpanel.listBackups(currentServerId);
  const list = document.getElementById('backup-list');
  const empty = document.getElementById('backup-empty');
  const backups = res.backups || [];

  const cards = list.querySelectorAll('.backup-entry');
  cards.forEach(c => c.remove());

  if (backups.length === 0) {
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    backups.forEach(b => {
      const el = document.createElement('div');
      el.className = 'backup-entry';
      el.innerHTML = `
        <div class="backup-entry-info">
          <span class="backup-entry-name">${b.name}</span>
          <span class="backup-entry-meta">${formatBytes(b.size)} &bull; ${formatDate(b.created)}</span>
        </div>
        <div class="backup-entry-actions">
          <button class="btn-sm" onclick="restoreBackup('${b.name}')">Restore</button>
          <button class="btn-sm btn-danger-sm" onclick="deleteBackup('${b.name}')">Delete</button>
        </div>
      `;
      list.appendChild(el);
    });
  }
}

async function createBackup() {
  if (!currentServerId) return;
  const btn = document.getElementById('backup-create-btn');
  const wrap = document.getElementById('backup-progress-wrap');
  const fill = document.getElementById('backup-progress-fill');
  const text = document.getElementById('backup-progress-text');

  btn.disabled = true;
  wrap.classList.remove('hidden');
  fill.style.width = '0%';
  text.textContent = 'Starting…';

  if (backupProgressListener) {
    await window.mcpanel.off('backup-progress', backupProgressListener);
  }
  backupProgressListener = (ev) => {
    if (ev.payload && ev.payload.id === currentServerId) {
      fill.style.width = ev.payload.progress + '%';
      text.textContent = ev.payload.status;
    }
  };
  await window.mcpanel.on('backup-progress', backupProgressListener);

  try {
    const res = await window.mcpanel.createBackup(currentServerId);
    if (res.error) {
      toast('Backup failed: ' + res.error, 'error');
    } else {
      toast('Backup created successfully');
      await loadBackupList();
    }
  } finally {
    btn.disabled = false;
    setTimeout(() => wrap.classList.add('hidden'), 2000);
  }
}

async function deleteBackup(backupName) {
  if (!currentServerId) return;
  const ok = await confirmDialog({
    title: 'Delete Backup',
    message: `Delete the backup "${backupName}"?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Backup',
  });
  if (!ok) return;
  const res = await window.mcpanel.deleteBackup(currentServerId, backupName);
  if (res.error) { toast('Failed to delete backup: ' + res.error, 'error'); return; }
  toast('Backup deleted');
  await loadBackupList();
}

async function restoreBackup(backupName) {
  if (!currentServerId) return;
  const ok = await confirmDialog({
    title: 'Restore Backup',
    message: `Restore from "${backupName}"?\n\nThis overwrites the current server files and cannot be undone. Stop the server first if it is running.`,
    confirmLabel: 'Restore',
  });
  if (!ok) return;
  const wrap = document.getElementById('backup-progress-wrap');
  const fill = document.getElementById('backup-progress-fill');
  const text = document.getElementById('backup-progress-text');

  wrap.classList.remove('hidden');
  fill.style.width = '10%';
  text.textContent = 'Restoring…';

  if (backupProgressListener) {
    await window.mcpanel.off('backup-progress', backupProgressListener);
  }
  backupProgressListener = (ev) => {
    if (ev.payload && ev.payload.id === currentServerId) {
      fill.style.width = ev.payload.progress + '%';
      text.textContent = ev.payload.status;
    }
  };
  await window.mcpanel.on('backup-progress', backupProgressListener);

  const res = await window.mcpanel.restoreBackup(currentServerId, backupName);
  if (res.error) {
    toast('Restore failed: ' + res.error, 'error');
  } else {
    toast('Restore complete');
  }
  setTimeout(() => wrap.classList.add('hidden'), 2000);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

// ─── Schedules ────────────────────────────────────────────────────────────────

let _editingScheduleId = null;

async function openScheduleTab() {
  if (!currentServerId) return;
  await loadScheduleList();
}

async function loadScheduleList() {
  const res = await window.mcpanel.getSchedules(currentServerId);
  const list = document.getElementById('schedule-list');
  const empty = document.getElementById('schedule-empty');
  const schedules = res.schedules || [];

  const cards = list.querySelectorAll('.schedule-card');
  cards.forEach(c => c.remove());

  if (schedules.length === 0) {
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    schedules.forEach(s => {
      const el = document.createElement('div');
      el.className = 'schedule-card';
      const actionLabel = { restart: 'Restart', start: 'Start', stop: 'Stop', backup: 'Backup', command: 'Run Command' }[s.action] || s.action;
      const repeatStr = s.repeat ? `Every ${s.repeat_every} ${s.repeat_unit}` : 'Once';
      const nextStr = s.next_run ? formatDate(s.next_run) : 'Not set';
      el.innerHTML = `
        <div class="schedule-card-header">
          <div class="schedule-card-label">${s.label || actionLabel}</div>
          <div class="schedule-card-badges">
            <span class="schedule-badge">${actionLabel}</span>
            <span class="schedule-badge">${repeatStr}</span>
            ${!s.enabled ? '<span class="schedule-badge muted">Disabled</span>' : ''}
          </div>
        </div>
        ${s.action === 'command' && s.command ? `<div class="schedule-card-cmd"><code>${escHtml(s.command)}</code></div>` : ''}
        <div class="schedule-card-meta">Next: ${nextStr}</div>
        <div class="schedule-card-actions">
          <button class="btn-sm" onclick="runScheduleNow('${s.id}','${s.server_id}','${s.action}',${JSON.stringify(s.command||'')})">Run now</button>
          <button class="btn-sm" onclick="editSchedule(${JSON.stringify(s)})">Edit</button>
          <button class="btn-sm" onclick="toggleSchedule(${JSON.stringify(s)})">${s.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn-sm btn-danger-sm" onclick="deleteSchedule('${s.id}')">Delete</button>
        </div>
      `;
      list.appendChild(el);
    });
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openCreateScheduleModal() {
  _editingScheduleId = null;
  document.getElementById('schedule-modal-title').textContent = 'Add Scheduled Task';
  document.getElementById('sch-label').value = '';
  document.getElementById('sch-action').value = 'restart';
  document.getElementById('sch-command').value = '';
  document.getElementById('sch-repeat').checked = false;
  document.getElementById('sch-repeat-every').value = 1;
  document.getElementById('sch-repeat-unit').value = 'days';
  const now = new Date();
  document.getElementById('sch-date').value = now.toISOString().slice(0, 10);
  document.getElementById('sch-time').value = now.toTimeString().slice(0, 5);
  document.getElementById('sch-command-row').classList.add('hidden');
  document.getElementById('sch-repeat-row').classList.add('hidden');
  document.getElementById('sch-submit').textContent = 'Save Task';
  openModal('modal-create-schedule');
}

function editSchedule(s) {
  _editingScheduleId = s.id;
  document.getElementById('schedule-modal-title').textContent = 'Edit Scheduled Task';
  document.getElementById('sch-label').value = s.label || '';
  document.getElementById('sch-action').value = s.action || 'restart';
  document.getElementById('sch-command').value = s.command || '';
  document.getElementById('sch-repeat').checked = !!s.repeat;
  document.getElementById('sch-repeat-every').value = s.repeat_every || 1;
  document.getElementById('sch-repeat-unit').value = s.repeat_unit || 'days';
  const d = s.next_run ? new Date(s.next_run) : new Date();
  document.getElementById('sch-date').value = d.toISOString().slice(0, 10);
  document.getElementById('sch-time').value = d.toTimeString().slice(0, 5);
  document.getElementById('sch-command-row').classList.toggle('hidden', s.action !== 'command');
  document.getElementById('sch-repeat-row').classList.toggle('hidden', !s.repeat);
  document.getElementById('sch-submit').textContent = 'Update Task';
  openModal('modal-create-schedule');
}

function onScheduleActionChange() {
  const action = document.getElementById('sch-action').value;
  document.getElementById('sch-command-row').classList.toggle('hidden', action !== 'command');
}

function onScheduleRepeatChange() {
  const checked = document.getElementById('sch-repeat').checked;
  document.getElementById('sch-repeat-row').classList.toggle('hidden', !checked);
}

async function saveSchedule() {
  const label = document.getElementById('sch-label').value.trim();
  const action = document.getElementById('sch-action').value;
  const command = document.getElementById('sch-command').value.trim();
  const repeat = document.getElementById('sch-repeat').checked;
  const repeatEvery = parseInt(document.getElementById('sch-repeat-every').value) || 1;
  const repeatUnit = document.getElementById('sch-repeat-unit').value;
  const dateVal = document.getElementById('sch-date').value;
  const timeVal = document.getElementById('sch-time').value;

  if (!dateVal || !timeVal) { toast('Please set a date and time', 'error'); return; }
  const nextRun = new Date(`${dateVal}T${timeVal}`).getTime();
  if (isNaN(nextRun)) { toast('Invalid date/time', 'error'); return; }

  const schedule = {
    id: _editingScheduleId || ('sch_' + Date.now()),
    server_id: currentServerId,
    label,
    action,
    command,
    next_run: nextRun,
    repeat,
    repeat_every: repeatEvery,
    repeat_unit: repeatUnit,
    enabled: true,
    last_run: null,
  };

  const res = await window.mcpanel.saveSchedule(schedule);
  if (res.error) { toast('Failed to save schedule: ' + res.error, 'error'); return; }
  closeModal('modal-create-schedule');
  toast(_editingScheduleId ? 'Schedule updated' : 'Schedule created');
  await loadScheduleList();
}

async function deleteSchedule(scheduleId) {
  const ok = await confirmDialog({
    title: 'Delete Schedule',
    message: 'Delete this scheduled task?\n\nThis action cannot be undone.',
    confirmLabel: 'Delete Schedule',
  });
  if (!ok) return;
  const res = await window.mcpanel.deleteSchedule(scheduleId);
  if (res.error) { toast('Failed to delete schedule: ' + res.error, 'error'); return; }
  toast('Schedule deleted');
  await loadScheduleList();
}

async function toggleSchedule(s) {
  const updated = Object.assign({}, s, { enabled: !s.enabled });
  const res = await window.mcpanel.saveSchedule(updated);
  if (res.error) { toast('Failed to update schedule: ' + res.error, 'error'); return; }
  await loadScheduleList();
}

async function runScheduleNow(scheduleId, serverId, action, command) {
  const res = await window.mcpanel.runScheduleNow(serverId, action, command || null);
  if (res.error) { toast('Failed to run task: ' + res.error, 'error'); return; }
  toast('Task executed');
}
