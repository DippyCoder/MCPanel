const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const os = require('os');
const https = require('https');
const http = require('http');

// ─── Data paths ───────────────────────────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const SERVERS_DIR = path.join(USER_DATA, 'servers');
const PROFILES_DIR = path.join(USER_DATA, 'profiles');
const THEMES_DIR = path.join(USER_DATA, 'themes');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');

[SERVERS_DIR, PROFILES_DIR, THEMES_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Running server processes ─────────────────────────────────────────────────
const runningServers = {}; // id -> { process, log: [] }

// ─── Config helpers ───────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { servers: [], jdkPaths: [], activeTheme: null }; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─── HTTP fetch helper ────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'MCPanel/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Parse error: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'MCPanel/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ─── Version fetchers ─────────────────────────────────────────────────────────
async function fetchPaperVersions(unstable = false) {
  const data = await fetchJSON('https://api.papermc.io/v2/projects/paper');
  const isPreRelease = v => /-(pre|rc|alpha|beta|snapshot)\d*/i.test(v);
  return (unstable ? data.versions : data.versions.filter(v => !isPreRelease(v))).reverse();
}

async function fetchPurpurVersions(unstable = false) {
  const data = await fetchJSON('https://api.purpurmc.org/v2/purpur');
  return data.versions.reverse();
}

async function fetchVelocityVersions(unstable = false) {
  const data = await fetchJSON('https://api.papermc.io/v2/projects/velocity');
  return (unstable ? data.versions : data.versions.filter(v => !v.includes('SNAPSHOT'))).reverse();
}

async function fetchFabricVersions(preRelease = false) {
  const data = await fetchJSON('https://meta.fabricmc.net/v2/versions/game');
  return (preRelease ? data : data.filter(v => v.stable)).map(v => v.version).slice(0, 60);
}

async function fetchVanillaVersions(preRelease = false) {
  const data = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const allowed = preRelease ? ['release', 'snapshot', 'old_beta', 'old_alpha'] : ['release'];
  return data.versions.filter(v => allowed.includes(v.type)).map(v => v.id).slice(0, 80);
}

async function fetchLeafVersions(unstable = false) {
  try {
    const releases = await fetchJSON('https://api.github.com/repos/Winds-Studio/Leaf/releases?per_page=50');
    const seen = new Set();
    const versions = [];
    for (const r of releases) {
      if (r.draft) continue;
      const ver = r.tag_name.replace(/^ver-/, '').replace(/^v/, '');
      if (/^\d+\.\d+(\.\d+)?$/.test(ver) && !seen.has(ver) && r.assets.some(a => a.name.endsWith('.jar'))) {
        seen.add(ver);
        versions.push(ver);
      }
    }
    if (versions.length > 0) return versions;
  } catch {}
  return ['1.21.11', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4'];
}

async function fetchSpigotVersions(unstable = false) {
  return [
    '1.21.4','1.21.3','1.21.1','1.21','1.20.6','1.20.4','1.20.2','1.20.1',
    '1.19.4','1.19.3','1.19.2','1.19.1','1.19',
    '1.18.2','1.18.1','1.18','1.17.1','1.17','1.16.5','1.16.4','1.16.3',
    '1.15.2','1.14.4','1.13.2','1.12.2','1.11.2','1.10.2','1.9.4','1.8.8'
  ];
}

// ─── Download URL resolvers ───────────────────────────────────────────────────
async function resolveDownloadUrl(software, version, unstable = false) {
  switch (software) {
    case 'paper': {
      const data = await fetchJSON(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
      const stable = data.builds.filter(b => b.channel === 'STABLE');
      const pool = (!unstable && stable.length > 0) ? stable : data.builds;
      const latest = pool[pool.length - 1];
      return `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latest.build}/downloads/${latest.downloads.application.name}`;
    }
    case 'purpur':
      return `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;
    case 'velocity': {
      const data = await fetchJSON(`https://api.papermc.io/v2/projects/velocity/versions/${version}/builds`);
      const stable = data.builds.filter(b => b.channel === 'STABLE');
      const pool = (!unstable && stable.length > 0) ? stable : data.builds;
      const latest = pool[pool.length - 1];
      return `https://api.papermc.io/v2/projects/velocity/versions/${version}/builds/${latest.build}/downloads/${latest.downloads.application.name}`;
    }
    case 'fabric': {
      const loaders = await fetchJSON(`https://meta.fabricmc.net/v2/versions/loader/${version}`);
      const loader = loaders[0].loader.version;
      const installers = await fetchJSON('https://meta.fabricmc.net/v2/versions/installer');
      const installer = installers[0].version;
      return `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`;
    }
    case 'vanilla': {
      const manifest = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const versionInfo = manifest.versions.find(v => v.id === version);
      const vData = await fetchJSON(versionInfo.url);
      return vData.downloads.server.url;
    }
    case 'leaf': {
      const releases = await fetchJSON('https://api.github.com/repos/Winds-Studio/Leaf/releases?per_page=50');
      const tagVariants = [`ver-${version}`, `v${version}`, version];
      const rel = releases.find(r => tagVariants.includes(r.tag_name));
      if (!rel) throw new Error(`No Leaf release found for version ${version}`);
      // Prefer plain JAR over mojmap/reobf variants
      const jar = rel.assets.find(a => a.name.endsWith('.jar') && !a.name.includes('mojmap') && !a.name.includes('reobf'))
               || rel.assets.find(a => a.name.includes('reobf') && a.name.endsWith('.jar'))
               || rel.assets.find(a => a.name.endsWith('.jar'));
      if (!jar) throw new Error(`No JAR asset found for Leaf ${version}`);
      return jar.browser_download_url;
    }
    case 'spigot':
      throw new Error('Spigot requires BuildTools. Download from https://www.spigotmc.org/wiki/buildtools/');
    default:
      throw new Error('Unknown software: ' + software);
  }
}

// ─── Download file ────────────────────────────────────────────────────────────
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    
    function doRequest(reqUrl) {
      lib.get(reqUrl, { headers: { 'User-Agent': 'MCPanel/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.destroy();
          const redirect = res.headers.location;
          const newLib = redirect.startsWith('https') ? https : http;
          newLib.get(redirect, { headers: { 'User-Agent': 'MCPanel/1.0' } }, res2 => {
            const total = parseInt(res2.headers['content-length'] || '0');
            let downloaded = 0;
            res2.on('data', chunk => {
              downloaded += chunk.length;
              if (total && onProgress) onProgress(Math.round(downloaded / total * 100));
            });
            const file2 = fs.createWriteStream(dest);
            res2.pipe(file2);
            file2.on('finish', () => { file2.close(); resolve(); });
            file2.on('error', reject);
          }).on('error', reject);
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0');
        let downloaded = 0;
        res.on('data', chunk => {
          downloaded += chunk.length;
          if (total && onProgress) onProgress(Math.round(downloaded / total * 100));
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    }
    doRequest(url);
  });
}

// ─── Server status via TCP query ──────────────────────────────────────────────
function varInt(value) {
  const bytes = [];
  value = value >>> 0;
  do {
    let b = value & 0x7F;
    value >>>= 7;
    if (value !== 0) b |= 0x80;
    bytes.push(b);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function pingServer(host, port) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(3000);

    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);

      // Handshake packet (0x00): protocolVersion=762 (1.19.4), nextState=1 (status)
      const hsBody = Buffer.concat([varInt(0x00), varInt(762), varInt(hostBuf.length), hostBuf, portBuf, varInt(1)]);
      // Status request packet (0x00, no body fields)
      const srBody = varInt(0x00);

      socket.write(Buffer.concat([varInt(hsBody.length), hsBody, varInt(srBody.length), srBody]));

      let data = Buffer.alloc(0);
      socket.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        const str = data.toString('utf8');
        const start = str.indexOf('{');
        const end = str.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try {
            const parsed = JSON.parse(str.slice(start, end + 1));
            socket.destroy();
            resolve({
              online: true,
              players: parsed.players?.online || 0,
              maxPlayers: parsed.players?.max || 0,
              playerList: (parsed.players?.sample || []).map(p => p.name),
              version: parsed.version?.name || 'Unknown',
              motd: typeof parsed.description === 'string' ? parsed.description : (parsed.description?.text || ''),
            });
          } catch { /* wait for more data */ }
        }
      });
    });

    socket.on('timeout', () => { socket.destroy(); resolve({ online: false }); });
    socket.on('error', () => resolve({ online: false }));
    socket.connect(port, host);
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Config
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, cfg) => { saveConfig(cfg); return true; });

// Versions
ipcMain.handle('fetch-versions', async (_, software, preRelease = false, unstable = false) => {
  try {
    const fetchers = {
      paper:    () => fetchPaperVersions(unstable),
      purpur:   () => fetchPurpurVersions(unstable),
      velocity: () => fetchVelocityVersions(unstable),
      fabric:   () => fetchFabricVersions(preRelease),
      vanilla:  () => fetchVanillaVersions(preRelease),
      leaf:     () => fetchLeafVersions(unstable),
      spigot:   () => fetchSpigotVersions(),
    };
    if (!fetchers[software]) return { error: 'Unknown software' };
    const versions = await fetchers[software]();
    return { versions };
  } catch (e) {
    return { error: e.message };
  }
});

// Server management
ipcMain.handle('create-server', async (event, serverData) => {
  try {
    const cfg = loadConfig();
    const id = 'srv_' + Date.now();
    const serverDir = path.join(SERVERS_DIR, id);
    fs.mkdirSync(serverDir, { recursive: true });

    const server = {
      id,
      name: serverData.name,
      port: serverData.port,
      ram: serverData.ram,
      storageLimit: serverData.storageLimit || null,
      software: serverData.software,
      version: serverData.version,
      profileId: serverData.profileId || null,
      javaPath: serverData.javaPath || 'java',
      javaArgs: serverData.javaArgs || '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200',
      created: Date.now(),
      dir: serverDir,
    };

    // Apply profile
    if (serverData.profileId) {
      const profileDir = path.join(PROFILES_DIR, serverData.profileId);
      if (fs.existsSync(profileDir)) {
        copyDirSync(profileDir, serverDir);
      }
    }

    // Write/update server.properties with port
    const propsFile = path.join(serverDir, 'server.properties');
    if (!fs.existsSync(propsFile)) {
      fs.writeFileSync(propsFile, `server-port=${server.port}\nquery.port=${server.port}\n`);
    } else {
      let props = fs.readFileSync(propsFile, 'utf8');
      props = props.replace(/server-port=\d+/, `server-port=${server.port}`);
      if (!props.includes('server-port=')) props += `\nserver-port=${server.port}`;
      fs.writeFileSync(propsFile, props);
    }

    // Download server jar
    event.sender.send('download-progress', { id, progress: 0, status: 'Resolving download URL...' });
    
    if (serverData.software !== 'spigot') {
      const url = await resolveDownloadUrl(serverData.software, serverData.version, serverData.unstableBuilds || false);
      event.sender.send('download-progress', { id, progress: 0, status: 'Downloading server jar...' });
      await downloadFile(url, path.join(serverDir, 'server.jar'), (p) => {
        event.sender.send('download-progress', { id, progress: p, status: `Downloading... ${p}%` });
      });
    }

    cfg.servers.push(server);
    saveConfig(cfg);
    event.sender.send('download-progress', { id, progress: 100, status: 'Done!' });
    return { success: true, server };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('delete-server', (_, id) => {
  try {
    const cfg = loadConfig();
    const srv = cfg.servers.find(s => s.id === id);
    if (srv && fs.existsSync(srv.dir)) {
      fs.rmSync(srv.dir, { recursive: true, force: true });
    }
    cfg.servers = cfg.servers.filter(s => s.id !== id);
    saveConfig(cfg);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('update-server', (_, id, updates) => {
  try {
    const cfg = loadConfig();
    const idx = cfg.servers.findIndex(s => s.id === id);
    if (idx === -1) return { error: 'Server not found' };
    cfg.servers[idx] = { ...cfg.servers[idx], ...updates };
    
    // If port changed, update server.properties
    if (updates.port) {
      const propsFile = path.join(cfg.servers[idx].dir, 'server.properties');
      if (fs.existsSync(propsFile)) {
        let props = fs.readFileSync(propsFile, 'utf8');
        props = props.replace(/server-port=\d+/, `server-port=${updates.port}`);
        fs.writeFileSync(propsFile, props);
      }
    }
    saveConfig(cfg);
    return { success: true, server: cfg.servers[idx] };
  } catch (e) {
    return { error: e.message };
  }
});

// Server start/stop/restart/kill
ipcMain.handle('accept-eula', (_, id) => {
  try {
    const cfg = loadConfig();
    const srv = cfg.servers.find(s => s.id === id);
    if (!srv) return { error: 'Server not found' };
    fs.writeFileSync(path.join(srv.dir, 'eula.txt'), 'eula=true\n');
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('start-server', async (event, id) => {
  try {
    const cfg = loadConfig();
    const srv = cfg.servers.find(s => s.id === id);
    if (!srv) return { error: 'Server not found' };
    if (runningServers[id]) return { error: 'Already running' };

    // EULA check
    const eulaFile = path.join(srv.dir, 'eula.txt');
    const eulaAccepted = fs.existsSync(eulaFile) &&
      fs.readFileSync(eulaFile, 'utf8').includes('eula=true');
    if (!eulaAccepted) return { needsEula: true };

    // Find jar
    let jar = path.join(srv.dir, 'server.jar');
    if (!fs.existsSync(jar)) {
      const jars = fs.readdirSync(srv.dir).filter(f => f.endsWith('.jar'));
      if (jars.length === 1) jar = path.join(srv.dir, jars[0]);
      else if (jars.length === 0) return { error: 'No .jar found in server directory' };
      else return { error: 'Multiple .jars found. Please rename one to server.jar' };
    }

    const javaPath = srv.javaPath || 'java';
    const args = [
      ...parsJavaArgs(srv.javaArgs || ''),
      `-Xmx${srv.ram}`,
      `-Xms${xmsFromRam(srv.ram)}`,
      '-jar', jar, 'nogui'
    ];

    const proc = spawn(javaPath, args, { cwd: srv.dir, shell: false });
    runningServers[id] = { process: proc, log: [] };

    proc.stdout.on('data', data => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => {
        runningServers[id]?.log.push({ time: Date.now(), text: line, type: 'out' });
        event.sender.send('server-log', { id, line, type: 'out' });
      });
    });

    proc.stderr.on('data', data => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => {
        runningServers[id]?.log.push({ time: Date.now(), text: line, type: 'err' });
        event.sender.send('server-log', { id, line, type: 'err' });
      });
    });

    proc.on('exit', (code) => {
      delete runningServers[id];
      event.sender.send('server-stopped', { id, code });
    });

    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('stop-server', (_, id) => {
  try {
    const s = runningServers[id];
    if (!s) return { error: 'Not running' };
    s.process.stdin.write('stop\n');
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('kill-server', (_, id) => {
  try {
    const s = runningServers[id];
    if (!s) return { error: 'Not running' };
    s.process.kill('SIGKILL');
    delete runningServers[id];
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('restart-server', async (event, id) => {
  try {
    const s = runningServers[id];
    if (s) {
      s.process.stdin.write('stop\n');
      await new Promise(resolve => {
        s.process.on('exit', resolve);
        setTimeout(resolve, 10000);
      });
    }
    return ipcMain.emit('start-server', event, id);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('send-command', (_, id, cmd) => {
  try {
    const s = runningServers[id];
    if (!s) return { error: 'Not running' };
    s.process.stdin.write(cmd + '\n');
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-server-log', (_, id) => {
  return runningServers[id]?.log || [];
});

ipcMain.handle('is-server-running', (_, id) => {
  return !!runningServers[id];
});

ipcMain.handle('ping-server', async (_, host, port) => {
  return pingServer(host, port);
});

// Profiles
ipcMain.handle('get-profiles', () => {
  try {
    const dirs = fs.readdirSync(PROFILES_DIR);
    const profiles = [];
    for (const d of dirs) {
      const metaFile = path.join(PROFILES_DIR, d, 'profile.json');
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          profiles.push({ ...meta, id: d });
        } catch {}
      }
    }
    return profiles;
  } catch { return []; }
});

ipcMain.handle('create-profile', (_, profileData) => {
  try {
    const id = 'profile_' + Date.now();
    const profileDir = path.join(PROFILES_DIR, id);
    fs.mkdirSync(profileDir, { recursive: true });
    const meta = {
      id,
      name: profileData.name,
      description: profileData.description || '',
      software: profileData.software || [],     // [] = any
      versions: profileData.versions || [],      // [] = any
      created: Date.now(),
    };
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify(meta, null, 2));
    return { success: true, profile: meta };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('delete-profile', (_, id) => {
  try {
    const profileDir = path.join(PROFILES_DIR, id);
    if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('open-profile-folder', (_, id) => {
  const profileDir = path.join(PROFILES_DIR, id);
  fs.mkdirSync(profileDir, { recursive: true });
  shell.openPath(profileDir);
  return { success: true };
});

ipcMain.handle('open-server-folder', (_, id) => {
  const cfg = loadConfig();
  const srv = cfg.servers.find(s => s.id === id);
  if (srv) shell.openPath(srv.dir);
  return { success: true };
});

// JDK detection
ipcMain.handle('detect-jdk', async () => {
  const common = [
    'java',
    '/usr/bin/java',
    '/usr/local/bin/java',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
  ];
  const found = [];
  for (const p of common) {
    try {
      await new Promise((resolve, reject) => {
        exec(`"${p}" -version`, (err, stdout, stderr) => {
          if (!err) {
            const match = (stderr + stdout).match(/version "([^"]+)"/);
            found.push({ path: p, version: match?.[1] || 'Unknown' });
            resolve();
          } else reject();
        });
      });
    } catch {}
  }
  return found;
});

ipcMain.handle('browse-java', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Java Executable',
    filters: [{ name: 'Java', extensions: ['exe', '*'] }],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('get-server-dir-stats', (_, id) => {
  try {
    const cfg = loadConfig();
    const srv = cfg.servers.find(s => s.id === id);
    if (!srv || !fs.existsSync(srv.dir)) return { size: 0 };
    const size = getDirSize(srv.dir);
    return { size };
  } catch { return { size: 0 }; }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'profile.json') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) size += getDirSize(full);
      else size += fs.statSync(full).size;
    }
  } catch {}
  return size;
}

function parsJavaArgs(argsStr) {
  return argsStr.split(/\s+/).filter(Boolean);
}

function xmsFromRam(ram) {
  const m = String(ram).match(/^(\d+)(M|G)$/i);
  if (!m) return '512M';
  const mb = m[2].toUpperCase() === 'G' ? parseInt(m[1]) * 1024 : parseInt(m[1]);
  return Math.min(512, mb) + 'M';
}

// ─── Update check ─────────────────────────────────────────────────────────────
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

ipcMain.handle('check-update', async () => {
  const current = app.getVersion();
  try {
    const data = await fetchJSON('https://api.github.com/repos/DippyCoder/MCPanel/releases/latest');
    const latest = String(data.tag_name).replace(/^v/, '');
    return { current, latest, hasUpdate: compareVersions(latest, current) > 0, url: data.html_url };
  } catch {
    return { current, latest: null, hasUpdate: false };
  }
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog({ title: 'Select Folder', properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

ipcMain.handle('scan-server-folder', (_, folderPath) => {
  try {
    const result = { port: 25565, software: null, version: null };
    const propsFile = path.join(folderPath, 'server.properties');
    if (fs.existsSync(propsFile)) {
      const props = fs.readFileSync(propsFile, 'utf8');
      const portMatch = props.match(/^server-port=(\d+)/m);
      if (portMatch) result.port = parseInt(portMatch[1]);
    }
    const softwareKeys = ['paper', 'purpur', 'leaf', 'fabric', 'velocity', 'spigot', 'vanilla'];
    const jars = fs.existsSync(folderPath) ? fs.readdirSync(folderPath).filter(f => f.endsWith('.jar')) : [];
    for (const jar of jars) {
      const lc = jar.toLowerCase();
      for (const key of softwareKeys) {
        if (lc.includes(key)) { result.software = key; break; }
      }
      if (result.software) break;
    }
    return result;
  } catch { return { port: 25565 }; }
});

ipcMain.handle('scan-profile-folder', (_, folderPath) => {
  try {
    const metaFile = path.join(folderPath, 'profile.json');
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      return { name: meta.name || '', description: meta.description || '', software: meta.software || [], versions: meta.versions || [] };
    }
    return {};
  } catch { return {}; }
});

ipcMain.handle('import-profile', (_, { folderPath, name, description, software, versions }) => {
  try {
    const id = 'profile_' + Date.now();
    const profileDir = path.join(PROFILES_DIR, id);
    fs.mkdirSync(profileDir, { recursive: true });
    copyDirSync(folderPath, profileDir);
    const meta = {
      id, name,
      description: description || '',
      software: software || [],
      versions: versions || [],
      created: Date.now(),
    };
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify(meta, null, 2));
    return { success: true, profile: meta };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('import-server', async (event, { folderPath, name, port, ram, software, version, javaPath, javaArgs }) => {
  try {
    const cfg = loadConfig();
    const id = 'srv_' + Date.now();
    const serverDir = path.join(SERVERS_DIR, id);
    event.sender.send('download-progress', { id, progress: 0, status: 'Copying server files...' });
    fs.mkdirSync(serverDir, { recursive: true });
    copyDirSync(folderPath, serverDir);
    const server = {
      id, name,
      port: port || 25565,
      ram: ram || '2G',
      storageLimit: null,
      software: software || 'paper',
      version: version || 'Unknown',
      profileId: null,
      javaPath: javaPath || 'java',
      javaArgs: javaArgs || '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200',
      created: Date.now(),
      dir: serverDir,
    };
    cfg.servers.push(server);
    saveConfig(cfg);
    event.sender.send('download-progress', { id, progress: 100, status: 'Done!' });
    return { success: true, server };
  } catch (e) {
    return { error: e.message };
  }
});

// ─── Themes ──────────────────────────────────────────────────────────────────

function findThemeJson(dir) {
  const root = path.join(dir, 'theme.json');
  if (fs.existsSync(root)) return root;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = path.join(dir, entry.name, 'theme.json');
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
}

async function installThemeFromZip(zipPath) {
  const extract = require('extract-zip');
  const id = 'theme_' + Date.now();
  const tempDir = path.join(THEMES_DIR, '_tmp_' + id);
  const themeDir = path.join(THEMES_DIR, id);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    await extract(zipPath, { dir: tempDir });

    const metaPath = findThemeJson(tempDir);
    if (!metaPath) throw new Error('theme.json not found in archive');

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta.name) throw new Error('theme.json must include a "name" field');

    const themeRoot = path.dirname(metaPath);
    fs.mkdirSync(themeDir, { recursive: true });
    copyDirSync(themeRoot, themeDir);
    // Also copy theme.json (copyDirSync skips profile.json, not theme.json, but be explicit)
    fs.copyFileSync(metaPath, path.join(themeDir, 'theme.json'));

    fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: true, theme: { ...meta, id, dir: themeDir } };
  } catch (e) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(themeDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

ipcMain.handle('get-themes', () => {
  const themes = [];
  try {
    for (const dir of fs.readdirSync(THEMES_DIR)) {
      if (dir.startsWith('_tmp_')) continue;
      const metaFile = path.join(THEMES_DIR, dir, 'theme.json');
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          themes.push({ ...meta, id: dir, dir: path.join(THEMES_DIR, dir) });
        } catch {}
      }
    }
  } catch {}
  return themes;
});

ipcMain.handle('get-theme-css', (_, id) => {
  if (!id) return null;
  const cssFile = path.join(THEMES_DIR, id, 'theme.css');
  if (!fs.existsSync(cssFile)) return null;
  let css = fs.readFileSync(cssFile, 'utf8');
  // Rewrite relative URLs (e.g. fonts/) to absolute file:// paths
  const themeDir = path.join(THEMES_DIR, id).replace(/\\/g, '/');
  css = css.replace(/url\(\s*['"]?(?!https?:|data:|file:)([^'")\s]+)['"]?\s*\)/g, (_, rel) => {
    return `url('file:///${themeDir}/${rel}')`;
  });
  return css;
});

ipcMain.handle('install-theme-url', async (_, url) => {
  const tmpZip = path.join(THEMES_DIR, '_download_' + Date.now() + '.zip');
  try {
    await downloadFile(url, tmpZip, () => {});
    const result = await installThemeFromZip(tmpZip);
    fs.unlinkSync(tmpZip);
    return result;
  } catch (e) {
    try { fs.unlinkSync(tmpZip); } catch {}
    return { error: e.message };
  }
});

ipcMain.handle('install-theme-file', async (_, filePath) => {
  try {
    return await installThemeFromZip(filePath);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('browse-theme-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Theme ZIP',
    filters: [{ name: 'Theme Archive', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

ipcMain.handle('delete-theme', (_, id) => {
  try {
    const themeDir = path.join(THEMES_DIR, id);
    if (fs.existsSync(themeDir)) fs.rmSync(themeDir, { recursive: true, force: true });
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('fetch-github-themes', async () => {
  try {
    const raw = await fetchText('https://raw.githubusercontent.com/DippyCoder/MCPanel/themes/themes-index.json');
    const data = JSON.parse(raw);
    return { themes: data.themes || [] };
  } catch (e) {
    return { themes: [], error: e.message };
  }
});

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d0d14',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'src/assets/icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  // Custom title bar controls
  ipcMain.on('window-minimize', () => mainWindow.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window-close', () => mainWindow.close());
}

function installBundledThemes() {
  const bundledDir = path.join(__dirname, 'src', 'themes');
  if (!fs.existsSync(bundledDir)) return;
  for (const name of fs.readdirSync(bundledDir)) {
    const src = path.join(bundledDir, name);
    const dest = path.join(THEMES_DIR, name);
    if (fs.statSync(src).isDirectory() && !fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
      copyDirSync(src, dest);
    }
  }
}

app.whenReady().then(() => {
  installBundledThemes();
  createWindow();
});
app.on('window-all-closed', () => {
  // Kill all running servers
  Object.values(runningServers).forEach(s => {
    try { s.process.kill('SIGKILL'); } catch {}
  });
  app.quit();
});
