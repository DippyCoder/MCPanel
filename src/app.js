/* ═══════════════════════════════════════════════════════
   MCPanel Frontend — app.js
   ═══════════════════════════════════════════════════════ */

let config = { servers: [], jdkPaths: [] };
let profiles = [];
let currentServerId = null;
let versionCache = {};
let statusPollInterval = null;
let commandHistory = [];
let historyIndex = -1;
let startingServers = new Set();
let pendingEulaServerId = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  config = await window.mcpanel.getConfig();
  profiles = await window.mcpanel.getProfiles();
  renderServersGrid();
  renderSidebarServers();
  startStatusPolling();

  // Event listeners
  window.mcpanel.on('server-log', ({ id, line, type }) => {
    if (id === currentServerId) appendConsoleLine(line, type);
  });

  window.mcpanel.on('server-stopped', ({ id }) => {
    startingServers.delete(id);
    if (id === currentServerId) {
      appendConsoleLine('Server stopped.', 'system');
      updateDetailControls(false);
    }
    updateServerCardStatus(id, false, 0);
    updateSidebarDot(id, false);
  });

  window.mcpanel.on('download-progress', ({ id, progress, status }) => {
    document.getElementById('download-status-text').textContent = status;
    document.getElementById('progress-bar-fill').style.width = progress + '%';
    document.getElementById('progress-percent').textContent = progress + '%';
  });

  // Silent update check on startup
  window.mcpanel.checkUpdate().then(result => { if (result.hasUpdate) applyUpdateResult(result); });
}

// ─── Page Navigation ──────────────────────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-' + page).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');

  if (page === 'profiles') renderProfilesGrid();
  if (page === 'servers') renderServersGrid();
}

function openServerDetail(id) {
  currentServerId = id;
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
  document.getElementById('detail-ram').textContent = srv.ram;
  document.getElementById('detail-storage').textContent = srv.storageLimit || 'Unlimited';

  // Quick settings
  document.getElementById('quick-port').value = srv.port;
  document.getElementById('quick-java-args').value = srv.javaArgs || '';
  document.getElementById('quick-java-path').value = srv.javaPath || 'java';

  // Load console history
  const logEl = document.getElementById('console-output');
  logEl.innerHTML = '';
  const existingLog = window.mcpanel.getServerLog ? [] : [];
  window.mcpanel.getServerLog(id).then(log => {
    log.forEach(entry => appendConsoleLine(entry.text, entry.type));
  });

  // Check running state
  window.mcpanel.isServerRunning(id).then(running => {
    updateDetailControls(running);
    if (running) updateDetailOnline(true);
  });

  // Storage stats (async)
  window.mcpanel.getServerDirStats(id).then(({ size }) => {
    if (srv.storageLimit) {
      const used = formatBytes(size);
      document.getElementById('detail-storage').textContent = `${used} / ${srv.storageLimit}`;
    } else {
      document.getElementById('detail-storage').textContent = formatBytes(size);
    }
  });
}

// ─── Servers Grid ─────────────────────────────────────────────────────────────
function renderServersGrid() {
  const grid = document.getElementById('servers-grid');
  const empty = document.getElementById('servers-empty');
  grid.querySelectorAll('.server-card').forEach(c => c.remove());
  if (config.servers.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  config.servers.forEach(srv => grid.appendChild(createServerCard(srv)));
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
      updateServerCardStatus(srv.id, false, 0);
      updateSidebarDot(srv.id, false);
      if (currentServerId === srv.id) updateDetailControls(false);
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
  const playersEl = document.getElementById('detail-players');
  if (playersEl) playersEl.textContent = '—';
  const listEl = document.getElementById('detail-player-list');
  if (listEl) listEl.style.display = 'none';
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
      { label: 'Restart', cls: 'restart', icon: `<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>`, action: () => window.mcpanel.restartServer(currentServerId) },
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

function updateDetailOnline(online, players = 0, maxPlayers = 0, playerList = []) {
  const bigStatus = document.getElementById('big-status-badge');
  bigStatus.className = `big-status ${online ? 'online' : ''}`;
  bigStatus.textContent = online ? 'ONLINE' : 'OFFLINE';
  const playersEl = document.getElementById('detail-players');
  if (playersEl) playersEl.textContent = online ? `${players}/${maxPlayers}` : '—';
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
  el.scrollTop = el.scrollHeight;
}

function clearConsole() {
  const el = document.getElementById('console-output');
  if (el) el.innerHTML = '';
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
  toast('Port updated', 'success');
}

async function saveQuickSettings() {
  if (!currentServerId) return;
  const javaArgs = document.getElementById('quick-java-args').value;
  const javaPath = document.getElementById('quick-java-path').value;
  const r = await window.mcpanel.updateServer(currentServerId, { javaArgs, javaPath });
  if (r.error) { toast(r.error, 'error'); return; }
  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) { config.servers[idx].javaArgs = javaArgs; config.servers[idx].javaPath = javaPath; }
  toast('Settings saved', 'success');
}

async function browseJava() {
  const path = await window.mcpanel.browseJava();
  if (path) document.getElementById('quick-java-path').value = path;
}

async function browseJavaCreate() {
  const path = await window.mcpanel.browseJava();
  if (path) document.getElementById('cs-java').value = path;
}

function openServerFolder() {
  if (currentServerId) window.mcpanel.openServerFolder(currentServerId);
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

  // Unstable builds checkbox: Paper, Purpur, Leaf, Velocity
  const unstableEl = document.getElementById('cs-unstable');
  const unstableLbl = document.getElementById('lbl-unstable');
  const supportsUnstable = ['paper', 'purpur', 'leaf', 'velocity'].includes(software);
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
  const ram = document.getElementById('cs-ram').value;
  const storageLimit = document.getElementById('cs-storage').value.trim();
  const javaPath = document.getElementById('cs-java').value.trim() || 'java';
  const javaArgs = document.getElementById('cs-java-args').value.trim();
  const profileId = document.getElementById('cs-profile').value;

  if (!name) { toast('Please enter a server name', 'error'); return; }
  if (!version || version === 'Loading...' || version === 'Failed to load') {
    toast('Please select a version', 'error'); return;
  }

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

// ─── Update checker ───────────────────────────────────────────────────────────
function applyUpdateResult(result) {
  const statusEl = document.getElementById('update-status-text');
  const pillEl = document.getElementById('update-pill');
  if (result.hasUpdate) {
    if (statusEl) {
      statusEl.innerHTML = `<span style="color:var(--yellow)">v${result.latest} available — </span><a href="#" style="color:var(--purple-300)" onclick="window.mcpanel.openExternal('${result.url}');return false">View release</a>`;
    }
    if (pillEl) pillEl.classList.remove('hidden');
    toast(`MCPanel v${result.latest} is available on GitHub`, 'info');
  } else if (result.latest) {
    if (statusEl) statusEl.textContent = `You're on the latest version (v${result.current})`;
  } else {
    if (statusEl) statusEl.textContent = `Could not reach GitHub (v${result.current} installed)`;
  }
}

async function checkForUpdates() {
  const statusEl = document.getElementById('update-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  const result = await window.mcpanel.checkUpdate();
  applyUpdateResult(result);
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
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
