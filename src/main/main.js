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

const packageJson = require(path.join(__dirname, '..', '..', 'package.json'));
const APP_NAME = packageJson.build?.productName || packageJson.name || 'Mimi Desktop';
const APP_VERSION = packageJson.version || '1.0.0';

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
  VAULT_IMPORT_LOGINS_WITH_PASSWORD: 'vault:importLoginsWithPassword',
  VAULT_IMPORT_NOTES_WITH_PASSWORD: 'vault:importNotesWithPassword',
  VAULT_SELECT_AND_READ_LASTPASS_CSV: 'vault:selectAndReadLastPassCsv',
  APP_SHOW_ABOUT: 'app:showAbout',
  APP_OPEN_EXTERNAL: 'app:openExternal',
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

  const EXPORT_LOGINS_FORMAT = 'mimi-logins-export';
  const EXPORT_NOTES_FORMAT = 'mimi-notes-export';
  /** Serialization version for export files. Bump when changing export shape; import rejects higher versions. */
  const EXPORT_SERIALIZATION_VERSION = 1;

  function validateExportForImport(data, expectedFormat, expectedExportType) {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Invalid export file format' };
    }
    const format = data.format;
    const exportType = data.exportType ?? (data.logins ? 'logins' : data.notes ? 'notes' : null);
    const version = data.serializationVersion ?? data.version;
    if (format !== expectedFormat) {
      const fileContains = exportType || (format === EXPORT_NOTES_FORMAT ? 'notes' : format === EXPORT_LOGINS_FORMAT ? 'logins' : null);
      if (fileContains && fileContains !== expectedExportType) {
        return {
          valid: false,
          error: `This file contains ${fileContains}, but you are importing ${expectedExportType}. Use Import ${fileContains} instead.`,
          errorCode: 'WRONG_EXPORT_TYPE',
          fileContains,
        };
      }
      return { valid: false, error: 'Invalid export file format' };
    }
    if (exportType != null && exportType !== expectedExportType) {
      return {
        valid: false,
        error: `This file contains ${exportType}, but you are importing ${expectedExportType}. Use Import ${exportType} instead.`,
        errorCode: 'WRONG_EXPORT_TYPE',
        fileContains: exportType,
      };
    }
    if (version == null || typeof version !== 'number') {
      return { valid: false, error: 'Invalid export file format (missing serialization version)' };
    }
    if (version > EXPORT_SERIALIZATION_VERSION) {
      return {
        valid: false,
        error: 'This file was created by a newer version of the application. Please upgrade to import it.',
      };
    }
    return { valid: true };
  }

  const EXPORT_NOTICE = 'Mimi export – sensitive data. Delete after use. Do not store in cloud or shared folders.';

  ipcMain.handle(IPC.VAULT_EXPORT_LOGINS, async (_event, logins, exportPassword = null) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!Array.isArray(logins) || logins.length === 0) throw new Error('No logins selected');
    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultName = `logins-export-DELETE-AFTER-USE-${dateStr}.json`;
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: 'Export logins',
      defaultPath: path.join(os.homedir(), 'Downloads', defaultName),
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, path: null };
    const filePath = result.filePath.endsWith('.json') ? result.filePath : `${result.filePath}.json`;
    const payload = {
      format: EXPORT_LOGINS_FORMAT,
      exportType: 'logins',
      serializationVersion: EXPORT_SERIALIZATION_VERSION,
      exportedAt: new Date().toISOString(),
      _notice: EXPORT_NOTICE,
      logins: logins.map((s) => ({
        name: s.name ?? '',
        url: s.url ?? '',
        username: s.username ?? '',
        password_b64: Buffer.from(s.password ?? '', 'utf8').toString('base64'),
        comments: s.comments ?? '',
      })),
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    if (exportPassword && String(exportPassword).trim()) {
      const salt = CryptoService.generateSalt();
      const key = CryptoService.deriveKey(exportPassword, salt);
      const encrypted = CryptoService.encrypt(key, jsonStr);
      key.fill(0);
      const wrapped = {
        format: EXPORT_LOGINS_FORMAT,
        exportType: 'logins',
        serializationVersion: EXPORT_SERIALIZATION_VERSION,
        encrypted: true,
        salt_b64: salt.toString('base64'),
        data_b64: encrypted.toString('base64'),
      };
      fs.writeFileSync(filePath, JSON.stringify(wrapped, null, 2), 'utf8');
    } else {
      fs.writeFileSync(filePath, jsonStr, 'utf8');
    }
    return { success: true, path: filePath };
  });

  function readAndParseExportFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }

  function extractLoginsFromData(data) {
    if (!Array.isArray(data.logins)) return null;
    return data.logins.map((entry) => ({
      name: entry.name ?? '',
      url: entry.url ?? '',
      username: entry.username ?? '',
      password: entry.password_b64
        ? Buffer.from(entry.password_b64, 'base64').toString('utf8')
        : entry.password ?? '',
      comments: entry.comments ?? '',
    }));
  }

  ipcMain.handle(IPC.VAULT_IMPORT_LOGINS, async () => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openFile'],
      title: 'Select logins export file',
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, error: null, logins: null, needsPassword: false };
    const filePath = result.filePaths[0];
    try {
      const data = readAndParseExportFile(filePath);
      if (data.encrypted === true) {
        return { success: false, needsPassword: true, filePath, logins: null };
      }
      const validation = validateExportForImport(data, EXPORT_LOGINS_FORMAT, 'logins');
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          errorCode: validation.errorCode,
          logins: null,
          needsPassword: false,
        };
      }
      const logins = extractLoginsFromData(data);
      if (!logins) return { success: false, error: 'Invalid export file format', logins: null, needsPassword: false };
      return { success: true, error: null, logins };
    } catch (err) {
      return {
        success: false,
        error: err?.message || 'Failed to read file',
        logins: null,
        needsPassword: false,
      };
    }
  });

  ipcMain.handle(IPC.VAULT_IMPORT_LOGINS_WITH_PASSWORD, async (_event, filePath, password) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!filePath || !password) return { success: false, error: 'Password required', logins: null };
    try {
      const data = readAndParseExportFile(filePath);
      if (data.encrypted !== true || !data.salt_b64 || !data.data_b64) {
        return { success: false, error: 'File is not password protected', logins: null };
      }
      const salt = Buffer.from(data.salt_b64, 'base64');
      const key = CryptoService.deriveKey(password, salt);
      const decrypted = CryptoService.decrypt(key, Buffer.from(data.data_b64, 'base64'));
      key.fill(0);
      const inner = JSON.parse(decrypted);
      const validation = validateExportForImport(inner, EXPORT_LOGINS_FORMAT, 'logins');
      if (!validation.valid) {
        return { success: false, error: validation.error || 'Wrong password', logins: null };
      }
      const logins = extractLoginsFromData(inner);
      if (!logins) return { success: false, error: 'Invalid export file format', logins: null };
      return { success: true, error: null, logins };
    } catch (err) {
      return {
        success: false,
        error: err?.message || 'Failed to decrypt (wrong password?)',
        logins: null,
      };
    }
  });

  ipcMain.handle(IPC.VAULT_SELECT_AND_READ_LASTPASS_CSV, async () => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openFile'],
      title: 'Select LastPass CSV file',
      filters: [{ name: 'CSV files', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, error: 'No file selected', content: null };
    const filePath = result.filePaths[0];
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return { success: true, content, error: null };
    } catch (err) {
      return { success: false, error: err?.message || 'Failed to read file', content: null };
    }
  });

  ipcMain.handle(IPC.VAULT_EXPORT_NOTES, async (_event, notes, exportPassword = null) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!Array.isArray(notes) || notes.length === 0) throw new Error('No notes selected');
    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultName = `notes-export-DELETE-AFTER-USE-${dateStr}.json`;
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: 'Export notes',
      defaultPath: path.join(os.homedir(), 'Downloads', defaultName),
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, path: null };
    const filePath = result.filePath.endsWith('.json') ? result.filePath : `${result.filePath}.json`;
    const payload = {
      format: EXPORT_NOTES_FORMAT,
      exportType: 'notes',
      serializationVersion: EXPORT_SERIALIZATION_VERSION,
      exportedAt: new Date().toISOString(),
      _notice: EXPORT_NOTICE,
      notes: notes.map((s) => ({
        name: s.name ?? '',
        note: s.note ?? '',
      })),
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    if (exportPassword && String(exportPassword).trim()) {
      const salt = CryptoService.generateSalt();
      const key = CryptoService.deriveKey(exportPassword, salt);
      const encrypted = CryptoService.encrypt(key, jsonStr);
      key.fill(0);
      const wrapped = {
        format: EXPORT_NOTES_FORMAT,
        exportType: 'notes',
        serializationVersion: EXPORT_SERIALIZATION_VERSION,
        encrypted: true,
        salt_b64: salt.toString('base64'),
        data_b64: encrypted.toString('base64'),
      };
      fs.writeFileSync(filePath, JSON.stringify(wrapped, null, 2), 'utf8');
    } else {
      fs.writeFileSync(filePath, jsonStr, 'utf8');
    }
    return { success: true, path: filePath };
  });

  function extractNotesFromData(data) {
    if (!Array.isArray(data.notes)) return null;
    return (data.notes || []).map((entry) => ({
      name: entry.name ?? '',
      note: entry.note ?? '',
    }));
  }

  ipcMain.handle(IPC.VAULT_IMPORT_NOTES, async () => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openFile'],
      title: 'Select notes export file',
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, error: null, notes: null, needsPassword: false };
    const filePath = result.filePaths[0];
    try {
      const data = readAndParseExportFile(filePath);
      if (data.encrypted === true) {
        return { success: false, needsPassword: true, filePath, notes: null };
      }
      const validation = validateExportForImport(data, EXPORT_NOTES_FORMAT, 'notes');
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          errorCode: validation.errorCode,
          notes: null,
          needsPassword: false,
        };
      }
      const notes = extractNotesFromData(data);
      if (!notes) return { success: false, error: 'Invalid export file format', notes: null, needsPassword: false };
      return { success: true, error: null, notes };
    } catch (err) {
      return {
        success: false,
        error: err?.message || 'Failed to read file',
        notes: null,
        needsPassword: false,
      };
    }
  });

  ipcMain.handle(IPC.VAULT_IMPORT_NOTES_WITH_PASSWORD, async (_event, filePath, password) => {
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!filePath || !password) return { success: false, error: 'Password required', notes: null };
    try {
      const data = readAndParseExportFile(filePath);
      if (data.encrypted !== true || !data.salt_b64 || !data.data_b64) {
        return { success: false, error: 'File is not password protected', notes: null };
      }
      const salt = Buffer.from(data.salt_b64, 'base64');
      const key = CryptoService.deriveKey(password, salt);
      const decrypted = CryptoService.decrypt(key, Buffer.from(data.data_b64, 'base64'));
      key.fill(0);
      const inner = JSON.parse(decrypted);
      const validation = validateExportForImport(inner, EXPORT_NOTES_FORMAT, 'notes');
      if (!validation.valid) {
        return { success: false, error: validation.error || 'Wrong password', notes: null };
      }
      const notes = extractNotesFromData(inner);
      if (!notes) return { success: false, error: 'Invalid export file format', notes: null };
      return { success: true, error: null, notes };
    } catch (err) {
      return {
        success: false,
        error: err?.message || 'Failed to decrypt (wrong password?)',
        notes: null,
      };
    }
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
