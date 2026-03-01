/**
 * Cryptography for vault: key derivation (PBKDF2) and authenticated encryption (AES-256-GCM).
 * Stateless; all methods are static. Single Responsibility: secure key and encrypt/decrypt.
 * @module services/CryptoService
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_DIGEST = 'sha256';

/**
 * Handles key derivation and symmetric encryption/decryption for the vault.
 * Uses PBKDF2 for key derivation and AES-256-GCM for authenticated encryption.
 */
class CryptoService {
  /**
   * Derives a 256-bit key from the master password and salt.
   * @param {string} password - Master password
   * @param {Buffer} salt - Salt (must be SALT_LENGTH bytes)
   * @returns {Buffer} Derived key
   */
  static deriveKey(password, salt) {
    if (!Buffer.isBuffer(salt) || salt.length !== SALT_LENGTH) {
      throw new Error('Invalid salt');
    }
    return crypto.pbkdf2Sync(
      password,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
  }

  /**
   * Generates a cryptographically secure random salt.
   * @returns {Buffer}
   */
  static generateSalt() {
    return crypto.randomBytes(SALT_LENGTH);
  }

  /**
   * Encrypts plaintext with the given key. IV and auth tag are prepended/appended.
   * @param {Buffer} key - 32-byte key
   * @param {string} plaintext - UTF-8 string to encrypt
   * @returns {Buffer} IV (16) + ciphertext + authTag (16)
   */
  static encrypt(key, plaintext) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
      throw new Error('Invalid key');
    }
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, authTag]);
  }

  /**
   * Decrypts data produced by encrypt().
   * @param {Buffer} key - 32-byte key
   * @param {Buffer} data - IV + ciphertext + authTag
   * @returns {string} Decrypted UTF-8 string
   */
  static decrypt(key, data) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
      throw new Error('Invalid key');
    }
    if (!Buffer.isBuffer(data) || data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Invalid ciphertext');
    }
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
  }
}

module.exports = CryptoService;
