/**
 * Vault secret JSON shape (v2): type-specific fields under `data`.
 * Pure helpers + migration — no I/O. Single place for payload rules (SRP).
 * @module services/secretPayload
 */

/** Decrypted vault blob version (bump when `secrets[]` item shape changes). */
const SERIALIZATION_VERSION = 2;

/** @param {string} t */
function defaultDataForType(t) {
  if (t === 'password') return { url: '', username: '', password: '', comments: '' };
  if (t === 'note') return { note: '' };
  if (t === 'apikey') return { key: '', comments: '', expiresOn: '' };
  return {};
}

/**
 * True if this object already uses v2 shape (type-specific fields under `data`).
 * @param {Object} obj
 */
function isV2SecretRecord(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    obj.data !== null &&
    typeof obj.data === 'object' &&
    !Array.isArray(obj.data)
  );
}

/**
 * Migrate a single v1 flat secret record to v2 { id, name, type, createdAt, updatedAt, data }.
 * @param {Object} obj
 * @returns {Object}
 */
function migrateSecretV1ToV2(obj) {
  if (isV2SecretRecord(obj)) {
    return {
      id: obj.id,
      name: obj.name ?? '',
      type: obj.type ?? 'password',
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
      data: { ...obj.data },
    };
  }
  const type = obj.type ?? 'password';
  const id = obj.id;
  const name = obj.name ?? '';
  const createdAt = obj.createdAt;
  const updatedAt = obj.updatedAt;
  if (type === 'note') {
    return {
      id,
      name,
      type: 'note',
      createdAt,
      updatedAt,
      data: { note: obj.note ?? '' },
    };
  }
  if (type === 'apikey') {
    return {
      id,
      name,
      type: 'apikey',
      createdAt,
      updatedAt,
      data: {
        key: obj.password ?? '',
        comments: obj.comments ?? '',
        expiresOn: typeof obj.expiresOn === 'string' ? obj.expiresOn : '',
      },
    };
  }
  return {
    id,
    name,
    type: 'password',
    createdAt,
    updatedAt,
    data: {
      url: obj.url ?? '',
      username: obj.username ?? '',
      password: obj.password ?? '',
      comments: obj.comments ?? '',
    },
  };
}

/**
 * Type-specific `data` object from a vault secret (v2) or {} if missing.
 * @param {Object} record - Plain object from getSecrets / IPC
 * @returns {Object}
 */
function getSecretData(record) {
  if (
    record &&
    typeof record === 'object' &&
    record.data &&
    typeof record.data === 'object' &&
    !Array.isArray(record.data)
  ) {
    return record.data;
  }
  return {};
}

module.exports = {
  SERIALIZATION_VERSION,
  defaultDataForType,
  isV2SecretRecord,
  migrateSecretV1ToV2,
  getSecretData,
};
