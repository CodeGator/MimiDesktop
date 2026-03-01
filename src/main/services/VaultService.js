/**
 * Vault service: encrypted file storage for secrets (passwords and notes).
 * Single Responsibility: unlock/lock vault with master password, CRUD secrets, persist encrypted.
 * Depends on CryptoService for key derivation and AES-GCM; file I/O is async.
 * @module services/VaultService
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const CryptoService = require('./CryptoService');

/** Version of the vault file header (salt + encrypted blob layout). */
const VAULT_VERSION = 1;
/** Version of the decrypted payload (secrets structure). Bump when changing payload shape. */
const SERIALIZATION_VERSION = 1;

/**
 * In-memory representation of a single secret (password or note).
 */
class Secret {
  /**
   * @param {Object} options
   * @param {string} [options.id]
   * @param {string} options.name
   * @param {'password'|'note'} options.type
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {string} [options.url]
   * @param {string} [options.comments]
   * @param {string} [options.note]
   * @param {number} [options.createdAt]
   * @param {number} [options.updatedAt]
   */
  constructor({ id, name, type, username = '', password = '', url = '', comments = '', note = '', createdAt, updatedAt }) {
    this.id = id ?? crypto.randomUUID();
    this.name = name ?? '';
    this.type = type ?? 'password';
    this.username = username ?? '';
    this.password = password ?? '';
    this.url = url ?? '';
    this.comments = comments ?? '';
    this.note = note ?? '';
    const now = Date.now();
    this.createdAt = createdAt ?? now;
    this.updatedAt = updatedAt ?? now;
  }

  /**
   * Returns a plain object suitable for JSON and IPC (no methods).
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      username: this.username,
      password: this.password,
      url: this.url,
      comments: this.comments,
      note: this.note,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * @param {Object} obj - Plain object from JSON/payload
   * @returns {Secret}
   */
  static fromJSON(obj) {
    return new Secret(obj);
  }
}

/**
 * Manages the encrypted vault file: unlock with master password, CRUD secrets, persist encrypted.
 */
class VaultService {
  /**
   * @param {string} vaultPath - Absolute path to the vault file
   */
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    /** @type {Buffer | null} */
    this._key = null;
    /** @type {Secret[]} */
    this._secrets = [];
  }

  /**
   * Unlocks the vault with the master password. Creates a new vault if the file does not exist.
   * @param {string} masterPassword
   * @returns {{ created: boolean }} created true if a new vault was created
   */
  async unlock(masterPassword) {
    if (!masterPassword || typeof masterPassword !== 'string') {
      throw new Error('Master password is required');
    }
    try {
      const raw = await fs.readFile(this.vaultPath);
      const header = JSON.parse(raw.toString('utf8'));
      const headerVersion = header.version ?? 1;
      if (headerVersion > VAULT_VERSION) {
        throw new Error('This vault was created by a newer version of the application. Please upgrade to open it.');
      }
      if (headerVersion !== VAULT_VERSION || !header.salt || !header.data) {
        throw new Error('Invalid vault format');
      }
      const salt = Buffer.from(header.salt, 'base64');
      const data = Buffer.from(header.data, 'base64');
      this._key = CryptoService.deriveKey(masterPassword, salt);
      const plaintext = CryptoService.decrypt(this._key, data);
      const payload = JSON.parse(plaintext);
      const dataVersion = payload.serializationVersion ?? 1;
      if (dataVersion > SERIALIZATION_VERSION) {
        throw new Error('This vault was created by a newer version of the application. Please upgrade to open it.');
      }
      this._secrets = (payload.secrets ?? []).map((s) => Secret.fromJSON(s));
      return { created: false };
    } catch (err) {
      if (err.code === 'ENOENT') {
        const salt = CryptoService.generateSalt();
        this._key = CryptoService.deriveKey(masterPassword, salt);
        this._secrets = [];
        await this._persist(salt);
        return { created: true };
      }
      if (
        err.message &&
        (err.message.includes('Invalid') ||
          err.message.includes('decrypt') ||
          err.message.includes('authenticate') ||
          err.message.includes('Unsupported state'))
      ) {
        throw new Error('Invalid Password');
      }
      throw err;
    }
  }

  /**
   * Clears the in-memory key and secrets. Does not overwrite the file.
   */
  lock() {
    if (this._key) {
      this._key.fill(0);
    }
    this._key = null;
    this._secrets = [];
  }

  isUnlocked() {
    return this._key !== null;
  }

  /**
   * Reads salt from existing vault file (for re-encrypt on password change).
   * @private
   */
  async _readSalt() {
    const raw = await fs.readFile(this.vaultPath);
    const header = JSON.parse(raw.toString('utf8'));
    return Buffer.from(header.salt, 'base64');
  }

  /**
   * Encrypts current secrets and writes vault file (header: version, salt, base64 data).
   * @private
   * @param {Buffer | null} salt - If null, reuses salt from existing file or generates new one
   */
  async _persist(salt = null) {
    if (!this._key) throw new Error('Vault is locked');
    const payload = JSON.stringify({
      serializationVersion: SERIALIZATION_VERSION,
      secrets: this._secrets.map((s) => s.toJSON()),
    });
    const data = CryptoService.encrypt(this._key, payload);
    let useSalt = salt;
    if (!useSalt) {
      try {
        useSalt = await this._readSalt();
      } catch {
        useSalt = CryptoService.generateSalt();
      }
    }
    const header = {
      version: VAULT_VERSION,
      salt: useSalt.toString('base64'),
      data: data.toString('base64'),
    };
    await fs.writeFile(this.vaultPath, JSON.stringify(header), 'utf8');
  }

  /** @returns {Object[]} Array of plain secret objects for IPC/renderer. */
  getSecrets() {
    if (!this._key) throw new Error('Vault is locked');
    return this._secrets.map((s) => s.toJSON());
  }

  /**
   * @param {{ name: string, type: 'password'|'note', username?: string, password?: string, url?: string, note?: string }} input
   * @returns {Object} Created secret (toJSON)
   */
  createSecret(input) {
    if (!this._key) throw new Error('Vault is locked');
    const secret = new Secret({
      name: input.name ?? '',
      type: input.type ?? 'password',
      username: input.username ?? '',
      password: input.password ?? '',
      url: input.url ?? '',
      comments: input.comments ?? '',
      note: input.note ?? '',
    });
    this._secrets.push(secret);
    return this._saveAndReturn(secret);
  }

  /**
   * @param {string} id - Secret id
   * @param {Object} updates - Fields to update (name, type, username, password, url, comments, note)
   * @returns {Promise<Object>} Updated secret (toJSON)
   */
  updateSecret(id, updates) {
    if (!this._key) throw new Error('Vault is locked');
    const secret = this._secrets.find((s) => s.id === id);
    if (!secret) throw new Error('Secret not found');
    if (updates.name !== undefined) secret.name = updates.name;
    if (updates.type !== undefined) secret.type = updates.type;
    if (updates.username !== undefined) secret.username = updates.username;
    if (updates.password !== undefined) secret.password = updates.password;
    if (updates.url !== undefined) secret.url = updates.url;
    if (updates.comments !== undefined) secret.comments = updates.comments;
    if (updates.note !== undefined) secret.note = updates.note;
    secret.updatedAt = Date.now();
    return this._saveAndReturn(secret);
  }

  /** @param {string} id - Secret id to remove */
  deleteSecret(id) {
    if (!this._key) throw new Error('Vault is locked');
    const index = this._secrets.findIndex((s) => s.id === id);
    if (index === -1) throw new Error('Secret not found');
    this._secrets.splice(index, 1);
    return this._persist();
  }

  async _saveAndReturn(secret) {
    await this._persist();
    return secret.toJSON();
  }

  /**
   * Re-encrypts the vault with a new master password. Verifies current password first.
   */
  async changeMasterPassword(currentPassword, newPassword) {
    if (!this._key) throw new Error('Vault is locked');
    const raw = await fs.readFile(this.vaultPath);
    const header = JSON.parse(raw.toString('utf8'));
    const salt = Buffer.from(header.salt, 'base64');
    const data = Buffer.from(header.data, 'base64');
    const currentKey = CryptoService.deriveKey(currentPassword, salt);
    try {
      CryptoService.decrypt(currentKey, data);
    } catch {
      currentKey.fill(0);
      throw new Error('Wrong current password');
    }
    currentKey.fill(0);
    const newSalt = CryptoService.generateSalt();
    const newKey = CryptoService.deriveKey(newPassword, newSalt);
    const oldKey = this._key;
    this._key = newKey;
    try {
      await this._persist(newSalt);
    } finally {
      oldKey.fill(0);
    }
    return true;
  }
}

module.exports = VaultService;
module.exports.Secret = Secret;
