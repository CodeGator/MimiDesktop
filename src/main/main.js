/**
 * Electron main process: application lifecycle, window, tray, menu, and IPC.
 * Follows Single Responsibility per section: config, paths, window, tray, menu, IPC.
 * Renderer communicates only via contextBridge-exposed APIs (preload) and IPC.
 * @module main
 */

const { app, BrowserWindow, ipcMain, Menu, dialog, nativeImage, shell, Tray } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const extract = require('extract-zip');
const VaultService = require('./services/VaultService');
const CryptoService = require('./services/CryptoService');
const { registerVaultExportImportHandlers } = require('./ipc/vaultExportImportHandlers');

const packageJson = require(path.join(__dirname, '..', '..', 'package.json'));
const APP_NAME = packageJson.build?.productName || packageJson.name || 'Mimi Desktop';
const APP_VERSION = packageJson.version || '1.0.2';

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let helpWindow = null;
/** @type {BrowserWindow | null} */
let termsWindow = null;
/** @type {BrowserWindow | null} */
let privacyWindow = null;
/** @type {VaultService | null} */
let vaultService = null;
/** @type {Electron.Tray | null} */
let tray = null;

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
let failedAttempts = 0;
let lockoutEndTime = 0;

const CONFIG_FILE = 'config.json';
const BACKUP_FOLDER_NAME = 'backups';

/** IPC channel names (single source of truth; preload and renderer must match). */
const IPC = {
  VAULT_UNLOCK: 'vault:unlock',
  VAULT_LOCK: 'vault:lock',
  VAULT_IS_UNLOCKED: 'vault:isUnlocked',
  VAULT_HAS_VAULT: 'vault:hasVault',
  VAULT_GET_SECRETS: 'vault:getSecrets',
  VAULT_GET_DATA_FILE_SERIALIZATION_VERSION: 'vault:getDataFileSerializationVersion',
  VAULT_GET_FILE_ENVELOPE_VERSION: 'vault:getFileEnvelopeVersion',
  VAULT_CREATE_SECRET: 'vault:createSecret',
  VAULT_UPDATE_SECRET: 'vault:updateSecret',
  VAULT_DELETE_SECRET: 'vault:deleteSecret',
  VAULT_CHANGE_MASTER_PASSWORD: 'vault:changeMasterPassword',
  VAULT_DELETE_ALL: 'vault:deleteAll',
  VAULT_GET_DATA_DIRECTORY: 'vault:getDataDirectory',
  VAULT_GET_THEME: 'vault:getTheme',
  VAULT_SET_THEME: 'vault:setTheme',
  VAULT_GET_IDLE_LOCK_MINUTES: 'vault:getIdleLockMinutes',
  VAULT_SET_IDLE_LOCK_MINUTES: 'vault:setIdleLockMinutes',
  VAULT_SELECT_DATA_DIRECTORY: 'vault:selectDataDirectory',
  VAULT_BACKUP_DATA: 'vault:backupData',
  VAULT_RESTORE_FROM_BACKUP: 'vault:restoreFromBackup',
  VAULT_SET_DATA_DIRECTORY: 'vault:setDataDirectory',
  VAULT_EXPORT_LOGINS: 'vault:exportLogins',
  VAULT_IMPORT_LOGINS: 'vault:importLogins',
  VAULT_EXPORT_NOTES: 'vault:exportNotes',
  VAULT_IMPORT_NOTES: 'vault:importNotes',
  VAULT_EXPORT_API_KEYS: 'vault:exportApiKeys',
  VAULT_IMPORT_API_KEYS: 'vault:importApiKeys',
  VAULT_IMPORT_LOGINS_WITH_PASSWORD: 'vault:importLoginsWithPassword',
  VAULT_IMPORT_NOTES_WITH_PASSWORD: 'vault:importNotesWithPassword',
  VAULT_IMPORT_API_KEYS_WITH_PASSWORD: 'vault:importApiKeysWithPassword',
  VAULT_SELECT_AND_READ_LASTPASS_CSV: 'vault:selectAndReadLastPassCsv',
  APP_SHOW_ABOUT: 'app:showAbout',
  APP_OPEN_EXTERNAL: 'app:openExternal',
  APP_PRINT_HTML: 'app:printHtml',
  APP_LOCK: 'app:lock',
  APP_FOCUS_UNLOCK: 'app:focusUnlock',
};

// -----------------------------------------------------------------------------
// Config (Single Responsibility: persist/load app config)
// -----------------------------------------------------------------------------

/**
 * Path to the config file in Electron userData directory.
 * @returns {string}
 */
function getConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

/** @returns {string} Default directory for backup zip files (userData/backups). */
function getDefaultBackupDirectory() {
  return path.join(app.getPath('userData'), BACKUP_FOLDER_NAME);
}

/** Ensures backups directory exists; returns its path. @returns {string} */
function ensureBackupDirectoryExists() {
  const dir = getDefaultBackupDirectory();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @returns {Object} Config object (dataPath, theme, etc.); empty object if missing/invalid. */
function loadConfig() {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/** @param {Object} config - Config to persist */
function saveConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

// -----------------------------------------------------------------------------
// Paths (vault file, data dir, icons)
// -----------------------------------------------------------------------------

/** @returns {string} Directory where vault.enc and optional config live. */
function getDataDirectory() {
  const config = loadConfig();
  return config.dataPath || app.getPath('userData');
}

/** @returns {string} Absolute path to the encrypted vault file. */
function getVaultPath() {
  return path.join(getDataDirectory(), 'vault.enc');
}

/**
 * Path to app icon for window/taskbar (nd0021-{size}.png).
 * @param {number} [size=32] - Icon size in pixels
 * @returns {string}
 */
function getAppIconPath(size = 32) {
  const filename = `nd0021-${size}.png`;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'build', 'nd0021', filename);
  }
  return path.join(app.getAppPath(), 'build', 'nd0021', filename);
}

// -----------------------------------------------------------------------------
// Window (Single Responsibility: create and manage main BrowserWindow)
// -----------------------------------------------------------------------------

/** Creates the main app window with preload and hardened webPreferences (Step 6: IPC/code injection). */
function createWindow() {
  const iconPath = getAppIconPath(32);
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
  mainWindow = new BrowserWindow({
    width: 900,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: `${APP_NAME} - ${APP_VERSION}`,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
    },
    show: false,
  });

  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => mainWindow?.webContents?.closeDevTools());
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.setTitle(`${APP_NAME} - ${APP_VERSION}`);
    mainWindow?.show();
  });
  mainWindow.on('minimize', () => {
    if (vaultService?.isUnlocked()) {
      mainWindow?.webContents.send(IPC.APP_LOCK);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    vaultService = null;
  });
}

const TRAY_ICON_PATH = path.join('build', 'nd0021', 'nd0021-16.png');

// -----------------------------------------------------------------------------
// System tray
// -----------------------------------------------------------------------------

/** @returns {string} Path to 16px tray icon (packaged vs dev). */
function getTrayIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'build', 'nd0021', 'nd0021-16.png');
  }
  return path.join(app.getAppPath(), TRAY_ICON_PATH);
}

/** Fallback tray icon when build/nd0021 icon is missing */
function getTrayIconFallback() {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
    'FklEQVQ4T2NkYGD4z0ABYBw1gGE0DAAA//8DAAZZBLcAAAAASUVORK5CYII=';
  return nativeImage.createFromDataURL('data:image/png;base64,' + base64);
}

function createTray() {
  const iconPath = getTrayIconPath();
  let icon =
    fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
  if (!icon || icon.isEmpty()) icon = getTrayIconFallback();
  if (icon.isEmpty()) return;
  const size = 16;
  if (icon.getSize().width !== size || icon.getSize().height !== size) {
    icon = icon.resize({ width: size, height: size });
  }
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show mimi-desktop', click: () => mainWindow?.show?.() && mainWindow.focus() },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

/** Path to the About dialog icon (alligator). Uses assets/icon.png when present. */
function getAboutIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'icon.png');
  }
  const inAssets = path.join(app.getAppPath(), 'assets', 'icon.png');
  const inBuild = path.join(app.getAppPath(), 'build', 'icon.png');
  return fs.existsSync(inAssets) ? inAssets : inBuild;
}

/** Shows About in renderer (focus window, send name/version/icon). */
function showAboutDialog() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  const iconPath = getAboutIconPath();
  let iconDataUrl = null;
  if (fs.existsSync(iconPath)) {
    const buf = fs.readFileSync(iconPath);
    iconDataUrl = nativeImage.createFromBuffer(buf).toDataURL();
  }
  mainWindow.webContents.send(IPC.APP_SHOW_ABOUT, {
    name: APP_NAME,
    version: APP_VERSION,
    iconDataUrl,
  });
}

/** Opens the Help window (focuses if already open). */
function openHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.show();
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 400,
    minHeight: 400,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  helpWindow.setMenuBarVisibility(false);
  helpWindow.loadFile(path.join(__dirname, '..', 'renderer', 'help.html'));
  helpWindow.once('ready-to-show', () => {
    const config = loadConfig();
    const theme = config.theme || 'dark';
    helpWindow?.webContents?.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});`
    ).catch(() => {});
    helpWindow?.show();
  });
  helpWindow.on('closed', () => {
    helpWindow = null;
  });
}

/** Opens a document window (terms or privacy). Reuses openDoc if provided. */
function openDocWindow(openDoc, filename) {
  if (openDoc && !openDoc.isDestroyed()) {
    openDoc.show();
    openDoc.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 400,
    minHeight: 400,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', filename));
  win.once('ready-to-show', () => {
    const config = loadConfig();
    const theme = config.theme || 'dark';
    win.webContents?.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});`
    ).catch(() => {});
    win.show();
  });
  return win;
}

/** Opens the Terms of Service window (focuses if already open). */
function openTermsWindow() {
  const win = openDocWindow(termsWindow, 'terms.html');
  if (!win) return;
  termsWindow = win;
  win.on('closed', () => {
    termsWindow = null;
  });
}

/** Opens the Privacy window (focuses if already open). */
function openPrivacyWindow() {
  const win = openDocWindow(privacyWindow, 'privacy.html');
  if (!win) return;
  privacyWindow = win;
  win.on('closed', () => {
    privacyWindow = null;
  });
}

/** Builds and sets the app menu (File: Lock, Unlock, Exit; Help: Help, About). */
function setApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Lock',
          accelerator: 'CommandOrControl+Shift+L',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.APP_LOCK);
            }
          },
        },
        {
          label: 'Unlock',
          accelerator: 'CommandOrControl+Shift+U',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.send(IPC.APP_FOCUS_UNLOCK);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Exit',
          role: 'quit',
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Welcome',
          click: () => openHelpWindow(),
        },
        {
          label: 'Terms of Service',
          click: () => openTermsWindow(),
        },
        {
          label: 'Privacy',
          click: () => openPrivacyWindow(),
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => showAboutDialog(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -----------------------------------------------------------------------------
// Printout: system print dialog (physical printer, Microsoft Print to PDF, etc.)
// -----------------------------------------------------------------------------

/**
 * @param {string} html
 * @returns {string} Path to a UTF-8 temp .html file (caller should delete when done).
 */
function writePrintTempHtmlFile(html) {
  const tempDir = path.join(app.getPath('temp'), 'mimi-desktop-print');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempHtml = path.join(tempDir, `print-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tempHtml, html, 'utf8');
  return tempHtml;
}

/**
 * Hidden window + system print dialog (physical printer, “Print to PDF”, etc.).
 * Waits for layout/paint before opening the dialog so virtual printers get a real page.
 * @param {string} html
 * @returns {Promise<{ success: boolean, canceled?: boolean, error?: string }>}
 */
async function printHtmlWithSystemDialog(html) {
  const tempHtml = writePrintTempHtmlFile(html);
  const printWin = new BrowserWindow({
    width: 816,
    height: 1056,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  });
  try {
    await printWin.loadFile(tempHtml);
    try {
      await printWin.webContents.executeJavaScript(
        `new Promise(function (resolve) {
          requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
        });`,
      );
    } catch {
      // Continue; print may still work without an extra paint tick.
    }
    return await new Promise((resolve) => {
      printWin.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
        if (success) resolve({ success: true });
        else if (failureReason === 'cancelled' || failureReason === 'canceled')
          resolve({ success: false, canceled: true });
        else resolve({ success: false, error: String(failureReason || 'Print failed') });
      });
    });
  } finally {
    printWin.destroy();
    try {
      fs.unlinkSync(tempHtml);
    } catch {
      // ignore
    }
  }
}

// -----------------------------------------------------------------------------
// IPC handlers (bridge renderer ↔ main; vault, config, backup, theme)
// -----------------------------------------------------------------------------

function registerIpcHandlers() {
  ipcMain.handle(IPC.VAULT_UNLOCK, async (_event, masterPassword) => {
    const now = Date.now();
    if (lockoutEndTime > now) {
      lockoutEndTime = now + LOCKOUT_MS;
      const remainingMinutes = Math.ceil(LOCKOUT_MS / 60000);
      throw new Error(`Too many failed attempts. Locked out for ${remainingMinutes} minutes.`);
    }
    vaultService = new VaultService(getVaultPath());
    try {
      const result = await vaultService.unlock(masterPassword);
      failedAttempts = 0;
      lockoutEndTime = 0;
      return result;
    } catch (err) {
      failedAttempts++;
      if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
        lockoutEndTime = now + LOCKOUT_MS;
        const remainingMinutes = Math.ceil(LOCKOUT_MS / 60000);
        throw new Error(`Too many failed attempts. Locked out for ${remainingMinutes} minutes.`);
      }
      throw err;
    }
  });

  ipcMain.handle(IPC.VAULT_LOCK, async () => {
    if (vaultService) {
      vaultService.lock();
      vaultService = null;
    }
    return true;
  });

  ipcMain.handle(IPC.VAULT_IS_UNLOCKED, () => Boolean(vaultService?.isUnlocked()));

  ipcMain.handle(IPC.VAULT_HAS_VAULT, () => fs.existsSync(getVaultPath()));

  ipcMain.handle(IPC.VAULT_GET_SECRETS, async () => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    return vaultService.getSecrets();
  });

  ipcMain.handle(IPC.VAULT_GET_DATA_FILE_SERIALIZATION_VERSION, () => {
    if (!vaultService?.isUnlocked()) return null;
    return vaultService.getVaultDataFileSerializationVersion();
  });

  /** Top-level `version` in vault.enc (salt + ciphertext wrapper), readable without unlocking. */
  ipcMain.handle(IPC.VAULT_GET_FILE_ENVELOPE_VERSION, () => {
    const vaultPath = getVaultPath();
    if (!fs.existsSync(vaultPath)) return null;
    try {
      const header = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
      if (!header || typeof header !== 'object') return null;
      const v = header.version;
      return typeof v === 'number' && Number.isFinite(v) ? v : 1;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.VAULT_CREATE_SECRET, async (_event, secret) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    return vaultService.createSecret(secret);
  });

  ipcMain.handle(IPC.VAULT_UPDATE_SECRET, async (_event, id, updates) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    return vaultService.updateSecret(id, updates);
  });

  ipcMain.handle(IPC.VAULT_DELETE_SECRET, async (_event, id) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    return vaultService.deleteSecret(id);
  });

  ipcMain.handle(IPC.VAULT_CHANGE_MASTER_PASSWORD, async (_event, currentPassword, newPassword) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    return vaultService.changeMasterPassword(currentPassword, newPassword);
  });

  ipcMain.handle(IPC.VAULT_DELETE_ALL, async () => {
    if (vaultService) {
      vaultService.lock();
      vaultService = null;
    }
    const vaultPath = getVaultPath();
    if (fs.existsSync(vaultPath)) {
      fs.unlinkSync(vaultPath);
    }
    return true;
  });

  ipcMain.handle(IPC.VAULT_GET_DATA_DIRECTORY, () => getDataDirectory());

  ipcMain.handle(IPC.VAULT_GET_THEME, () => {
    const config = loadConfig();
    return config.theme || 'dark';
  });

  ipcMain.handle(IPC.VAULT_SET_THEME, async (_event, theme) => {
    if (theme !== 'light' && theme !== 'dark') return false;
    const config = loadConfig();
    config.theme = theme;
    saveConfig(config);
    return true;
  });

  const IDLE_LOCK_VALID_MINUTES = [0, 5, 10, 15, 30];
  ipcMain.handle(IPC.VAULT_GET_IDLE_LOCK_MINUTES, () => {
    const config = loadConfig();
    const v = config.idleLockMinutes;
    return IDLE_LOCK_VALID_MINUTES.includes(v) ? v : 10;
  });
  ipcMain.handle(IPC.VAULT_SET_IDLE_LOCK_MINUTES, async (_event, minutes) => {
    const m = Number(minutes);
    if (!Number.isInteger(m) || !IDLE_LOCK_VALID_MINUTES.includes(m)) return false;
    const config = loadConfig();
    config.idleLockMinutes = m;
    saveConfig(config);
    return true;
  });

  ipcMain.handle(IPC.VAULT_SELECT_DATA_DIRECTORY, async () => {
    const defaultPath = getDataDirectory();
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openDirectory'],
      title: 'Select data folder',
      defaultPath,
    });
    if (result.canceled) return null;
    return result.filePaths[0] || null;
  });

  ipcMain.handle(IPC.VAULT_BACKUP_DATA, async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `backup-${timestamp}.zip`;
    const backupDir = ensureBackupDirectoryExists();
    const defaultPath = path.join(backupDir, defaultName);
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: 'Save backup',
      defaultPath,
      filters: [{ name: 'Zip files', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, path: null };
    const zipPath = result.filePath.endsWith('.zip') ? result.filePath : `${result.filePath}.zip`;
    const vaultPath = getVaultPath();
    const configPath = getConfigPath();
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    await new Promise((resolve, reject) => {
      archive.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      archive.pipe(output);
      if (fs.existsSync(vaultPath)) {
        archive.file(vaultPath, { name: 'vault.enc' });
      }
      if (fs.existsSync(configPath)) {
        archive.file(configPath, { name: 'config.json' });
      }
      archive.finalize();
    });
    return { success: true, path: zipPath };
  });

  ipcMain.handle(IPC.VAULT_RESTORE_FROM_BACKUP, async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openFile'],
      title: 'Select backup file',
      filters: [{ name: 'Zip files', extensions: ['zip'] }],
    });
    if (result.canceled) return { success: false, error: null };
    const zipPath = result.filePaths[0];
    if (!zipPath) return { success: false, error: null };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-restore-'));
    try {
      await extract(zipPath, { dir: tempDir });
      const backupVault = path.join(tempDir, 'vault.enc');
      if (!fs.existsSync(backupVault)) {
        return { success: false, error: 'Backup file must contain vault.enc' };
      }
      if (vaultService) {
        vaultService.lock();
        vaultService = null;
      }
      const backupConfig = path.join(tempDir, 'config.json');
      const configPath = getConfigPath();
      if (fs.existsSync(backupConfig)) {
        const restoredConfig = JSON.parse(fs.readFileSync(backupConfig, 'utf8'));
        let dataDir = restoredConfig.dataPath || app.getPath('userData');
        try {
          fs.mkdirSync(dataDir, { recursive: true });
        } catch {
          dataDir = app.getPath('userData');
          restoredConfig.dataPath = dataDir;
        }
        fs.copyFileSync(backupVault, path.join(dataDir, 'vault.enc'));
        saveConfig(restoredConfig);
      } else {
        const dataDir = getDataDirectory();
        fs.mkdirSync(dataDir, { recursive: true });
        fs.copyFileSync(backupVault, path.join(dataDir, 'vault.enc'));
      }
      return { success: true };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  registerVaultExportImportHandlers(ipcMain, {
    IPC,
    getVaultService: () => vaultService,
    getMainWindow: () => mainWindow,
    CryptoService,
    fs,
    path,
    os,
    dialog,
  });


  ipcMain.handle(IPC.VAULT_SET_DATA_DIRECTORY, async (_event, newPath) => {
    if (!newPath || typeof newPath !== 'string') return false;
    const currentDir = getDataDirectory();
    const currentVault = path.join(currentDir, 'vault.enc');
    const newVault = path.join(newPath, 'vault.enc');
    if (currentDir !== newPath && fs.existsSync(currentVault)) {
      fs.copyFileSync(currentVault, newVault);
    }
    if (vaultService) {
      vaultService.lock();
      vaultService = null;
    }
    const config = loadConfig();
    config.dataPath = newPath;
    saveConfig(config);
    return true;
  });

  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, async (_event, url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle(IPC.APP_PRINT_HTML, async (_event, html) => {
    if (typeof html !== 'string' || !html.trim()) {
      return { success: false, error: 'Nothing to print.' };
    }
    try {
      return await printHtmlWithSystemDialog(html);
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}

// -----------------------------------------------------------------------------
// Single instance: only one app window; second launch focuses the first
// -----------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!gotTheLock) return;
  registerIpcHandlers();
  createWindow();
  setApplicationMenu();
  createTray();
});

app.on('window-all-closed', () => {
  vaultService = null;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
});
