const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcpanel', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  // Versions
  fetchVersions: (software, preRelease, unstable) => ipcRenderer.invoke('fetch-versions', software, preRelease, unstable),

  // Servers
  createServer: (data) => ipcRenderer.invoke('create-server', data),
  deleteServer: (id) => ipcRenderer.invoke('delete-server', id),
  updateServer: (id, updates) => ipcRenderer.invoke('update-server', id, updates),
  openServerFolder: (id) => ipcRenderer.invoke('open-server-folder', id),
  getServerDirStats: (id) => ipcRenderer.invoke('get-server-dir-stats', id),

  // Server control
  startServer: (id) => ipcRenderer.invoke('start-server', id),
  stopServer: (id) => ipcRenderer.invoke('stop-server', id),
  killServer: (id) => ipcRenderer.invoke('kill-server', id),
  restartServer: (id) => ipcRenderer.invoke('restart-server', id),
  sendCommand: (id, cmd) => ipcRenderer.invoke('send-command', id, cmd),
  getServerLog: (id) => ipcRenderer.invoke('get-server-log', id),
  isServerRunning: (id) => ipcRenderer.invoke('is-server-running', id),
  pingServer: (host, port) => ipcRenderer.invoke('ping-server', host, port),

  // Profiles
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  createProfile: (data) => ipcRenderer.invoke('create-profile', data),
  deleteProfile: (id) => ipcRenderer.invoke('delete-profile', id),
  openProfileFolder: (id) => ipcRenderer.invoke('open-profile-folder', id),

  // JDK
  detectJdk: () => ipcRenderer.invoke('detect-jdk'),
  browseJava: () => ipcRenderer.invoke('browse-java'),

  // Events
  on: (channel, cb) => {
    const allowed = ['server-log', 'server-stopped', 'download-progress'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => cb(...args));
  },
  off: (channel, cb) => ipcRenderer.removeListener(channel, cb),

  // EULA
  acceptEula: (id) => ipcRenderer.invoke('accept-eula', id),

  // Updates
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
});
