/* ═══════════════════════════════════════════════════════
   MCPanel Frontend — app.js
   ═══════════════════════════════════════════════════════ */

let config = { servers: [], jdkPaths: [] };
let profiles = [];
let currentServerId = null;
let systemInfo = { totalRam: null, availableStorage: null, totalStorage: null };
let versionCache = {};
let statusPollInterval = null;
let uptimeInterval = null;
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

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  config = await window.mcpanel.getConfig();
  window.mcpanel.getSystemInfo().then(info => { systemInfo = info; });

  // Apply saved theme before rendering UI to avoid flash
  if (config.activeTheme) {
    await loadAndApplyTheme(config.activeTheme);
    const themes = await window.mcpanel.getThemes();
    const theme = themes.find(t => t.id === config.activeTheme);
    if (theme) {
      document.getElementById('active-theme-name').textContent = theme.name;
      document.getElementById('reset-theme-btn').style.display = '';
    } else {
      config.activeTheme = null;
    }
  }

  window.mcpanel.getVersion().then(v => {
    const el = document.getElementById('about-version');
    if (el) el.textContent = `MCPanel v${v} · Built for Minecraft server management`;
  });

  profiles = await window.mcpanel.getProfiles();
  renderServersGrid();
  renderSidebarServers();
  startStatusPolling();
  startUptimeTicker();
  setupConsoleScroll();

  // Event listeners
  window.mcpanel.on('server-stopped', ({ id }) => {
    startingServers.delete(id);
    delete serverStartTimes[id];
    const uptimeEl = document.getElementById(`uptime-${id}`);
    if (uptimeEl) uptimeEl.textContent = '—';
    if (id === currentServerId) {
      appendConsoleLine('Server stopped.', 'system');
      updateDetailControls(false);
      const detailUptime = document.getElementById('detail-uptime');
      if (detailUptime) detailUptime.textContent = '—';
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

  // File drag-drop + close notification via the Tauri window handle
  const _win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (_win?.listen) {
    _win.listen('tauri://drag-drop', async (event) => {
      if (!currentServerId) return;
      const pane = document.getElementById('pane-files');
      if (!pane || pane.classList.contains('hidden')) return;
      const paths = event.payload?.paths || [];
      if (!paths.length) return;
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

// ─── Window Close ────────────────────────────────────────────────────────────
function requestClose() {
  const runningIds = Object.keys(serverStartTimes);
  if (runningIds.length > 0) {
    const n = runningIds.length;
    const msg = `${n} server${n !== 1 ? 's are' : ' is'} still running in the background and will continue after MCPanel closes.\n\nClose MCPanel anyway?`;
    if (!confirm(msg)) return;
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
  switchDetailTab('console');
  const srv = config.servers.find(s => s.id === id);
  if (!srv) return;

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
  document.getElementById('detail-port').textContent = srv.port;
  setRamBar(0, srv.ram);

  // Quick settings
  document.getElementById('quick-port').value = srv.port;
  document.getElementById('quick-java-args').value = srv.javaArgs || '';
  document.getElementById('quick-java-path').value = srv.javaPath || 'java';
  document.getElementById('quick-group').value = srv.group || '';

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
    detailUptime.textContent = serverStartTimes[id] ? formatUptime(Date.now() - serverStartTimes[id]) : '—';
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
}

// ─── Servers Grid ─────────────────────────────────────────────────────────────
function renderServersGrid() {
  const grid = document.getElementById('servers-grid');
  const empty = document.getElementById('servers-empty');
  grid.querySelectorAll('.server-card, .group-header').forEach(c => c.remove());

  if (config.servers.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const hasGroups = config.servers.some(s => s.group);
  if (!hasGroups) {
    config.servers.forEach(srv => grid.appendChild(createServerCard(srv)));
    return;
  }

  const groups = {};
  const ungrouped = [];
  config.servers.forEach(srv => {
    if (srv.group) {
      if (!groups[srv.group]) groups[srv.group] = [];
      groups[srv.group].push(srv);
    } else {
      ungrouped.push(srv);
    }
  });

  Object.entries(groups).forEach(([groupName, servers]) => {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-name">${escapeHtml(groupName)}</span><span class="group-count">${servers.length} server${servers.length !== 1 ? 's' : ''}</span>`;
    grid.appendChild(header);
    servers.forEach(srv => grid.appendChild(createServerCard(srv)));
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
        <div class="stat-chip-value" id="players-${srv.id}">—</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Storage</div>
        <div class="stat-chip-value" id="storage-${srv.id}">${srv.storageLimit || '∞'}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Uptime</div>
        <div class="stat-chip-value" id="uptime-${srv.id}">—</div>
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
  if (playersEl) playersEl.textContent = online === true ? players : '—';
  if (startBtn) startBtn.style.display = online ? 'none' : '';
  if (stopBtn) stopBtn.style.display = online ? '' : 'none';
}

// ─── Sidebar Servers ──────────────────────────────────────────────────────────
function renderSidebarServers() {
  const container = document.getElementById('sidebar-servers');
  container.innerHTML = config.servers.length === 0
    ? `<div style="padding:12px;font-size:11px;color:var(--text-muted);text-align:center">No servers</div>`
    : '';
  config.servers.forEach(srv => {
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
  for (const srv of config.servers) {
    const running = await window.mcpanel.isServerRunning(srv.id);
    if (running) {
      const status = await window.mcpanel.pingServer('127.0.0.1', parseInt(srv.port));
      if (status && status.players != null) {
        if (!serverStartTimes[srv.id]) {
          const t = await window.mcpanel.getServerStartTime(srv.id);
          serverStartTimes[srv.id] = t || Date.now();
        }
        startingServers.delete(srv.id);
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
      if (serverStartTimes[srv.id]) {
        delete serverStartTimes[srv.id];
        const uptimeEl = document.getElementById(`uptime-${srv.id}`);
        if (uptimeEl) uptimeEl.textContent = '—';
        if (currentServerId === srv.id) {
          const detailUptime = document.getElementById('detail-uptime');
          if (detailUptime) detailUptime.textContent = '—';
        }
      }
      updateServerCardStatus(srv.id, false, 0);
      updateSidebarDot(srv.id, false);
      if (currentServerId === srv.id) {
        updateDetailControls(false);
        setRamBar(0, srv.ram);
        setPlayersBar(0, 0, false);
      }
    }
  }
}

// ─── EULA Flow ────────────────────────────────────────────────────────────────
async function startServerFlow(id) {
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

function updateDetailStarting() {
  const bigStatus = document.getElementById('big-status-badge');
  if (bigStatus) { bigStatus.className = 'big-status starting'; bigStatus.textContent = 'STARTING'; }
  setPlayersBar(0, 0, false);
  const listEl = document.getElementById('detail-player-list');
  if (listEl) listEl.style.display = 'none';
}

// ─── Detail Tabs ─────────────────────────────────────────────────────────────

function switchDetailTab(name) {
  ['console', 'files', 'settings'].forEach(t => {
    document.getElementById(`dtab-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-${t}`).classList.toggle('hidden', t !== name);
  });
  if (name === 'files') openFilesTab();
  if (name === 'settings') openSettingsTab();
}

// ─── File Browser ─────────────────────────────────────────────────────────────

let fileNavStack = [];   // stack of children arrays
let fileNavPaths = [];   // stack of name strings for breadcrumb
let cachedFileTree = null;

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
  const upBtn = document.getElementById('file-up-btn');

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

  upBtn.disabled = fileNavStack.length <= 1;

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
    });
    row.querySelector('.file-row-check').addEventListener('click', e => e.stopPropagation());
    row.querySelector('.rename-btn').addEventListener('click', e => { e.stopPropagation(); renameFileEntry(nodePath, node.name); });
    row.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (selectedFilePaths.size > 1 && selectedFilePaths.has(nodePath)) deleteSelectedFiles();
      else deleteFileEntry(nodePath, node.name, node.type === 'dir');
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
}

function fileBrowserUp() {
  if (fileNavStack.length > 1) {
    fileNavStack.pop();
    fileNavPaths.pop();
    renderFileBrowser();
  }
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
    textEl.textContent = `Done — ${done} file${done > 1 ? 's' : ''} uploaded`;
    toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`, 'success');
  } else {
    textEl.textContent = `${done} uploaded, ${errors} failed`;
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
    textEl.textContent = `Done — ${paths.length} file${paths.length !== 1 ? 's' : ''} uploaded`;
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

async function openFileEditor(relPath, name) {
  _editorRelPath = relPath;
  document.getElementById('file-editor-title').textContent = name;
  const saveBtn = document.getElementById('file-editor-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Loading…';
  openModal('modal-file-editor');
  try {
    const content = await window.mcpanel.readServerFile(currentServerId, relPath);
    document.getElementById('file-editor-content').value = content;
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  } catch (e) {
    closeModal('modal-file-editor');
    toast(String(e), 'error');
  }
}

async function saveFileEditor() {
  if (!_editorRelPath || !currentServerId) return;
  const saveBtn = document.getElementById('file-editor-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  try {
    const content = document.getElementById('file-editor-content').value;
    const data = Array.from(new TextEncoder().encode(content));
    await window.mcpanel.writeServerFile(currentServerId, _editorRelPath, data);
    closeModal('modal-file-editor');
    toast('File saved', 'success');
    cachedFileTree = null;
    await openFilesTab();
  } catch (e) {
    toast('Save failed: ' + e, 'error');
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
}

// ─── File Delete / Rename / Create ────────────────────────────────────────────

async function deleteFileEntry(relPath, name, isDir) {
  const msg = isDir
    ? `Delete folder "${name}" and all its contents?`
    : `Delete file "${name}"?`;
  if (!confirm(msg)) return;
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
  if (!confirm(`Delete ${count} selected item${count !== 1 ? 's' : ''}? This cannot be undone.`)) return;
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
  document.getElementById('tsett-java-path').value = srv.javaPath || 'java';
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
  if (path) document.getElementById('tsett-java-path').value = path;
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
  const controlsEl = document.getElementById('control-buttons');
  const statusDot = document.getElementById('console-status-dot');
  const bigStatus = document.getElementById('big-status-badge');

  statusDot.className = `status-dot ${running ? 'online' : ''}`;
  bigStatus.className = `big-status ${running ? 'online' : ''}`;
  bigStatus.textContent = running ? 'ONLINE' : 'OFFLINE';

  actionsEl.innerHTML = '';
  controlsEl.innerHTML = '';

  if (!running) {
    const startBtn = document.createElement('button');
    startBtn.className = 'btn-primary';
    startBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start`;
    startBtn.onclick = () => startServerFlow(currentServerId);
    actionsEl.appendChild(startBtn);

    const startBig = document.createElement('button');
    startBig.className = 'btn-control start';
    startBig.style.gridColumn = '1 / -1';
    startBig.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Server`;
    startBig.onclick = () => startServerFlow(currentServerId);
    controlsEl.appendChild(startBig);
  } else {
    // Stop btn in header
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn-ghost';
    stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop`;
    stopBtn.onclick = async () => {
      await window.mcpanel.stopServer(currentServerId);
      toast('Stop command sent', 'info');
    };
    actionsEl.appendChild(stopBtn);

    // Control grid
    const controls = [
      { label: 'Stop', cls: 'stop', icon: `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`, action: () => window.mcpanel.stopServer(currentServerId) },
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
    controls.forEach(({ label, cls, icon, action }) => {
      const btn = document.createElement('button');
      btn.className = `btn-control ${cls}`;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>${label}`;
      btn.onclick = () => action();
      controlsEl.appendChild(btn);
    });
  }
}

function setPlayersBar(current, max, online) {
  const barEl = document.getElementById('detail-players-bar');
  const textEl = document.getElementById('detail-players');
  if (!textEl) return;
  if (!online) {
    if (barEl) barEl.style.width = '0%';
    textEl.textContent = '0/0';
    return;
  }
  const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0;
  if (barEl) barEl.style.width = pct + '%';
  textEl.textContent = `${current}/${max}`;
}

function formatCap(capStr) {
  const bytes = parseStorageLimit(capStr);
  return bytes !== null ? formatBytes(bytes) : (capStr || '—');
}

function setRamBar(usedBytes, capStr) {
  const barEl = document.getElementById('detail-ram-bar');
  const textEl = document.getElementById('detail-ram');
  if (!textEl) return;
  const capBytes = parseStorageLimit(capStr);
  if (capBytes !== null) {
    const used = usedBytes || 0;
    const pct = Math.min(100, (used / capBytes) * 100);
    if (barEl) barEl.style.width = pct + '%';
    textEl.textContent = `${formatBytes(used)} / ${formatCap(capStr)}`;
  } else {
    if (barEl) barEl.style.width = '0%';
    textEl.textContent = formatCap(capStr);
  }
}

function setStorageBar(usedBytes, limitStr) {
  const barEl = document.getElementById('detail-storage-bar');
  const textEl = document.getElementById('detail-storage');
  if (!textEl) return;
  const used = usedBytes || 0;
  const usedFmt = formatBytes(used);
  if (limitStr) {
    const limitBytes = parseStorageLimit(limitStr);
    if (limitBytes !== null) {
      const pct = Math.min(100, (used / limitBytes) * 100);
      const over = used > limitBytes;
      if (barEl) {
        barEl.style.width = pct + '%';
        barEl.className = `stat-bar-fill ${over ? 'bar-red' : 'bar-purple'}`;
      }
      textEl.textContent = `${usedFmt} / ${formatCap(limitStr)}`;
      textEl.style.color = over ? 'var(--red)' : '';
      return;
    }
  }
  if (systemInfo.totalStorage) {
    const pct = Math.min(100, (used / systemInfo.totalStorage) * 100);
    if (barEl) {
      barEl.style.width = pct + '%';
      barEl.className = 'stat-bar-fill bar-purple';
    }
    textEl.textContent = `${usedFmt} / ${formatBytes(systemInfo.totalStorage)}`;
  } else {
    if (barEl) barEl.style.width = '0%';
    textEl.textContent = usedFmt;
  }
  textEl.style.color = '';
}

function updateDetailOnline(online, players = 0, maxPlayers = 0, playerList = []) {
  const bigStatus = document.getElementById('big-status-badge');
  bigStatus.className = `big-status ${online ? 'online' : ''}`;
  bigStatus.textContent = online ? 'ONLINE' : 'OFFLINE';
  setPlayersBar(players, maxPlayers, online);
  const listEl = document.getElementById('detail-player-list');
  if (listEl) {
    if (online && playerList.length > 0) {
      listEl.textContent = playerList.join(', ');
      listEl.style.display = '';
    } else {
      listEl.style.display = 'none';
    }
  }
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
  try {
    const result = await window.mcpanel.getLogSince(id, consoleLogOffset);
    if (result && id === currentServerId) {
      consoleLogOffset = result.offset;
      (result.lines || []).forEach(entry => appendConsoleLine(entry.text || '', entry.type || 'out'));
    }
  } catch {}
  if (consolePollInterval !== null && id === currentServerId) {
    consolePollInterval = setTimeout(() => _pollStep(id), 50);
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
  if (p) document.getElementById('quick-java-path').value = p;
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
  document.getElementById('ss-java-path').value = srv.javaPath || 'java';
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
  if (p) document.getElementById('ss-java-path').value = p;
}

async function browseJavaCreate() {
  const path = await window.mcpanel.browseJava();
  if (path) document.getElementById('cs-java').value = path;
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
function confirmDeleteServer() {
  openModal('modal-confirm-delete');
}

async function executeDeleteServer() {
  if (!currentServerId) return;
  const r = await window.mcpanel.deleteServer(currentServerId);
  if (r.error) { toast(r.error, 'error'); return; }
  config.servers = config.servers.filter(s => s.id !== currentServerId);
  currentServerId = null;
  closeModal('modal-confirm-delete');
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

  versionSel.innerHTML = '<option>Loading...</option>';
  const cacheKey = `${software}_${preRelease}_${unstable}`;
  if (versionCache[cacheKey]) {
    populateVersions(versionCache[cacheKey]);
    filterProfilesForSoftware(software);
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
  
  profileSel.innerHTML = '<option value="">— No profile (plain server) —</option>';
  
  profiles.forEach(p => {
    const softwareOk = p.software.length === 0 || p.software.includes(software);
    const versionOk = p.versions.length === 0 || p.versions.includes(version);
    if (softwareOk && versionOk) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.description ? ` — ${p.description}` : '');
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
function renderProfilesGrid() {
  window.mcpanel.getProfiles().then(p => {
    profiles = p;
    const grid = document.getElementById('profiles-grid');
    const empty = document.getElementById('profiles-empty');
    grid.querySelectorAll('.profile-card').forEach(c => c.remove());
    if (p.length === 0) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    p.forEach(profile => grid.appendChild(createProfileCard(profile)));
  });
}

function createProfileCard(profile) {
  const card = document.createElement('div');
  card.className = 'profile-card';
  const tags = [
    ...(profile.software.length > 0 ? profile.software.map(s => capitalise(s)) : ['Any Software']),
    ...(profile.versions.length > 0 ? profile.versions : ['Any Version']),
  ];
  card.innerHTML = `
    <div class="profile-card-name">${escapeHtml(profile.name)}</div>
    <div class="profile-card-desc">${escapeHtml(profile.description || 'No description')}</div>
    <div class="profile-tags">
      ${tags.map(t => `<span class="profile-tag">${escapeHtml(t)}</span>`).join('')}
    </div>
    <div class="profile-actions">
      <button class="btn-sm" onclick="window.mcpanel.openProfileFolder('${profile.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Open Folder
      </button>
      <button class="btn-sm" style="color:var(--red);border-color:rgba(239,68,68,0.3)" onclick="deleteProfile('${profile.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
        Delete
      </button>
    </div>
  `;
  return card;
}

async function deleteProfile(id) {
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
      statusEl.innerHTML = `MCPanel: <span style="color:var(--yellow)">v${result.latest} available — </span><a href="#" style="color:var(--purple-300)" onclick="window.mcpanel.openExternal('${result.url}');return false">View release</a>`;
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
      statusEl.innerHTML = `MCPanel-CLI: <span style="color:var(--yellow)">v${result.latest} available — </span><a href="#" style="color:var(--purple-300)" onclick="window.mcpanel.openExternal('${result.url}');return false">View on GitHub</a>`;
    }
    toast(`MCPanel-CLI v${result.latest} is available on PyPI`, 'info');
  } else if (result.latest) {
    if (statusEl) statusEl.textContent = `MCPanel-CLI: up to date (v${result.current})`;
  } else {
    if (statusEl) statusEl.textContent = result.current ? `MCPanel-CLI: could not reach PyPI (v${result.current} installed)` : 'MCPanel-CLI: could not check version';
  }
}

async function checkForCliUpdates() {
  const statusEl = document.getElementById('cli-update-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  const result = await window.mcpanel.checkCliUpdate();
  applyCliUpdateResult(result);
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
      if (id !== 'modal-download') closeModal(id);
    }
  });
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

function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

// ─── Themes ───────────────────────────────────────────────────────────────────
let installedThemes = [];

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
  const theme = installedThemes.find(t => t.id === id);
  document.getElementById('active-theme-name').textContent = theme ? theme.name : id;
  document.getElementById('reset-theme-btn').style.display = '';
  renderInstalledThemes();
  toast(`Theme "${theme?.name || id}" applied`, 'success');
}

async function resetTheme() {
  await loadAndApplyTheme(null);
  config.activeTheme = null;
  await window.mcpanel.saveConfig(config);
  document.getElementById('active-theme-name').textContent = 'Default (Purple Dark)';
  document.getElementById('reset-theme-btn').style.display = 'none';
  renderInstalledThemes();
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
        <button class="btn-xs" style="color:var(--red);border-color:rgba(239,68,68,0.25)" onclick="confirmDeleteTheme('${theme.id}')">Delete</button>
      </div>
    `;
    container.appendChild(item);
  });
}

async function confirmDeleteTheme(id) {
  const theme = installedThemes.find(t => t.id === id);
  if (!confirm(`Delete theme "${theme?.name || id}"? This cannot be undone.`)) return;
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
    setTimeout(() => { if (_termFit) _termFit.fit(); _term.focus(); }, 50);
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

// ─── Start ────────────────────────────────────────────────────────────────────
init();
