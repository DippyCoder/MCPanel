/* ═══════════════════════════════════════════════════════════════════════════
   MCPanel addon UI layer — shared, byte-for-byte, by MCPanel (src/) and
   MCPanel-WebUI (public/). Keep both copies identical.

   1. window.MCPanelAddons — the API addon UI scripts use to extend the panel:
      new sidebar pages, new server tabs, hooks into existing pages/tabs, CLI
      access. Everything is rendered inside the panel's own DOM, so the
      selected theme's CSS variables (--accent, --bg-elevated, --text-primary,
      …) and classes (.card, .btn-primary, .input, …) apply automatically.

   2. The loader — asks MCPanel-CLI for every enabled addon's UI files
      (`mcpanel api addons ui --product <mcpanel|webui>`) and injects them.

   3. The built-in "Addons" page — browse addon libraries (MCLib, …), install,
      update, downgrade and remove addons, manage installed ones. Built on the
      same registerPage() API addons use.

   Addons run with the panel's full privileges (and the WebUI user's session);
   that is what the third-party disclaimer every install requires is about.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const API_VERSION = 1;
  const product = (window.mcpanel && window.mcpanel.product) || 'mcpanel';
  const listeners = Object.create(null);
  const pages = new Map();       // id -> {spec, el, rendered}
  const serverTabs = new Map();  // id -> {spec, el}

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Tabler "category" icon. Same 24px viewBox and stroke-width 2 as the
  // panel's own sidebar/tab icons, so the line weight matches at any size.
  const addonIcon = (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M4 4h6v6h-6l0 -6"/><path d="M14 4h6v6h-6l0 -6"/><path d="M4 14h6v6h-6l0 -6"/>' +
    '<path d="M14 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/></svg>';
  const ICON_ADDON = addonIcon(18);      // sidebar
  const ICON_ADDON_TAB = addonIcon(13);  // server detail tabs

  function emit(event, ...args) {
    for (const fn of listeners[event] || []) {
      try { fn(...args); } catch (e) { console.error(`[addons] "${event}" listener failed`, e); }
    }
  }

  function toastMsg(msg, type) {
    if (typeof window.toast === 'function') window.toast(msg, type);
    else console.log(`[addons] ${type}: ${msg}`);
  }

  function safeId(id) {
    const s = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!s) throw new Error('an id is required');
    return s;
  }

  function currentServer() {
    try {
      // `config` / `currentServerId` are app.js globals (classic-script scope).
      // eslint-disable-next-line no-undef
      return config.servers.find(s => s.id === currentServerId) || null;
    } catch { return null; }
  }

  // ─── public API ────────────────────────────────────────────────────────────
  const api = {
    apiVersion: API_VERSION,
    product,                                   // 'mcpanel' | 'webui'

    /** Subscribe: 'page' (name), 'server-open' (id), 'server-tab' (name, id), 'addons-loaded'. */
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => api.off(event, fn); },
    off(event, fn) { listeners[event] = (listeners[event] || []).filter(f => f !== fn); },

    /** Run `mcpanel api <args…>`; resolves the parsed JSON ({error, code} on failure). */
    async cli(args) {
      try { return await window.mcpanel.cli(args.map(String)); }
      catch (e) { return { error: e.message || String(e), code: e.code || 'error' }; }
    },

    toast: toastMsg,
    escapeHtml: esc,
    servers() { try { return config.servers.slice(); } catch { return []; } }, // eslint-disable-line no-undef
    currentServer,
    openExternal(url) { return window.mcpanel.openExternal(url); },
    showPage(name) { window.showPage(pages.has(name) ? `addon-${name}` : name); },

    /** Inject CSS (e.g. extra rules for an existing page). Returns the <style>. */
    addStyle(css, owner) {
      const el = document.createElement('style');
      el.dataset.addon = owner || 'addon';
      el.textContent = String(css);
      document.head.appendChild(el);
      return el;
    },

    /**
     * New sidebar page.
     *   {id, label, icon?: '<svg…>', title?, subtitle?, render(el, api), onShow?(el, api)}
     * `render` runs once, the first time the page is shown; `onShow` every time.
     */
    registerPage(spec, opts = {}) {
      const id = safeId(spec.id);
      if (pages.has(id)) throw new Error(`page "${id}" is already registered`);
      const nav = document.querySelector('.sidebar .nav-section');
      const main = document.querySelector('main.main');
      if (!nav || !main) throw new Error('panel layout not found');

      const btn = document.createElement('button');
      btn.className = 'nav-item';
      btn.dataset.page = `addon-${id}`;
      btn.innerHTML = `${spec.icon || ICON_ADDON}<span>${esc(spec.label || id)}</span>`;
      btn.addEventListener('click', () => window.showPage(`addon-${id}`));
      const settingsBtn = nav.querySelector('[data-page="settings"]');
      if (opts.beforeSettings && settingsBtn) nav.insertBefore(btn, settingsBtn);
      else nav.appendChild(btn);

      const page = document.createElement('div');
      page.className = 'page hidden';
      page.id = `page-addon-${id}`;
      page.innerHTML = `
        <div class="page-header"><div>
          <h1>${esc(spec.title || spec.label || id)}</h1>
          ${spec.subtitle ? `<p class="page-subtitle">${esc(spec.subtitle)}</p>` : ''}
        </div><div class="addon-page-actions" style="display:flex;gap:8px"></div></div>
        <div class="addon-page-body"></div>`;
      main.appendChild(page);
      pages.set(id, { spec, el: page, rendered: false });
      return { id, page, body: page.querySelector('.addon-page-body'),
               actions: page.querySelector('.addon-page-actions'), nav: btn };
    },

    /**
     * New tab on the server detail page.
     *   {id, label, icon?, render(el, server, api)}
     * `render` runs every time the tab is opened, with the current server.
     */
    registerServerTab(spec) {
      const id = safeId(spec.id);
      if (serverTabs.has(id)) throw new Error(`server tab "${id}" is already registered`);
      const bar = document.querySelector('#page-server-detail .detail-tab-bar');
      const host = document.querySelector('#page-server-detail .detail-main');
      if (!bar || !host) throw new Error('server detail layout not found');
      const name = `addon-${id}`;
      const btn = document.createElement('button');
      btn.className = 'detail-tab';
      btn.id = `dtab-${name}`;
      btn.innerHTML = `${spec.icon || ICON_ADDON_TAB} ${esc(spec.label || id)}`;
      btn.addEventListener('click', () => window.switchDetailTab(name));
      bar.appendChild(btn);
      const pane = document.createElement('div');
      pane.id = `pane-${name}`;
      pane.className = 'hidden';
      host.appendChild(pane);
      serverTabs.set(id, { spec, el: pane });
      return { id, pane, button: btn };
    },

    // ── used by app.js ──
    _serverTabNames() { return [...serverTabs.keys()].map(id => `addon-${id}`); },
    _pageShown(name) {
      if (name && name.startsWith('addon-')) {
        const p = pages.get(name.slice(6));
        if (p) {
          const body = p.el.querySelector('.addon-page-body');
          try {
            if (!p.rendered && typeof p.spec.render === 'function') { p.spec.render(body, api); p.rendered = true; }
            if (typeof p.spec.onShow === 'function') p.spec.onShow(body, api);
          } catch (e) { reportError(p.spec.owner || name, e); }
        }
      }
      emit('page', name);
    },
    _serverTabShown(name) {
      if (name && name.startsWith('addon-')) {
        const t = serverTabs.get(name.slice(6));
        if (t && typeof t.spec.render === 'function') {
          try { t.spec.render(t.el, currentServer(), api); } catch (e) { reportError(name, e); }
        }
      }
      emit('server-tab', name, (currentServer() || {}).id || null);
    },
    _serverOpened(id) { emit('server-open', id); },
  };
  window.MCPanelAddons = api;

  function reportError(owner, e) {
    console.error(`[addons] ${owner}:`, e);
    toastMsg(`Addon "${owner}" failed: ${e && e.message ? e.message : e}`, 'error');
  }
  api._reportError = reportError;

  // ─── loader ────────────────────────────────────────────────────────────────
  function runAddonScript(addon, file) {
    const el = document.createElement('script');
    const ctx = JSON.stringify({ name: addon.addon, version: addon.version, file: file.path });
    // Each file runs in its own function scope with `addon` describing itself;
    // a throw is reported against that addon instead of breaking the panel.
    el.textContent =
      `(function (addon) { try {\n${file.content}\n} catch (e) { window.MCPanelAddons._reportError(addon.name, e); } })(${ctx});\n` +
      `//# sourceURL=mcpanel-addon/${encodeURIComponent(addon.addon)}/${file.path.replace(/[^\w./-]/g, '_')}`;
    document.body.appendChild(el);
  }

  async function loadAddonUis() {
    const r = await api.cli(['addons', 'ui', '--product', product]);
    if (!r || r.error) {
      // Older CLI without `addons ui`, or a non-admin WebUI user without the
      // permission: the panel simply runs without addon UI.
      if (r && r.code !== 'unknown_command') console.warn('[addons] UI not loaded:', r.error);
      return;
    }
    for (const a of r.addons || []) {
      for (const s of a.styles || []) api.addStyle(s.content, a.addon);
      for (const f of a.scripts || []) runAddonScript(a, f);
    }
    for (const p of r.errors || []) console.warn(`[addons] ${p.addon}: ${p.error}`);
    emit('addons-loaded', (r.addons || []).map(a => a.addon));
  }

  // ─── built-in "Addons" page (the addon browser) ────────────────────────────
  const PRODUCT_NAMES = { cli: 'MCPanel-CLI', mcpanel: 'MCPanel', webui: 'MCPanel-WebUI' };
  const state = { library: 'mclib', view: 'browse', query: '', productFilter: '', data: null };

  function installBrowser() {
    api.addStyle(`
      .mcl-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
      .mcl-toolbar .input { width:auto; min-width:160px; }
      .mcl-toolbar .mcl-search { flex:1 1 220px; }
      .mcl-views { display:flex; gap:4px; margin-bottom:14px; }
      .mcl-notice { font-size:12px; color:var(--text-secondary); margin-bottom:14px; }
      .mcl-list { display:grid; gap:10px; }
      .mcl-item { padding:14px 16px; }
      .mcl-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
      .mcl-name { font-family:var(--font-display); font-size:15px; color:var(--text-primary); }
      .mcl-tag { font-size:11px; padding:1px 8px; border-radius:999px; background:var(--accent-dim); color:var(--accent); }
      .mcl-tag.ok { background:rgba(var(--green-rgb),.15); color:var(--green); }
      .mcl-tag.bad { background:rgba(var(--red-rgb),.15); color:var(--red); }
      .mcl-desc { color:var(--text-secondary); font-size:13px; margin:6px 0 8px; }
      .mcl-meta { color:var(--text-muted); font-size:12px; display:flex; gap:14px; flex-wrap:wrap; }
      .mcl-meta a { color:var(--accent); cursor:pointer; }
      .mcl-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
      .mcl-releases { margin-top:10px; border-top:1px solid var(--border); padding-top:10px; display:grid; gap:6px; font-size:13px; }
      .mcl-rel { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      .mcl-rel-ver { min-width:110px; color:var(--text-primary); font-family:var(--font-mono); }
      .mcl-empty { color:var(--text-muted); padding:24px; text-align:center; }
      .mcl-disclaimer { white-space:pre-wrap; font-size:13px; line-height:1.55; color:var(--text-secondary); }
    `, 'addon-browser');

    const view = api.registerPage({
      id: 'browser', label: 'Addons', title: 'Addons',
      subtitle: 'Extend MCPanel with addons from MCLib and other libraries',
      icon: ICON_ADDON,
      render: (body) => renderShell(body),
      onShow: () => refresh(),
    }, { beforeSettings: true });
    view.actions.innerHTML = `<button class="btn-ghost" data-mcl="refresh">Refresh</button>`;
    view.actions.addEventListener('click', () => refresh());
    buildDisclaimerModal();
  }

  function renderShell(body) {
    body.innerHTML = `
      <div class="mcl-views">
        <button class="detail-tab active" data-mcl-view="browse">Browse</button>
        <button class="detail-tab" data-mcl-view="installed">Installed</button>
      </div>
      <div class="mcl-toolbar" data-mcl-browse-only>
        <select class="input" data-mcl="library"></select>
        <input class="input mcl-search" data-mcl="search" placeholder="Search addons…">
        <select class="input" data-mcl="product">
          <option value="">All products</option>
          <option value="cli">MCPanel-CLI</option>
          <option value="mcpanel">MCPanel</option>
          <option value="webui">MCPanel-WebUI</option>
        </select>
      </div>
      <div class="mcl-notice">Addons are third-party software that runs with full access to MCPanel.
        Install only addons from authors you trust.</div>
      <div class="mcl-list" data-mcl="list"><div class="mcl-empty">Loading…</div></div>`;
    body.addEventListener('click', onClick);
    body.querySelector('[data-mcl="search"]').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
    body.querySelector('[data-mcl="product"]').addEventListener('change', (e) => { state.productFilter = e.target.value; renderList(); });
    body.querySelector('[data-mcl="library"]').addEventListener('change', (e) => { state.library = e.target.value; refresh(); });
  }

  function body() { return document.querySelector('#page-addon-browser .addon-page-body'); }

  async function refresh() {
    const b = body();
    if (!b) return;
    const list = b.querySelector('[data-mcl="list"]');
    b.querySelectorAll('[data-mcl-view]').forEach(t => t.classList.toggle('active', t.dataset.mclView === state.view));
    b.querySelector('[data-mcl-browse-only]').style.display = state.view === 'browse' ? '' : 'none';
    list.innerHTML = '<div class="mcl-empty">Loading…</div>';

    if (state.view === 'browse') {
      const libs = await api.cli(['addons', 'libraries']);
      const sel = b.querySelector('[data-mcl="library"]');
      if (libs && Array.isArray(libs.libraries)) {
        if (!libs.libraries.some(l => l.name === state.library) && libs.libraries[0]) state.library = libs.libraries[0].name;
        sel.innerHTML = libs.libraries.map(l =>
          `<option value="${esc(l.name)}" ${l.name === state.library ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
      }
      state.data = await api.cli(['mclib', state.library, 'list']);
    } else {
      state.data = await api.cli(['addons', 'list']);
    }
    renderList();
  }

  function renderList() {
    const b = body();
    if (!b) return;
    const list = b.querySelector('[data-mcl="list"]');
    const d = state.data;
    if (!d) return;
    if (d.error) { list.innerHTML = `<div class="mcl-empty">${esc(d.error)}</div>`; return; }

    if (state.view === 'installed') {
      const items = d.addons || [];
      list.innerHTML = items.length ? items.map(a => `
        <div class="card mcl-item" data-name="${esc(a.name)}">
          <div class="mcl-head"><span class="mcl-name">${esc(a.name)}</span>
            <span class="mcl-tag ${a.status === 'loaded' ? 'ok' : (a.status === 'disabled' ? '' : 'bad')}">${esc(a.status)}</span>
            ${a.version ? `<span class="mcl-tag">${esc(a.version)}</span>` : ''}
            <span class="mcl-tag">${esc(a.source)}</span></div>
          ${a.description ? `<div class="mcl-desc">${esc(a.description)}</div>` : ''}
          ${a.error ? `<div class="mcl-desc" style="color:var(--red)">${esc(String(a.error).split('\n').filter(Boolean).pop())}</div>` : ''}
          <div class="mcl-actions">
            ${a.enabled ? `<button class="btn-sm" data-act="disable">Disable</button>`
                        : `<button class="btn-sm" data-act="enable">Enable</button>`}
            ${a.source === 'user' ? `<button class="btn-danger-sm" data-act="uninstall">Remove</button>` : ''}
          </div>
        </div>`).join('') : '<div class="mcl-empty">No addons installed.</div>';
      return;
    }

    const q = state.query.trim().toLowerCase();
    const items = (d.addons || []).filter(a =>
      (!state.productFilter || (a.products || []).includes(state.productFilter)) &&
      (!q || [a.name, a.description, (a.authors || []).join(' ')].join(' ').toLowerCase().includes(q)));
    list.innerHTML = items.length ? items.map(a => `
      <div class="card mcl-item" data-name="${esc(a.name)}">
        <div class="mcl-head"><span class="mcl-name">${esc(a.name)}</span>
          ${(a.products || []).map(p => `<span class="mcl-tag">${esc(PRODUCT_NAMES[p] || p)}</span>`).join('')}
          ${a.installedVersion ? `<span class="mcl-tag ok">installed ${esc(a.installedVersion)}</span>` : ''}</div>
        <div class="mcl-desc">${esc(a.description)}</div>
        <div class="mcl-meta"><span>by ${esc((a.authors || []).join(', ') || 'unknown')}</span>
          <a data-act="open" data-url="${esc(a.project)}">${esc(String(a.project).replace(/^https:\/\//, ''))}</a></div>
        <div class="mcl-actions">
          ${a.installedVersion
            ? `<button class="btn-sm" data-act="update">Update</button>
               <button class="btn-danger-sm" data-act="remove">Remove</button>`
            : `<button class="btn-primary" data-act="install">Install</button>`}
          <button class="btn-sm" data-act="versions">Versions</button>
        </div>
        <div class="mcl-releases hidden"></div>
      </div>`).join('') : `<div class="mcl-empty">${(d.addons || []).length ? 'No addons match.' : 'This library lists no addons.'}</div>`;
  }

  async function onClick(e) {
    const tab = e.target.closest('[data-mcl-view]');
    if (tab) { state.view = tab.dataset.mclView; refresh(); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-name]');
    const name = card && card.dataset.name;
    const act = btn.dataset.act;

    if (act === 'open') {
      const url = btn.dataset.url || '';
      if (/^https:\/\/(github\.com|codeberg\.org)\//.test(url)) api.openExternal(url);
      return;
    }
    if (act === 'versions') return toggleVersions(card, name);
    if (act === 'install') return runMclib(btn, ['install', name]);
    if (act === 'update') return runMclib(btn, ['update', name]);
    if (act === 'remove') return runMclib(btn, ['remove', name]);
    if (act === 'rel') return runMclib(btn, [btn.dataset.op, name, btn.dataset.version]);
    if (act === 'enable' || act === 'disable' || act === 'uninstall') {
      const r = await api.cli(['addons', act === 'uninstall' ? 'remove' : act, name]);
      if (r.error) api.toast(r.error, 'error');
      else api.toast(act === 'uninstall' ? `Removed ${name}` : `${name} ${act}d — reload to apply UI changes`, 'success');
      refresh();
    }
  }

  async function toggleVersions(card, name) {
    const box = card.querySelector('.mcl-releases');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<span style="color:var(--text-muted)">Loading releases…</span>';
    const r = await api.cli(['mclib', state.library, 'list', name]);
    if (r.error) { box.innerHTML = `<span style="color:var(--red)">${esc(r.error)}</span>`; return; }
    const rels = r.releases || [];
    if (!rels.length) { box.innerHTML = '<span style="color:var(--text-muted)">No releases published.</span>'; return; }
    const norm = v => String(v || '').replace(/^v/i, '');
    const instIdx = r.installedVersion ? rels.findIndex(x => norm(x.version) === norm(r.installedVersion)) : -1;
    box.innerHTML = rels.map((rel, i) => {
      let op = 'install', label = 'Install';
      if (instIdx >= 0) {
        if (i === instIdx) op = null;
        else if (i < instIdx) { op = 'update'; label = 'Update to'; }
        else { op = 'downgrade'; label = 'Downgrade to'; }
      }
      return `<div class="mcl-rel"><span class="mcl-rel-ver">${esc(rel.version)}</span>
        <span style="color:var(--text-muted)">${esc(String(rel.published || '').slice(0, 10))}${rel.prerelease ? ' · pre-release' : ''}</span>
        ${op ? `<button class="btn-sm" data-act="rel" data-op="${op}" data-version="${esc(rel.version)}">${label}</button>`
             : '<span class="mcl-tag ok">installed</span>'}</div>`;
    }).join('');
  }

  // Disclaimer: the text comes from the CLI's `disclaimer_required` reply, so
  // the panel never carries its own copy of the wording.
  function buildDisclaimerModal() {
    const wrap = document.createElement('div');
    wrap.className = 'modal-overlay hidden';
    wrap.id = 'modal-mclib-disclaimer';
    wrap.innerHTML = `
      <div class="modal">
        <div class="modal-header"><h2>Third-party software</h2></div>
        <div class="modal-body">
          <div class="mcl-disclaimer" data-mcl="disclaimer"></div>
          <p style="margin-top:12px;font-size:12px"><a data-mcl="tos" style="color:var(--accent);cursor:pointer">Read the library's terms</a></p>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button class="btn-ghost" data-mcl="decline">Cancel</button>
            <button class="btn-primary" data-mcl="accept">Accept and install</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
  }

  function askDisclaimer(doc) {
    const modal = document.getElementById('modal-mclib-disclaimer');
    modal.querySelector('[data-mcl="disclaimer"]').textContent = doc.disclaimer || doc.error;
    const tos = modal.querySelector('[data-mcl="tos"]');
    tos.style.display = doc.tos ? '' : 'none';
    tos.onclick = () => doc.tos && api.openExternal(doc.tos);
    modal.classList.remove('hidden');
    return new Promise((resolve) => {
      const done = (v) => { modal.classList.add('hidden'); resolve(v); };
      modal.querySelector('[data-mcl="accept"]').onclick = () => done(true);
      modal.querySelector('[data-mcl="decline"]').onclick = () => done(false);
    });
  }

  async function runMclib(btn, args) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      const base = ['mclib', state.library, ...args.filter(Boolean)];
      let r = await api.cli(base);
      if (r && r.code === 'disclaimer_required') {
        if (!(await askDisclaimer(r))) return;
        btn.textContent = 'Installing…';
        r = await api.cli([...base, '--yes']);
      }
      if (r.error) { api.toast(r.error, 'error'); return; }
      if (r.unchanged) api.toast(r.message || 'Already up to date', 'info');
      else if (args[0] === 'remove') api.toast(`Removed ${r.name}`, 'success');
      else {
        const ui = (r.products || []).includes(product);
        api.toast(`${r.name} ${r.version} installed${ui ? ' — reload the panel to load its UI' : ''}`, 'success');
        if (r.addon && r.addon.status && r.addon.status !== 'loaded') {
          api.toast(`${r.name} was installed but reports "${r.addon.status}" — see the Installed tab`, 'error');
        }
      }
      refresh();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ─── boot ──────────────────────────────────────────────────────────────────
  try { installBrowser(); } catch (e) { console.error('[addons] browser failed to install', e); }
  Promise.resolve(window._cliReady).then((ok) => {
    if (ok !== false) loadAddonUis().catch(e => console.error('[addons] loader failed', e));
  });
})();
