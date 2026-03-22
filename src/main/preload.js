/**
 * Preload script: runs in isolated context before renderer loads.
 * Exposes a minimal, safe API via contextBridge only (no nodeIntegration, no process/require).
 * Renderer can only call window.vault.* and window.app.*; all sensitive work is in main via IPC.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** App lifecycle / UI events (main → renderer) */
contextBridge.exposeInMainWorld('app', {
  onShowAbout: (callback) => {
    ipcRenderer.on('app:showAbout', (_event, data) => callback(data));
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  printHtml: (html) => ipcRenderer.invoke('app:printHtml', html),
  onLock: (callback) => {
    ipcRenderer.on('app:lock', () => callback());
  },
  onFocusUnlock: (callback) => {
    ipcRenderer.on('app:focusUnlock', () => callback());
  },
});

/** Vault, config, backup, theme: renderer invokes these; main handles in main.js */
contextBridge.exposeInMainWorld('vault', {
  unlock: (masterPassword) => ipcRenderer.invoke('vault:unlock', masterPassword),
  lock: () => ipcRenderer.invoke('vault:lock'),
  isUnlocked: () => ipcRenderer.invoke('vault:isUnlocked'),
  hasVault: () => ipcRenderer.invoke('vault:hasVault'),
  getSecrets: () => ipcRenderer.invoke('vault:getSecrets'),
  createSecret: (secret) => ipcRenderer.invoke('vault:createSecret', secret),
  updateSecret: (id, updates) => ipcRenderer.invoke('vault:updateSecret', id, updates),
  deleteSecret: (id) => ipcRenderer.invoke('vault:deleteSecret', id),
  changeMasterPassword: (currentPassword, newPassword) =>
    ipcRenderer.invoke('vault:changeMasterPassword', currentPassword, newPassword),
  deleteAll: () => ipcRenderer.invoke('vault:deleteAll'),
  getDataDirectory: () => ipcRenderer.invoke('vault:getDataDirectory'),
  backupData: () => ipcRenderer.invoke('vault:backupData'),
  restoreFromBackup: () => ipcRenderer.invoke('vault:restoreFromBackup'),
  exportLogins: (logins, password) => ipcRenderer.invoke('vault:exportLogins', logins, password),
  importLogins: () => ipcRenderer.invoke('vault:importLogins'),
  importLoginsWithPassword: (filePath, password) => ipcRenderer.invoke('vault:importLoginsWithPassword', filePath, password),
  exportNotes: (notes, password) => ipcRenderer.invoke('vault:exportNotes', notes, password),
  importNotes: () => ipcRenderer.invoke('vault:importNotes'),
  importNotesWithPassword: (filePath, password) => ipcRenderer.invoke('vault:importNotesWithPassword', filePath, password),
  selectAndReadLastPassCsv: () => ipcRenderer.invoke('vault:selectAndReadLastPassCsv'),
  selectDataDirectory: () => ipcRenderer.invoke('vault:selectDataDirectory'),
  setDataDirectory: (dirPath) => ipcRenderer.invoke('vault:setDataDirectory', dirPath),
  getTheme: () => ipcRenderer.invoke('vault:getTheme'),
  setTheme: (theme) => ipcRenderer.invoke('vault:setTheme', theme),
  getIdleLockMinutes: () => ipcRenderer.invoke('vault:getIdleLockMinutes'),
  setIdleLockMinutes: (minutes) => ipcRenderer.invoke('vault:setIdleLockMinutes', minutes),
});
