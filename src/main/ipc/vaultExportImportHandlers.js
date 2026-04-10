/**
 * IPC handlers for vault JSON export/import and LastPass CSV file pick (SRP: file exchange + format validation).
 * Depends on injected collaborators (DIP): vault access, dialogs, crypto, fs.
 * @module ipc/vaultExportImportHandlers
 */

const { getSecretData } = require('../services/secretPayload');

const EXPORT_LOGINS_FORMAT = 'mimi-logins-export';
const EXPORT_NOTES_FORMAT = 'mimi-notes-export';
const EXPORT_API_KEYS_FORMAT = 'mimi-api-keys-export';
/** Serialization version for export files. Bump when changing export shape. */
const EXPORT_SERIALIZATION_VERSION = 1;

const EXPORT_NOTICE = 'Mimi export – sensitive data. Delete after use. Do not store in cloud or shared folders.';

function exportTypeLabel(t) {
  if (t === 'apiKeys') return 'API keys';
  if (t === 'logins') return 'logins';
  if (t === 'notes') return 'notes';
  return t || 'data';
}

function validateExportForImport(data, expectedFormat, expectedExportType) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid export file format' };
  }
  const format = data.format;
  const exportType =
    data.exportType ??
    (data.logins ? 'logins' : data.notes ? 'notes' : data.apiKeys ? 'apiKeys' : null);
  const version = data.serializationVersion ?? data.version;
  if (format !== expectedFormat) {
    const fileContains =
      exportType ||
      (format === EXPORT_NOTES_FORMAT
        ? 'notes'
        : format === EXPORT_LOGINS_FORMAT
          ? 'logins'
          : format === EXPORT_API_KEYS_FORMAT
            ? 'apiKeys'
            : null);
    if (fileContains && fileContains !== expectedExportType) {
      return {
        valid: false,
        error: `This file contains ${exportTypeLabel(fileContains)}, but you are importing ${exportTypeLabel(expectedExportType)}. Use Import ${exportTypeLabel(fileContains)} instead.`,
        errorCode: 'WRONG_EXPORT_TYPE',
        fileContains,
      };
    }
    return { valid: false, error: 'Invalid export file format' };
  }
  if (exportType != null && exportType !== expectedExportType) {
    return {
      valid: false,
      error: `This file contains ${exportTypeLabel(exportType)}, but you are importing ${exportTypeLabel(expectedExportType)}. Use Import ${exportTypeLabel(exportType)} instead.`,
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

function readAndParseExportFile(fsSync, filePath) {
  const raw = fsSync.readFileSync(filePath, 'utf8');
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

function extractNotesFromData(data) {
  if (!Array.isArray(data.notes)) return null;
  return (data.notes || []).map((entry) => ({
    name: entry.name ?? '',
    note: entry.note ?? '',
  }));
}

function extractApiKeysFromData(data) {
  if (!Array.isArray(data.apiKeys)) return null;
  return data.apiKeys.map((entry) => ({
    name: entry.name ?? '',
    password: entry.key_b64
      ? Buffer.from(entry.key_b64, 'base64').toString('utf8')
      : entry.password ?? '',
    comments: entry.comments ?? '',
    expiresOn: typeof entry.expiresOn === 'string' ? entry.expiresOn : '',
  }));
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {Object} deps
 * @param {Object} deps.IPC - channel name constants
 * @param {() => import('../services/VaultService') | null} deps.getVaultService
 * @param {() => import('electron').BrowserWindow | null | undefined} deps.getMainWindow
 * @param {typeof import('../services/CryptoService')} deps.CryptoService
 * @param {typeof import('fs')} deps.fs - sync fs API
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {import('electron').Dialog} deps.dialog
 */
function registerVaultExportImportHandlers(ipcMain, deps) {
  const { IPC, getVaultService, getMainWindow, CryptoService, fs, path, os, dialog } = deps;

  ipcMain.handle(IPC.VAULT_EXPORT_LOGINS, async (_event, logins, exportPassword = null) => {
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!Array.isArray(logins) || logins.length === 0) throw new Error('No logins selected');
    const mainWindow = getMainWindow();
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
      logins: logins.map((s) => {
        const d = getSecretData(s);
        return {
          name: s.name ?? '',
          url: d.url ?? s.url ?? '',
          username: d.username ?? s.username ?? '',
          password_b64: Buffer.from(d.password ?? s.password ?? '', 'utf8').toString('base64'),
          comments: d.comments ?? s.comments ?? '',
        };
      }),
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

  ipcMain.handle(IPC.VAULT_IMPORT_LOGINS, async () => {
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openFile'],
      title: 'Select logins export file',
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, error: null, logins: null, needsPassword: false };
    const filePath = result.filePaths[0];
    try {
      const data = readAndParseExportFile(fs, filePath);
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
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!filePath || !password) return { success: false, error: 'Password required', logins: null };
    try {
      const data = readAndParseExportFile(fs, filePath);
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
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    const mainWindow = getMainWindow();
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
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!Array.isArray(notes) || notes.length === 0) throw new Error('No notes selected');
    const mainWindow = getMainWindow();
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
      notes: notes.map((s) => {
        const d = getSecretData(s);
        return {
          name: s.name ?? '',
          note: d.note ?? s.note ?? '',
        };
      }),
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

  ipcMain.handle(IPC.VAULT_IMPORT_NOTES, async () => {
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openFile'],
      title: 'Select notes export file',
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, error: null, notes: null, needsPassword: false };
    const filePath = result.filePaths[0];
    try {
      const data = readAndParseExportFile(fs, filePath);
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
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!filePath || !password) return { success: false, error: 'Password required', notes: null };
    try {
      const data = readAndParseExportFile(fs, filePath);
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

  ipcMain.handle(IPC.VAULT_EXPORT_API_KEYS, async (_event, apiKeys, exportPassword = null) => {
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) throw new Error('No API keys selected');
    const mainWindow = getMainWindow();
    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultName = `api-keys-export-DELETE-AFTER-USE-${dateStr}.json`;
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: 'Export API keys',
      defaultPath: path.join(os.homedir(), 'Downloads', defaultName),
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, path: null };
    const filePath = result.filePath.endsWith('.json') ? result.filePath : `${result.filePath}.json`;
    const payload = {
      format: EXPORT_API_KEYS_FORMAT,
      exportType: 'apiKeys',
      serializationVersion: EXPORT_SERIALIZATION_VERSION,
      exportedAt: new Date().toISOString(),
      _notice: EXPORT_NOTICE,
      apiKeys: apiKeys.map((s) => {
        const d = getSecretData(s);
        const keyMaterial = d.key ?? s.password ?? '';
        return {
          name: s.name ?? '',
          key_b64: Buffer.from(keyMaterial, 'utf8').toString('base64'),
          comments: d.comments ?? s.comments ?? '',
          expiresOn:
            typeof d.expiresOn === 'string' ? d.expiresOn : typeof s.expiresOn === 'string' ? s.expiresOn : '',
        };
      }),
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    if (exportPassword && String(exportPassword).trim()) {
      const salt = CryptoService.generateSalt();
      const key = CryptoService.deriveKey(exportPassword, salt);
      const encrypted = CryptoService.encrypt(key, jsonStr);
      key.fill(0);
      const wrapped = {
        format: EXPORT_API_KEYS_FORMAT,
        exportType: 'apiKeys',
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

  ipcMain.handle(IPC.VAULT_IMPORT_API_KEYS, async () => {
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openFile'],
      title: 'Select API keys export file',
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, error: null, apiKeys: null, needsPassword: false };
    const filePath = result.filePaths[0];
    try {
      const data = readAndParseExportFile(fs, filePath);
      if (data.encrypted === true) {
        return { success: false, needsPassword: true, filePath, apiKeys: null };
      }
      const validation = validateExportForImport(data, EXPORT_API_KEYS_FORMAT, 'apiKeys');
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          errorCode: validation.errorCode,
          apiKeys: null,
          needsPassword: false,
        };
      }
      const apiKeys = extractApiKeysFromData(data);
      if (!apiKeys) return { success: false, error: 'Invalid export file format', apiKeys: null, needsPassword: false };
      return { success: true, error: null, apiKeys };
    } catch (err) {
      return {
        success: false,
        error: err?.message || 'Failed to read file',
        apiKeys: null,
        needsPassword: false,
      };
    }
  });

  ipcMain.handle(IPC.VAULT_IMPORT_API_KEYS_WITH_PASSWORD, async (_event, filePath, password) => {
    const vaultService = getVaultService();
    if (!vaultService?.isUnlocked()) throw new Error('Vault is locked');
    if (!filePath || !password) return { success: false, error: 'Password required', apiKeys: null };
    try {
      const data = readAndParseExportFile(fs, filePath);
      if (data.encrypted !== true || !data.salt_b64 || !data.data_b64) {
        return { success: false, error: 'File is not password protected', apiKeys: null };
      }
      const salt = Buffer.from(data.salt_b64, 'base64');
      const key = CryptoService.deriveKey(password, salt);
      const decrypted = CryptoService.decrypt(key, Buffer.from(data.data_b64, 'base64'));
      key.fill(0);
      const inner = JSON.parse(decrypted);
      const validation = validateExportForImport(inner, EXPORT_API_KEYS_FORMAT, 'apiKeys');
      if (!validation.valid) {
        return { success: false, error: validation.error || 'Wrong password', apiKeys: null };
      }
      const apiKeys = extractApiKeysFromData(inner);
      if (!apiKeys) return { success: false, error: 'Invalid export file format', apiKeys: null };
      return { success: true, error: null, apiKeys };
    } catch (err) {
      return {
        success: false,
        error: err?.message || 'Failed to decrypt (wrong password?)',
        apiKeys: null,
      };
    }
  });
}

module.exports = { registerVaultExportImportHandlers };
