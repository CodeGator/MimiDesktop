/**
 * Read-only view helpers for vault secrets (mirrors main `getSecretData` in secretPayload.js).
 * Loaded before renderer.js.
 */
(function () {
  'use strict';
  window.MimiSecretView = window.MimiSecretView || {};
  window.MimiSecretView.secretData = function secretData(record) {
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
  };
})();
