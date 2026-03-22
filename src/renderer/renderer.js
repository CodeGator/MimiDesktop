/**
 * Renderer process: UI for unlock, vault (notes/logins), options, dialogs.
 * Communicates with main only via window.app and window.vault (preload contextBridge).
 * No Node/Electron APIs; uses DOM, fetch-equivalent via IPC.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => root.querySelector(sel);

  // --- DOM references (unlock screen, vault screen, tabs, lists, dialogs) ---
  const unlockScreen = $('unlockScreen');
  const vaultScreen = $('vaultScreen');
  const vaultScreenError = $('vaultScreenError');
  const unlockForm = $('unlockForm');
  const unlockTitle = $('unlockTitle');
  const unlockHint = $('unlockHint');
  const unlockFooter = $('unlockFooter');
  const masterPasswordInput = $('masterPassword');
  const unlockError = $('unlockError');
  const unlockPasteWarning = $('unlockPasteWarning');
  const unlockPasswordStrength = $('unlockPasswordStrength');
  const btnUnlock = $('btnUnlock');
  const newPasswordStrengthEl = $('newPasswordStrength');
  const dataPathDisplay = $('dataPathDisplay');
  const btnBrowseDataLocation = $('btnBrowseDataLocation');
  const btnThemeLight = $('btnThemeLight');
  const btnThemeDark = $('btnThemeDark');
  const btnChangeMasterPassword = $('btnChangeMasterPassword');
  const btnDeleteAll = $('btnDeleteAll');
  const deleteAllDialog = $('deleteAllDialog');
  const deleteConfirmPhrase = $('deleteConfirmPhrase');
  const btnCancelDeleteAll = $('btnCancelDeleteAll');
  const btnConfirmDeleteAll = $('btnConfirmDeleteAll');
  const tabNotes = $('tabNotes');
  const tabLogins = $('tabLogins');
  const tabOptions = $('tabOptions');
  const panelNotes = $('panelNotes');
  const panelLogins = $('panelLogins');
  const panelOptions = $('panelOptions');
  const searchNotes = $('searchNotes');
  const searchLogins = $('searchLogins');
  const notesList = $('notesList');
  const loginsList = $('loginsList');
  const notesCount = $('notesCount');
  const loginsCount = $('loginsCount');
  const emptyNotes = $('emptyNotes');
  const emptyLogins = $('emptyLogins');
  const btnNewNote = $('btnNewNote');
  const btnNewLogin = $('btnNewLogin');
  const secretDialog = $('secretDialog');
  const secretForm = $('secretForm');
  const secretId = $('secretId');
  const secretName = $('secretName');
  const secretType = $('secretType');
  const secretUrl = $('secretUrl');
  const secretUsername = $('secretUsername');
  const secretPassword = $('secretPassword');
  const secretComments = $('secretComments');
  const secretNote = $('secretNote');
  const togglePassword = $('togglePassword');
  const groupUrl = $('groupUrl');
  const groupUsername = $('groupUsername');
  const groupPassword = $('groupPassword');
  const groupComments = $('groupComments');
  const groupNote = $('groupNote');
  const secretError = $('secretError');
  const btnCancelSecret = $('btnCancelSecret');
  const btnSaveSecret = $('btnSaveSecret');
  const confirmRestoreDialog = $('confirmRestoreDialog');
  const confirmDeleteDialog = $('confirmDeleteDialog');
  const confirmDeleteMessage = $('confirmDeleteMessage');
  const changePasswordDialog = $('changePasswordDialog');
  const changePasswordForm = $('changePasswordForm');
  const currentMasterPassword = $('currentMasterPassword');
  const newMasterPassword = $('newMasterPassword');
  const confirmMasterPassword = $('confirmMasterPassword');
  const changePasswordError = $('changePasswordError');
  const btnCancelChangePassword = $('btnCancelChangePassword');
  const toggleMasterPassword = $('toggleMasterPassword');
  const toggleCurrentMasterPassword = $('toggleCurrentMasterPassword');
  const toggleNewMasterPassword = $('toggleNewMasterPassword');
  const toggleConfirmMasterPassword = $('toggleConfirmMasterPassword');

  // --- State ---
  let secrets = [];
  let editingId = null;
  let activeTab = 'logins';
  let notesPage = 1;
  let notesPageSize = 10;
  let notesSort = 'name-asc';
  let loginsPage = 1;
  let loginsPageSize = 10;
  let loginsSort = 'name-asc';
  const checkedLogins = new Set();
  const checkedNotes = new Set();

  // --- Helpers: error display, selection buttons ---
  function showError(el, message) {
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function updateSelectionButtonsVisibility() {
    const hasItems = secrets.some((s) => s.type === 'password');
    const hasSelection = checkedLogins.size > 0;
    const showBtns = hasItems;
    const enableBtns = hasSelection;
    const btnPrint = $('btnPrintLogins');
    const btnExport = $('btnExportLogins');
    const btnDelete = $('btnDeleteSelectedLogins');
    [btnPrint, btnExport, btnDelete].forEach((btn) => {
      if (btn) {
        btn.hidden = !showBtns;
        btn.disabled = !enableBtns;
      }
    });
  }

  function updateNotesSelectionButtonsVisibility() {
    const hasItems = secrets.some((s) => s.type === 'note');
    const hasSelection = checkedNotes.size > 0;
    const showBtns = hasItems;
    const enableBtns = hasSelection;
    const btnPrint = $('btnPrintNotes');
    const btnExport = $('btnExportNotes');
    const btnDelete = $('btnDeleteSelectedNotes');
    [btnPrint, btnExport, btnDelete].forEach((btn) => {
      if (btn) {
        btn.hidden = !showBtns;
        btn.disabled = !enableBtns;
      }
    });
  }

  // --- Print: one system dialog for any destination (printer, Microsoft Print to PDF, etc.) ---
  async function printWithSystemDialog(docHtml) {
    showError(vaultScreenError, '');
    const overlay = $('printBusyOverlay');
    if (overlay) {
      overlay.hidden = false;
      overlay.setAttribute('aria-hidden', 'false');
      overlay.setAttribute('aria-busy', 'true');
    }
    try {
      const result = await window.app.printHtml(docHtml);
      if (result?.canceled) return;
      if (!result?.success) {
        showError(vaultScreenError, result?.error || 'Could not print.');
        return;
      }
      showError(vaultScreenError, '');
    } catch (err) {
      showError(vaultScreenError, err?.message || 'Could not print.');
    } finally {
      if (overlay) {
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('aria-busy', 'false');
      }
    }
  }

  function getPrintLoginsHtml(toPrint) {
    const field = (label, raw) => {
      const text =
        raw === undefined || raw === null || String(raw).trim() === '' ? '—' : String(raw);
      return `<div class="print-login-field">
        <span class="print-login-label">${escapeHtml(label)}</span>
        <span class="print-login-value">${escapeHtml(text)}</span>
      </div>`;
    };
    const cardHtml = (s) => {
      const title =
        s.name === undefined || s.name === null || String(s.name).trim() === ''
          ? '—'
          : String(s.name);
      return `<article class="print-login-card">
        <h2 class="print-login-card-title">${escapeHtml(title)}</h2>
        ${field('URL', s.url)}
        ${field('Username', s.username)}
        ${field('Password', s.password)}
        ${field('Comments', s.comments)}
      </article>`;
    };
    const cards = toPrint.map(cardHtml).join('');
    return `
      <div class="print-cover">
        <h1 class="print-cover-title">Mimi Desktop</h1>
        <p class="print-cover-date">${new Date().toLocaleString()}</p>
        <p class="print-confidential">This document contains confidential login information. Do not share it with anyone. Store or destroy it securely.</p>
      </div>
      <div class="print-login-list">${cards}</div>
    `;
  }

  const PRINT_DOC_BASE_STYLES = `
      @page { margin: 12mm; }
      html {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      *, *::before, *::after { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        max-width: 100%;
        height: auto;
        min-height: 0;
        background: #fff;
      }
      body {
        font-family: 'Segoe UI', system-ui, sans-serif;
        font-size: 11pt;
        line-height: 1.45;
        color: #111;
      }
    `;

  const PRINT_LOGINS_STYLES = `${PRINT_DOC_BASE_STYLES}
      .print-cover { text-align: center; padding: 2rem 1rem; page-break-after: always; }
      .print-cover-title { margin: 0 0 0.5rem; font-size: 1.5rem; }
      .print-cover-date { margin: 0 0 1rem; font-size: 0.9rem; color: #666; }
      .print-confidential { margin: 0; font-size: 0.875rem; color: #c00; font-weight: 600; max-width: 28em; margin-left: auto; margin-right: auto; }
      .print-login-list { margin: 0; padding: 0; }
      .print-login-card {
        border: 1px solid #888;
        padding: 0.65rem 0.85rem;
        margin: 0 0 1rem;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .print-login-card-title {
        margin: 0 0 0.55rem;
        padding-bottom: 0.35rem;
        border-bottom: 1px solid #ccc;
        font-size: 1.05rem;
        font-weight: 700;
        line-height: 1.3;
        word-break: break-word;
        overflow-wrap: break-word;
        max-width: 100%;
      }
      .print-login-field { margin: 0.5rem 0 0; }
      .print-login-field:first-of-type { margin-top: 0; }
      .print-login-label {
        display: block;
        font-size: 0.68rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #444;
        margin-bottom: 0.12rem;
      }
      .print-login-value {
        display: block;
        word-break: break-word;
        overflow-wrap: break-word;
        white-space: pre-wrap;
        max-width: 100%;
      }
    `;

  function buildPrintLoginsDocHtml(toPrint) {
    const contentHtml = getPrintLoginsHtml(toPrint);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mimi Desktop - Logins</title><style>${PRINT_LOGINS_STYLES}</style></head><body>${contentHtml}</body></html>`;
  }

  function printSelectedLogins() {
    const toPrint = secrets.filter((s) => s.type === 'password' && checkedLogins.has(s.id));
    if (toPrint.length === 0) return;
    void printWithSystemDialog(buildPrintLoginsDocHtml(toPrint));
  }

  function getPrintNotesHtml(toPrint) {
    const rowHtml = (s) =>
      `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.note ?? '—')}</td>
      </tr>`;
    const allRows = toPrint.map(rowHtml).join('');
    return `
      <div class="print-cover">
        <h1 class="print-cover-title">Mimi Desktop</h1>
        <p class="print-cover-date">${new Date().toLocaleString()}</p>
        <p class="print-confidential">This document contains confidential notes. Do not share it with anyone. Store or destroy it securely.</p>
      </div>
      <table class="print-notes-table">
        <thead><tr><th>Name</th><th>Note</th></tr></thead>
        <tbody>${allRows}</tbody>
      </table>
    `;
  }

  const PRINT_NOTES_STYLES = `${PRINT_DOC_BASE_STYLES}
      .print-cover { text-align: center; padding: 2rem 1rem; page-break-after: always; }
      .print-cover-title { margin: 0 0 0.5rem; font-size: 1.5rem; }
      .print-cover-date { margin: 0 0 1rem; font-size: 0.9rem; color: #666; }
      .print-confidential { margin: 0; font-size: 0.875rem; color: #c00; font-weight: 600; max-width: 28em; margin-left: auto; margin-right: auto; }
      .print-notes-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 0.9rem; }
      .print-notes-table thead { display: table-header-group; }
      .print-notes-table tbody { display: table-row-group; }
      .print-notes-table tr { break-inside: auto; page-break-inside: auto; }
      .print-notes-table th, .print-notes-table td {
        border: 1px solid #ccc;
        padding: 0.5rem 0.75rem;
        text-align: left;
        vertical-align: top;
        word-break: break-word;
        overflow-wrap: break-word;
        white-space: pre-wrap;
      }
      .print-notes-table th:nth-child(1), .print-notes-table td:nth-child(1) { width: 26%; }
      .print-notes-table th { background: #f0f0f0; font-weight: 600; }
    `;

  function buildPrintNotesDocHtml(toPrint) {
    const contentHtml = getPrintNotesHtml(toPrint);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mimi Desktop - Notes</title><style>${PRINT_NOTES_STYLES}</style></head><body>${contentHtml}</body></html>`;
  }

  function printSelectedNotes() {
    const toPrint = secrets.filter((s) => s.type === 'note' && checkedNotes.has(s.id));
    if (toPrint.length === 0) return;
    void printWithSystemDialog(buildPrintNotesDocHtml(toPrint));
  }

  function togglePasswordVisibility(inputEl, btnEl) {
    if (!inputEl || !btnEl) return;
    const isPassword = inputEl.type === 'password';
    inputEl.type = isPassword ? 'text' : 'password';
    const eye = btnEl.querySelector('.icon-eye');
    const eyeOff = btnEl.querySelector('.icon-eye-off');
    if (eye) eye.hidden = isPassword;
    if (eyeOff) eyeOff.hidden = !isPassword;
    btnEl.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
    btnEl.setAttribute('title', isPassword ? 'Hide password' : 'Show password');
  }

  // --- Unlock / screen flow ---
  let lastActivityAt = 0;
  let idleLockIntervalId = null;
  let idleLockMs = 0; // current timeout in ms (0 = disabled)

  function resetIdleLockTimer() {
    lastActivityAt = Date.now();
  }

  function startIdleLockWatcher(idleLockMsValue) {
    idleLockMs = idleLockMsValue;
    if (idleLockMs <= 0) return;
    resetIdleLockTimer();
    if (idleLockIntervalId) return;
    idleLockIntervalId = setInterval(() => {
      if (Date.now() - lastActivityAt >= idleLockMs) {
        stopIdleLockWatcher();
        lock();
      }
    }, 60 * 1000); // check every minute
    document.addEventListener('mousemove', resetIdleLockTimer);
    document.addEventListener('keydown', resetIdleLockTimer);
    document.addEventListener('mousedown', resetIdleLockTimer);
    document.addEventListener('click', resetIdleLockTimer);
  }

  function stopIdleLockWatcher() {
    if (idleLockIntervalId) {
      clearInterval(idleLockIntervalId);
      idleLockIntervalId = null;
    }
    document.removeEventListener('mousemove', resetIdleLockTimer);
    document.removeEventListener('keydown', resetIdleLockTimer);
    document.removeEventListener('mousedown', resetIdleLockTimer);
    document.removeEventListener('click', resetIdleLockTimer);
  }

  function setScreen(unlocked) {
    unlockScreen.hidden = unlocked;
    vaultScreen.hidden = !unlocked;
    if (unlocked) {
      masterPasswordInput.value = '';
      if (unlockPasteWarning) unlockPasteWarning.hidden = true;
      void loadSecrets().finally(() => {
        void setTab('logins');
      });
      window.vault.getIdleLockMinutes().then((minutes) => {
        if (minutes > 0) startIdleLockWatcher(minutes * 60 * 1000);
      });
    } else {
      stopIdleLockWatcher();
      showError(unlockError, '');
      if (unlockPasteWarning) unlockPasteWarning.hidden = true;
      if (unlockPasswordStrength) unlockPasswordStrength.hidden = true;
      window.vault.hasVault().then(setUnlockScreenCopy);
    }
  }

  const MIN_MASTER_PASSWORD_LENGTH = 8;

  /** Returns { level: 'weak'|'fair'|'strong', label: string, minLengthMet: boolean } */
  function getPasswordStrength(pwd) {
    const len = (pwd || '').length;
    const minLengthMet = len >= MIN_MASTER_PASSWORD_LENGTH;
    const hasLower = /[a-z]/.test(pwd || '');
    const hasUpper = /[A-Z]/.test(pwd || '');
    const hasNumber = /\d/.test(pwd || '');
    const hasSymbol = /[^A-Za-z0-9]/.test(pwd || '');
    const variety = [hasLower, hasUpper, hasNumber, hasSymbol].filter(Boolean).length;
    let level = 'weak';
    if (len >= 12 && variety >= 3) level = 'strong';
    else if (len >= 8 && variety >= 2) level = 'fair';
    else if (len >= 8) level = 'fair';
    const labels = {
      weak: minLengthMet ? 'Weak. Add more characters and mix letters, numbers, and symbols.' : `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters. Mix letters, numbers, and symbols.`,
      fair: 'Fair. Add more length or character variety for stronger security.',
      strong: 'Strong password.',
    };
    return { level, label: labels[level], minLengthMet };
  }

  function updateUnlockPasswordStrength() {
    if (!unlockPasswordStrength) return;
    const isCreate = unlockTitle.textContent === 'Create your master password';
    if (!isCreate || !masterPasswordInput.value) {
      unlockPasswordStrength.hidden = true;
      return;
    }
    const { level, label } = getPasswordStrength(masterPasswordInput.value);
    unlockPasswordStrength.textContent = `Password strength: ${label}`;
    unlockPasswordStrength.className = `password-strength ${level}`;
    unlockPasswordStrength.hidden = false;
  }

  function updateNewPasswordStrength() {
    if (!newPasswordStrengthEl) return;
    const pwd = newMasterPassword.value;
    if (!pwd) {
      newPasswordStrengthEl.textContent = '';
      newPasswordStrengthEl.className = 'password-strength';
      newPasswordStrengthEl.hidden = true;
      return;
    }
    const { level, label } = getPasswordStrength(pwd);
    newPasswordStrengthEl.textContent = `Password strength: ${label}`;
    newPasswordStrengthEl.className = `password-strength ${level}`;
    newPasswordStrengthEl.hidden = false;
  }

  function setUnlockScreenCopy(hasVault) {
    if (hasVault) {
      unlockTitle.textContent = 'Unlock';
      unlockHint.textContent = 'Enter your master password to open Mimi Desktop.';
      btnUnlock.textContent = 'Unlock';
      unlockFooter.textContent = 'Enter your password by typing. Avoid pasting from clipboard or using shared computers.';
      unlockFooter.hidden = false;
      if (unlockPasswordStrength) unlockPasswordStrength.hidden = true;
    } else {
      unlockTitle.textContent = 'Create your master password';
      unlockHint.textContent = 'Choose a strong password. You\'ll use it to unlock Mimi Desktop and protect your notes and logins.';
      btnUnlock.textContent = 'Create password';
      unlockFooter.textContent = 'Your data is encrypted on this device. If you forget this password, it cannot be recovered.';
      unlockFooter.hidden = false;
      updateUnlockPasswordStrength();
    }
  }

  async function loadSecrets() {
    try {
      secrets = await window.vault.getSecrets();
      renderNotesList();
      renderLoginsList();
    } catch (err) {
      showError(unlockError, err.message);
    }
  }

  // --- Filter and sort (used by notes and logins lists) ---
  function filterByQuery(list, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.username && s.username.toLowerCase().includes(q)) ||
        (s.url && s.url.toLowerCase().includes(q)) ||
        (s.comments && s.comments.toLowerCase().includes(q)) ||
        (s.note && s.note.toLowerCase().includes(q))
    );
  }

  function sortSecrets(list, sortKey) {
    const arr = [...list];
    const cmp = (a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    };
    const nameCmp = (a, b) => cmp((a.name || '').toLowerCase(), (b.name || '').toLowerCase());
    const numCmp = (a, b) => (a || 0) - (b || 0);
    switch (sortKey) {
      case 'name-asc':
        arr.sort((a, b) => nameCmp(a, b));
        break;
      case 'name-desc':
        arr.sort((a, b) => -nameCmp(a, b));
        break;
      case 'updated-desc':
        arr.sort((a, b) => -numCmp(a.updatedAt, b.updatedAt));
        break;
      case 'updated-asc':
        arr.sort((a, b) => numCmp(a.updatedAt, b.updatedAt));
        break;
      default:
        arr.sort((a, b) => nameCmp(a, b));
    }
    return arr;
  }

  const iconCopy = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const iconEdit = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const iconTrash = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  async function copyToClipboard(text, btnEl) {
    if (!text) return;
    const origTitle = btnEl.getAttribute('title');
    const origLabel = btnEl.getAttribute('aria-label');
    const restore = () => {
      btnEl.setAttribute('title', origTitle);
      btnEl.setAttribute('aria-label', origLabel);
    };
    try {
      await navigator.clipboard.writeText(text);
      btnEl.setAttribute('title', 'Copied!');
      btnEl.setAttribute('aria-label', 'Copied!');
      setTimeout(restore, 1500);
    } catch (err) {
      btnEl.setAttribute('title', 'Copy failed');
      btnEl.setAttribute('aria-label', 'Copy failed');
      setTimeout(restore, 2000);
    }
  }

  // --- List rendering: single item (notes/logins) with checkbox, copy, edit, delete ---
  function renderSecretItem(secret, listEl, opts = {}) {
    const li = document.createElement('li');
    li.className = 'secret-item';
    li.setAttribute('role', 'listitem');
    const subtitle = secret.type === 'password' && secret.username ? escapeHtml(secret.username) : escapeHtml(secret.type);
    const isLogin = secret.type === 'password';
    const showCheckbox = opts.showCheckbox && (isLogin || secret.type === 'note');
    const checked = showCheckbox && opts.isChecked?.(secret.id);
    const copyBtn = isLogin
      ? `<button type="button" class="btn btn-ghost btn-icon btn-item-action" data-action="copy" data-id="${escapeHtml(secret.id)}" title="Copy password" aria-label="Copy password">${iconCopy}</button>`
      : '';
    const checkbox = showCheckbox
      ? `<input type="checkbox" class="secret-checkbox" data-id="${escapeHtml(secret.id)}" ${checked ? 'checked' : ''} aria-label="Select ${escapeHtml(secret.name)}">`
      : '';
    li.innerHTML = `
      ${checkbox ? `<div class="secret-item-checkbox">${checkbox}</div>` : ''}
      <div class="meta">
        <div class="name">${escapeHtml(secret.name)}</div>
        <div class="type">${subtitle}</div>
      </div>
      <div class="actions">
        ${copyBtn}
        <button type="button" class="btn btn-ghost btn-icon btn-item-action" data-action="edit" data-id="${escapeHtml(secret.id)}" title="Edit" aria-label="Edit">${iconEdit}</button>
        <button type="button" class="btn btn-ghost btn-icon btn-item-action" data-action="delete" data-id="${escapeHtml(secret.id)}" title="Delete" aria-label="Delete">${iconTrash}</button>
      </div>
    `;
    if (showCheckbox) {
      const cb = li.querySelector('.secret-checkbox');
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        opts.onCheck?.(secret.id, cb.checked);
      });
      cb.addEventListener('click', (e) => e.stopPropagation());
    }
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-action], .secret-checkbox, .secret-item-checkbox')) return;
      openEdit(secret);
    });
    const editBtn = li.querySelector('[data-action="edit"]');
    const deleteBtn = li.querySelector('[data-action="delete"]');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEdit(secret);
    });
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDelete(secret);
    });
    if (isLogin) {
      const copyBtnEl = li.querySelector('[data-action="copy"]');
      copyBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(secret.password || '', copyBtnEl);
      });
    }
    listEl.appendChild(li);
  }

  function renderNotesList() {
    const notes = secrets.filter((s) => s.type === 'note');
    const query = searchNotes ? searchNotes.value : '';
    const filtered = sortSecrets(filterByQuery(notes, query), notesSort);
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / notesPageSize));
    notesPage = Math.min(notesPage, totalPages);
    const start = (notesPage - 1) * notesPageSize;
    const pageItems = filtered.slice(start, start + notesPageSize);

    if (notesCount) notesCount.textContent = `${total} note${total !== 1 ? 's' : ''}`;
    notesList.innerHTML = '';
    pageItems.forEach((secret) =>
      renderSecretItem(secret, notesList, {
        showCheckbox: true,
        isChecked: (id) => checkedNotes.has(id),
        onCheck: (id, checked) => {
          if (checked) checkedNotes.add(id);
          else checkedNotes.delete(id);
          updateNotesSelectionButtonsVisibility();
        },
      })
    );
    if (emptyNotes) emptyNotes.hidden = total > 0;

    updateNotesSelectionButtonsVisibility();

    const notesPagination = $('notesPagination');
    const notesPageInfo = $('notesPageInfo');
    const notesPrevPage = $('notesPrevPage');
    const notesNextPage = $('notesNextPage');
    if (notesPagination) {
      notesPagination.hidden = total <= notesPageSize;
      if (notesPageInfo) notesPageInfo.textContent = total > 0 ? `Page ${notesPage} of ${totalPages}` : '';
      if (notesPrevPage) notesPrevPage.disabled = notesPage <= 1;
      if (notesNextPage) notesNextPage.disabled = notesPage >= totalPages;
    }
  }

  function renderLoginsList() {
    const logins = secrets.filter((s) => s.type === 'password');
    const query = searchLogins ? searchLogins.value : '';
    const filtered = sortSecrets(filterByQuery(logins, query), loginsSort);
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / loginsPageSize));
    loginsPage = Math.min(loginsPage, totalPages);
    const start = (loginsPage - 1) * loginsPageSize;
    const pageItems = filtered.slice(start, start + loginsPageSize);

    if (loginsCount) loginsCount.textContent = `${total} login${total !== 1 ? 's' : ''}`;
    loginsList.innerHTML = '';
    pageItems.forEach((secret) =>
      renderSecretItem(secret, loginsList, {
        showCheckbox: true,
        isChecked: (id) => checkedLogins.has(id),
        onCheck: (id, checked) => {
          if (checked) checkedLogins.add(id);
          else checkedLogins.delete(id);
          updateSelectionButtonsVisibility();
        },
      })
    );
    if (emptyLogins) emptyLogins.hidden = total > 0;

    updateSelectionButtonsVisibility();

    const loginsPagination = $('loginsPagination');
    const loginsPageInfo = $('loginsPageInfo');
    const loginsPrevPage = $('loginsPrevPage');
    const loginsNextPage = $('loginsNextPage');
    if (loginsPagination) {
      loginsPagination.hidden = total <= loginsPageSize;
      if (loginsPageInfo) loginsPageInfo.textContent = total > 0 ? `Page ${loginsPage} of ${totalPages}` : '';
      if (loginsPrevPage) loginsPrevPage.disabled = loginsPage <= 1;
      if (loginsNextPage) loginsNextPage.disabled = loginsPage >= totalPages;
    }
  }

  // --- Tabs: notes / logins / options ---
  async function setTab(tab) {
    activeTab = tab;
    tabNotes.setAttribute('aria-selected', tab === 'notes');
    tabLogins.setAttribute('aria-selected', tab === 'logins');
    tabOptions.setAttribute('aria-selected', tab === 'options');
    panelNotes.hidden = tab !== 'notes';
    panelLogins.hidden = tab !== 'logins';
    panelOptions.hidden = tab !== 'options';
    if (tab === 'options') {
      await refreshDataPath();
      const theme = await window.vault.getTheme();
      applyTheme(theme);
      const minutes = await window.vault.getIdleLockMinutes();
      const idleSelect = $('idleLockMinutes');
      if (idleSelect) idleSelect.value = String(minutes);
      const backupStatus = $('backupStatus');
      backupStatus.hidden = true;
      backupStatus.textContent = '';
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Secret form: create / edit ---
  function toggleSecretFormByType() {
    const type = secretType.value;
    groupUrl.hidden = type !== 'password';
    groupUsername.hidden = type !== 'password';
    groupPassword.hidden = type !== 'password';
    groupComments.hidden = type !== 'password';
    groupNote.hidden = type !== 'note';
  }

  function openCreate(presetType) {
    editingId = null;
    secretId.value = '';
    secretForm.reset();
    secretId.value = '';
    secretType.value = presetType === 'note' ? 'note' : 'password';
    toggleSecretFormByType();
    showError(secretError, '');
    $$('#dialogTitle', secretDialog).textContent = presetType === 'note' ? 'New note' : presetType === 'password' ? 'New login' : 'New secret';
    secretDialog.showModal();
  }

  function openEdit(secret) {
    editingId = secret.id;
    secretId.value = secret.id;
    secretName.value = secret.name;
    secretType.value = secret.type;
    secretUrl.value = secret.url || '';
    secretUsername.value = secret.username || '';
    secretPassword.value = secret.password || '';
    secretComments.value = secret.comments || '';
    secretNote.value = secret.note || '';
    toggleSecretFormByType();
    showError(secretError, '');
    $$('#dialogTitle', secretDialog).textContent = 'Edit secret';
    secretDialog.showModal();
  }

  // --- Password generator (login popup) ---
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const NUMBERS = '0123456789';
  const SYMBOLS = '!@#$%^&*()_+-=[]{}|;:,.<>?';

  function generateRandomPassword(length, useUpper, useLower, useNumbers, useSymbols) {
    let pool = '';
    if (useUpper) pool += UPPER;
    if (useLower) pool += LOWER;
    if (useNumbers) pool += NUMBERS;
    if (useSymbols) pool += SYMBOLS;
    if (pool.length === 0) return '';
    const arr = new Uint32Array(length);
    crypto.getRandomValues(arr);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += pool[arr[i] % pool.length];
    }
    return result;
  }

  function updateGeneratorPreview() {
    const length = Math.max(4, Math.min(30, parseInt($('generatorLength').value, 10) || 16));
    const useUpper = $('generatorUppercase').checked;
    const useLower = $('generatorLowercase').checked;
    const useNumbers = $('generatorNumbers').checked;
    const useSymbols = $('generatorSymbols').checked;
    if (!useUpper && !useLower && !useNumbers && !useSymbols) {
      $('generatorPreview').value = '';
      return;
    }
    const password = generateRandomPassword(length, useUpper, useLower, useNumbers, useSymbols);
    $('generatorPreview').value = password;
  }

  function openPasswordGenerator() {
    const lenEl = $('generatorLength');
    const lenValEl = $('generatorLengthValue');
    if (lenValEl) lenValEl.textContent = lenEl?.value ?? 16;
    $('generatorUppercase').checked = true;
    $('generatorLowercase').checked = true;
    $('generatorNumbers').checked = true;
    $('generatorSymbols').checked = true;
    $('passwordGeneratorDialog').showModal();
    updateGeneratorPreview();
  }

  function applyGeneratedPassword() {
    const password = $('generatorPreview').value;
    if (!password) return;
    secretPassword.value = password;
    secretPassword.type = 'text';
    const eye = togglePassword.querySelector('.icon-eye');
    const eyeOff = togglePassword.querySelector('.icon-eye-off');
    if (eye) eye.hidden = true;
    if (eyeOff) eyeOff.hidden = false;
    togglePassword.setAttribute('aria-label', 'Hide password');
    togglePassword.setAttribute('title', 'Hide password');
    $('passwordGeneratorDialog').close();
  }

  function ensureOneGeneratorCheckbox() {
    const u = $('generatorUppercase');
    const l = $('generatorLowercase');
    const n = $('generatorNumbers');
    const s = $('generatorSymbols');
    if (u?.checked || l?.checked || n?.checked || s?.checked) return;
    u.checked = true;
  }

  // --- Delete: single secret or bulk (logins/notes) ---
  let pendingDeleteSecret = null;
  let pendingDeleteLoginIds = null;
  let pendingDeleteNoteIds = null;
  const confirmDeleteDialogTitle = $('confirmDeleteDialogTitle');

  function openConfirmDelete(secret) {
    pendingDeleteSecret = secret;
    pendingDeleteLoginIds = null;
    pendingDeleteNoteIds = null;
    if (confirmDeleteDialogTitle) confirmDeleteDialogTitle.textContent = 'Delete secret';
    confirmDeleteMessage.textContent = `Are you sure you want to delete "${secret.name}"? This cannot be undone.`;
    confirmDeleteDialog.showModal();
  }

  function openConfirmDeleteSelected() {
    const ids = Array.from(checkedLogins);
    if (ids.length === 0) return;
    pendingDeleteSecret = null;
    pendingDeleteLoginIds = ids;
    pendingDeleteNoteIds = null;
    const n = ids.length;
    if (confirmDeleteDialogTitle) confirmDeleteDialogTitle.textContent = 'Delete selected logins';
    confirmDeleteMessage.textContent = `Delete ${n} selected login${n !== 1 ? 's' : ''}? This cannot be undone.`;
    confirmDeleteDialog.showModal();
  }

  function openConfirmDeleteSelectedNotes() {
    const ids = Array.from(checkedNotes);
    if (ids.length === 0) return;
    pendingDeleteSecret = null;
    pendingDeleteLoginIds = null;
    pendingDeleteNoteIds = ids;
    const n = ids.length;
    if (confirmDeleteDialogTitle) confirmDeleteDialogTitle.textContent = 'Delete selected notes';
    confirmDeleteMessage.textContent = `Delete ${n} selected note${n !== 1 ? 's' : ''}? This cannot be undone.`;
    confirmDeleteDialog.showModal();
  }

  async function doConfirmDelete() {
    const loginIds = pendingDeleteLoginIds;
    const noteIds = pendingDeleteNoteIds;
    const secret = pendingDeleteSecret;
    pendingDeleteLoginIds = null;
    pendingDeleteNoteIds = null;
    pendingDeleteSecret = null;
    confirmDeleteDialog.close();
    if (loginIds && loginIds.length > 0) {
      try {
        for (const id of loginIds) {
          await window.vault.deleteSecret(id);
        }
        checkedLogins.clear();
        await loadSecrets();
        updateSelectionButtonsVisibility();
      } catch (err) {
        showError(unlockError, err.message);
      }
      return;
    }
    if (noteIds && noteIds.length > 0) {
      try {
        for (const id of noteIds) {
          await window.vault.deleteSecret(id);
        }
        checkedNotes.clear();
        await loadSecrets();
        updateNotesSelectionButtonsVisibility();
      } catch (err) {
        showError(unlockError, err.message);
      }
      return;
    }
    if (!secret) return;
    try {
      await window.vault.deleteSecret(secret.id);
      await loadSecrets();
    } catch (err) {
      showError(unlockError, err.message);
    }
  }

  function confirmDelete(secret) {
    openConfirmDelete(secret);
  }

  // --- Export / Import logins ---
  /** Merge imported login into existing: non-empty imported fields override; comments concatenated only when different (avoids duplication on re-import). */
  function mergeLogin(existing, imported) {
    const pick = (a, b) => (b != null && String(b).trim() !== '' ? String(b).trim() : (a || ''));
    const existingComments = (existing.comments || '').trim();
    const importedComments = (imported.comments || '').trim();
    let comments;
    if (existingComments && importedComments) {
      if (existingComments === importedComments || existingComments.includes(importedComments) || importedComments.includes(existingComments)) {
        comments = existingComments.length >= importedComments.length ? existingComments : importedComments;
      } else {
        comments = `${existingComments}\n${importedComments}`;
      }
    } else {
      comments = pick(existingComments, importedComments);
    }
    return {
      name: pick(existing.name, imported.name),
      url: pick(existing.url, imported.url),
      username: pick(existing.username, imported.username),
      password: pick(existing.password, imported.password),
      comments,
    };
  }

  function findExistingLogin(login) {
    const norm = (u) => (u || '').trim().toLowerCase();
    const nameMatch = (s) => (s.name || '').trim().toLowerCase() === norm(login.name);
    const urlMatch = (s) => norm(s.url) === norm(login.url);
    return secrets.find((s) => s.type === 'password' && nameMatch(s) && urlMatch(s));
  }

  let pendingExportData = null;

  function showExportWarningDialog(toExport, type) {
    pendingExportData = { toExport, type };
    $('exportWarningDialog').showModal();
  }

  function showExportPasswordDialog() {
    if (!pendingExportData) return;
    $('exportPasswordInput').value = '';
    $('exportPasswordDialog').showModal();
  }

  async function doExportWithPassword() {
    if (!pendingExportData) return;
    const password = $('exportPasswordInput')?.value?.trim() || null;
    const { toExport, type } = pendingExportData;
    pendingExportData = null;
    $('exportPasswordDialog').close();
    try {
      const result =
        type === 'logins'
          ? await window.vault.exportLogins(toExport, password)
          : await window.vault.exportNotes(toExport, password);
      if (result.success && result.path) {
        showError(unlockError, '');
      }
    } catch (err) {
      showError(unlockError, err.message || 'Export failed');
    }
  }

  async function exportSelectedLogins() {
    const toExport = secrets.filter((s) => s.type === 'password' && checkedLogins.has(s.id));
    if (toExport.length === 0) return;
    showExportWarningDialog(toExport, 'logins');
  }

  let pendingImportNew = [];
  let pendingImportConflicts = [];

  let pendingImportPassword = null;

  function showImportPasswordDialog(filePath, type) {
    pendingImportPassword = { filePath, type };
    $('importPasswordInput').value = '';
    showError($('importPasswordError'), '');
    $('importPasswordError').hidden = true;
    $('importPasswordDialogTitle').textContent = 'Password required';
    $('importPasswordDialogMessage').textContent =
      type === 'logins'
        ? 'This logins export file is password protected. Enter the password to import.'
        : 'This notes export file is password protected. Enter the password to import.';
    $('importPasswordDialog').showModal();
  }

  async function doImportWithPassword() {
    if (!pendingImportPassword) return;
    const password = $('importPasswordInput')?.value;
    if (!password || !password.trim()) {
      showError($('importPasswordError'), 'Enter the export password.');
      $('importPasswordError').hidden = false;
      return;
    }
    const { filePath, type } = pendingImportPassword;
    pendingImportPassword = null;
    $('importPasswordDialog').close();
    try {
      const result =
        type === 'logins'
          ? await window.vault.importLoginsWithPassword(filePath, password)
          : await window.vault.importNotesWithPassword(filePath, password);
      if (!result.success) {
        pendingImportPassword = { filePath, type };
        $('importPasswordInput').value = '';
        showError($('importPasswordError'), result.error || 'Wrong password');
        $('importPasswordError').hidden = false;
        $('importPasswordDialog').showModal();
        return;
      }
      if (type === 'logins') {
        applyImportResult(result.logins, [], 'logins');
      } else {
        applyNotesImportResult(result.notes, [], 'notes');
      }
    } catch (err) {
      showError(unlockError, err.message || 'Import failed');
    }
  }

  function applyImportResult(logins, conflicts, source) {
    if (source !== 'logins') return;
    const newLogins = [];
    const conflictsList = [];
    for (const login of logins) {
      const existing = findExistingLogin(login);
      if (existing) conflictsList.push({ imported: login, existing });
      else newLogins.push(login);
    }
    pendingImportNew = newLogins;
    pendingImportConflicts = conflictsList;
    if (newLogins.length > 0) applyImport(newLogins, []).catch((e) => showError(unlockError, e.message));
    if (conflictsList.length > 0) openImportConflictDialog();
  }

  function applyNotesImportResult(notes, conflicts, source) {
    if (source !== 'notes') return;
    const newNotes = [];
    const conflictsList = [];
    for (const note of notes) {
      const existing = findExistingNote(note);
      if (existing) conflictsList.push({ imported: note, existing });
      else newNotes.push(note);
    }
    pendingImportNotesNew = newNotes;
    pendingImportNotesConflicts = conflictsList;
    if (newNotes.length > 0) applyImportNotes(newNotes, []).catch((e) => showError(unlockError, e.message));
    if (conflictsList.length > 0) openImportNoteConflictDialog();
  }

  async function importLogins() {
    try {
      const result = await window.vault.importLogins();
      if (result.needsPassword && result.filePath) {
        showImportPasswordDialog(result.filePath, 'logins');
        return;
      }
      if (!result.success) {
        if (result.errorCode === 'WRONG_EXPORT_TYPE') {
          showImportTypeMismatchWarning(result.error);
        } else if (result.error) {
          showError(unlockError, result.error);
        }
        return;
      }
      showError(unlockError, '');
      const imported = result.logins || [];
      const newLogins = [];
      const conflicts = [];
      for (const login of imported) {
        const existing = findExistingLogin(login);
        if (existing) {
          conflicts.push({ imported: login, existing });
        } else {
          newLogins.push(login);
        }
      }
      pendingImportNew = newLogins;
      pendingImportConflicts = conflicts;
      if (newLogins.length > 0) {
        await applyImport(newLogins, []);
      }
      if (conflicts.length > 0) {
        openImportConflictDialog();
      }
    } catch (err) {
      showError(unlockError, err.message || 'Import failed');
    }
  }

  function openImportConflictDialog() {
    const listEl = $('importConflictList');
    if (!listEl) return;
    listEl.innerHTML = '';
    pendingImportConflicts.forEach(({ imported, existing }) => {
      const li = document.createElement('li');
      li.className = 'import-conflict-item';
      const id = `import-overwrite-${existing.id}`;
      const inputId = `import-overwrite-${existing.id}`;
      li.innerHTML = `
        <label class="import-conflict-label">
          <input type="checkbox" id="${inputId}" data-existing-id="${escapeHtml(existing.id)}">
          <span class="import-conflict-name">${escapeHtml(imported.name)}</span>
          ${imported.url ? `<span class="import-conflict-meta">${escapeHtml(imported.url)}</span>` : ''}
          ${imported.username ? `<span class="import-conflict-meta">${escapeHtml(imported.username)}</span>` : ''}
        </label>
      `;
      listEl.appendChild(li);
    });
    $('importConflictDialog').showModal();
  }

  async function applyImport(newLogins, merges) {
    try {
      for (const login of newLogins) {
        await window.vault.createSecret({
          name: login.name,
          type: 'password',
          url: login.url || '',
          username: login.username || '',
          password: login.password || '',
          comments: login.comments || '',
        });
      }
      for (const { imported, existing } of merges) {
        const merged = mergeLogin(existing, imported);
        await window.vault.updateSecret(existing.id, merged);
      }
      await loadSecrets();
      setTab('logins');
      showError(unlockError, '');
    } catch (err) {
      showError(unlockError, err.message || 'Import failed');
    }
  }

  async function doApplyImportConflict() {
    const listEl = $('importConflictList');
    const toMerge = [];
    listEl?.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
      const existingId = cb.getAttribute('data-existing-id');
      const conflict = pendingImportConflicts.find((c) => c.existing.id === existingId);
      if (conflict) toMerge.push(conflict);
    });
    await applyImport([], toMerge);
    pendingImportNew = [];
    pendingImportConflicts = [];
    $('importConflictDialog')?.close();
  }

  // --- Export / Import notes ---
  /** Merge imported note into existing: non-empty name from imported; note content concatenated only when different (avoids duplication on re-import). */
  function mergeNote(existing, imported) {
    const pick = (a, b) => (b != null && String(b).trim() !== '' ? String(b).trim() : (a || ''));
    const existingNote = (existing.note || '').trim();
    const importedNote = (imported.note || '').trim();
    let note;
    if (existingNote && importedNote) {
      if (existingNote === importedNote || existingNote.includes(importedNote) || importedNote.includes(existingNote)) {
        note = existingNote.length >= importedNote.length ? existingNote : importedNote;
      } else {
        note = `${existingNote}\n\n${importedNote}`;
      }
    } else {
      note = pick(existingNote, importedNote);
    }
    return {
      name: pick(existing.name, imported.name),
      note,
    };
  }

  function findExistingNote(note) {
    const norm = (n) => (n || '').trim().toLowerCase();
    const name = norm(note.name);
    return secrets.find((s) => s.type === 'note' && norm(s.name) === name);
  }

  async function exportSelectedNotes() {
    const toExport = secrets.filter((s) => s.type === 'note' && checkedNotes.has(s.id));
    if (toExport.length === 0) return;
    showExportWarningDialog(toExport, 'notes');
  }

  let pendingImportNotesNew = [];
  let pendingImportNotesConflicts = [];

  function showImportTypeMismatchWarning(message) {
    const msgEl = $('importTypeMismatchMessage');
    if (msgEl) msgEl.textContent = message || 'This file contains a different type of data. Use the correct import option.';
    $('importTypeMismatchDialog').showModal();
  }

  async function importNotes() {
    try {
      const result = await window.vault.importNotes();
      if (result.needsPassword && result.filePath) {
        showImportPasswordDialog(result.filePath, 'notes');
        return;
      }
      if (!result.success) {
        if (result.errorCode === 'WRONG_EXPORT_TYPE') {
          showImportTypeMismatchWarning(result.error);
        } else if (result.error) {
          showError(unlockError, result.error);
        }
        return;
      }
      showError(unlockError, '');
      const imported = result.notes || [];
      const newNotes = [];
      const conflicts = [];
      for (const note of imported) {
        const existing = findExistingNote(note);
        if (existing) {
          conflicts.push({ imported: note, existing });
        } else {
          newNotes.push(note);
        }
      }
      pendingImportNotesNew = newNotes;
      pendingImportNotesConflicts = conflicts;
      if (newNotes.length > 0) {
        await applyImportNotes(newNotes, []);
      }
      if (conflicts.length > 0) {
        openImportNoteConflictDialog();
      }
    } catch (err) {
      showError(unlockError, err.message || 'Import failed');
    }
  }

  function openImportNoteConflictDialog() {
    const listEl = $('importNoteConflictList');
    if (!listEl) return;
    listEl.innerHTML = '';
    pendingImportNotesConflicts.forEach(({ imported, existing }) => {
      const li = document.createElement('li');
      li.className = 'import-conflict-item';
      const inputId = `import-note-merge-${existing.id}`;
      li.innerHTML = `
        <label class="import-conflict-label">
          <input type="checkbox" id="${inputId}" data-existing-id="${escapeHtml(existing.id)}">
          <span class="import-conflict-name">${escapeHtml(imported.name)}</span>
        </label>
      `;
      listEl.appendChild(li);
    });
    $('importNoteConflictDialog').showModal();
  }

  async function applyImportNotes(newNotes, merges) {
    try {
      for (const note of newNotes) {
        await window.vault.createSecret({
          name: note.name,
          type: 'note',
          note: note.note || '',
        });
      }
      for (const { imported, existing } of merges) {
        const merged = mergeNote(existing, imported);
        await window.vault.updateSecret(existing.id, merged);
      }
      await loadSecrets();
      setTab('notes');
      showError(unlockError, '');
    } catch (err) {
      showError(unlockError, err.message || 'Import failed');
    }
  }

  async function doApplyImportNoteConflict() {
    const listEl = $('importNoteConflictList');
    const toMerge = [];
    listEl?.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
      const existingId = cb.getAttribute('data-existing-id');
      const conflict = pendingImportNotesConflicts.find((c) => c.existing.id === existingId);
      if (conflict) toMerge.push(conflict);
    });
    await applyImportNotes([], toMerge);
    pendingImportNotesNew = [];
    pendingImportNotesConflicts = [];
    $('importNoteConflictDialog')?.close();
  }

  // --- LastPass CSV import (Convert section) ---
  /** Parse CSV line respecting double-quoted fields (commas inside quotes stay). */
  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',') {
        if (inQuotes) {
          cur += c;
        } else {
          out.push(cur.trim());
          cur = '';
        }
      } else {
        cur += c;
      }
    }
    out.push(cur.trim());
    return out;
  }

  /**
   * Parse LastPass CSV into { logins }. Only logins are imported; secure notes (url "http://sn") are skipped.
   * LastPass formats: url,username,password,extra,name,grouping,fav [legacy]
   * or url,username,password,totp,extra,name,grouping,fav [new].
   */
  function parseLastPassCsv(content) {
    const logins = [];
    const raw = (content || '').replace(/^\uFEFF/, ''); // strip BOM
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { logins };

    const header = parseCsvLine(lines[0]).map((h) => (h || '').toLowerCase());
    const idxOf = (name) => header.findIndex((h) => h === name);
    const totpPos = idxOf('totp');
    const extraCol = idxOf('extra') >= 0 ? idxOf('extra') : (idxOf('notes') >= 0 ? idxOf('notes') : (totpPos === 3 ? 4 : 3));
    const nameCol = idxOf('name') >= 0 ? idxOf('name') : (idxOf('title') >= 0 ? idxOf('title') : (totpPos === 3 ? 5 : 4));

    const get = (row, idx) => (idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '');

    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      if (row.length < 3) continue;
      const url = get(row, 0);
      const isSecureNote = !url || url.toLowerCase() === 'http://sn';
      if (isSecureNote) continue; // skip secure notes; only import logins
      const username = get(row, 1);
      const password = get(row, 2);
      const extra = get(row, extraCol);
      const csvName = get(row, nameCol);
      const name = csvName || url || 'Imported';
      logins.push({ name, url, username, password, comments: extra });
    }
    return { logins };
  }

  let pendingLastPass = null; // { newLogins, loginConflicts }

  function openLastPassConflictDialog() {
    const listEl = $('lastPassConflictList');
    const msgEl = $('lastPassConflictMessage');
    if (!listEl) return;
    listEl.innerHTML = '';
    const { loginConflicts } = pendingLastPass;
    msgEl.textContent = `${loginConflicts.length} conflicting entr${loginConflicts.length === 1 ? 'y' : 'ies'} found. Choose to ignore (keep existing) or overwrite with imported data for each.`;
    loginConflicts.forEach(({ imported, existing }) => {
      const li = document.createElement('li');
      li.className = 'import-conflict-item';
      const idPrefix = `lastpass-login-${existing.id}`;
      li.innerHTML = `
        <div class="lastpass-conflict-row">
          <span class="import-conflict-name">${escapeHtml(imported.name)}</span>
          ${imported.url ? `<span class="import-conflict-meta">${escapeHtml(imported.url)}</span>` : ''}
          <span class="lastpass-conflict-type">Login</span>
          <label><input type="radio" name="${idPrefix}" value="ignore" checked> Ignore</label>
          <label><input type="radio" name="${idPrefix}" value="overwrite"> Overwrite</label>
        </div>
      `;
      li.dataset.type = 'login';
      li.dataset.existingId = existing.id;
      listEl.appendChild(li);
    });
    $('lastPassConflictDialog').showModal();
  }

  function getLastPassConflictChoices() {
    const listEl = $('lastPassConflictList');
    const choices = []; // { type, existingId, action: 'ignore'|'overwrite' }
    listEl?.querySelectorAll('.import-conflict-item').forEach((li) => {
      const type = li.dataset.type;
      const existingId = li.dataset.existingId;
      const checked = li.querySelector('input[type="radio"]:checked');
      choices.push({ type, existingId, action: checked?.value === 'overwrite' ? 'overwrite' : 'ignore' });
    });
    return choices;
  }

  function setAllLastPassConflictChoices(action) {
    $('lastPassConflictList')?.querySelectorAll('input[type="radio"]').forEach((radio) => {
      radio.checked = radio.value === action;
    });
  }

  async function applyLastPassImport() {
    if (!pendingLastPass) return;
    const { newLogins, loginConflicts } = pendingLastPass;
    const choices = getLastPassConflictChoices();
    try {
      for (const login of newLogins) {
        await window.vault.createSecret({
          name: login.name,
          type: 'password',
          url: login.url || '',
          username: login.username || '',
          password: login.password || '',
          comments: login.comments || '',
        });
      }
      for (const { imported, existing } of loginConflicts) {
        const choice = choices.find((c) => c.type === 'login' && c.existingId === existing.id);
        if (choice?.action === 'overwrite') {
          await window.vault.updateSecret(existing.id, {
            name: imported.name,
            url: imported.url || '',
            username: imported.username || '',
            password: imported.password || '',
            comments: imported.comments || '',
          });
        }
      }
      await loadSecrets();
      showError(unlockError, '');
      if (newLogins.length > 0 || choices.some((c) => c.action === 'overwrite')) {
        setTab('logins');
      }
    } catch (err) {
      showError(unlockError, err.message || 'Import failed');
    } finally {
      pendingLastPass = null;
      $('lastPassConflictDialog')?.close();
    }
  }

  async function importFromLastPassCsv() {
    showError(unlockError, '');
    try {
      const result = await window.vault.selectAndReadLastPassCsv();
      if (!result.success) {
        if (result.error && result.error !== 'No file selected') {
          showError(unlockError, result.error);
        }
        return;
      }
      const { logins } = parseLastPassCsv(result.content);
      if (logins.length === 0) {
        showError(unlockError, 'No logins found in the CSV file. (Secure notes are not imported.)');
        return;
      }
      const newLogins = [];
      const loginConflicts = [];
      for (const login of logins) {
        const existing = findExistingLogin(login);
        if (existing) loginConflicts.push({ imported: login, existing });
        else newLogins.push(login);
      }
      const hasConflicts = loginConflicts.length > 0;
      pendingLastPass = { newLogins, loginConflicts };
      if (hasConflicts) {
        openLastPassConflictDialog();
      } else {
        await applyLastPassImport();
      }
    } catch (err) {
      showError(unlockError, err.message || 'Import failed');
    }
  }

  async function saveSecret(e) {
    e.preventDefault();
    showError(secretError, '');
    const payload = {
      name: secretName.value.trim(),
      type: secretType.value,
      url: secretUrl?.value?.trim() ?? '',
      username: secretUsername.value.trim(),
      password: secretPassword.value,
      comments: secretComments?.value?.trim() ?? '',
      note: secretNote.value.trim(),
    };
    try {
      if (editingId) {
        await window.vault.updateSecret(editingId, payload);
      } else {
        await window.vault.createSecret(payload);
      }
      secretDialog.close();
      await loadSecrets();
    } catch (err) {
      showError(secretError, err.message || 'Failed to save');
    }
  }

  /** Unlock or create vault with master password; on success show vault and close dialog. */
  async function unlock(e) {
    e.preventDefault();
    const password = masterPasswordInput.value;
    showError(unlockError, '');
    const isCreate = btnUnlock.textContent === 'Create password';
    if (isCreate && password.length < MIN_MASTER_PASSWORD_LENGTH) {
      showError(unlockError, `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters. Mix letters, numbers, and symbols for a strong password.`);
      return;
    }
    btnUnlock.disabled = true;
    try {
      await window.vault.unlock(password);
      setScreen(true);
    } catch (err) {
      const msg = err?.message || '';
      const showLockout = msg.includes('Locked out') || msg.includes('Try again in');
      showError(unlockError, showLockout ? msg : 'Invalid Password');
    } finally {
      btnUnlock.disabled = false;
    }
  }

  /** Lock vault and return to main screen (intro). */
  async function lock() {
    await window.vault.lock();
    setScreen(false);
    secrets = [];
  }

  function openChangePassword() {
    changePasswordForm.reset();
    showError(changePasswordError, '');
    changePasswordDialog.showModal();
  }

  async function submitChangePassword(e) {
    e.preventDefault();
    showError(changePasswordError, '');
    const current = currentMasterPassword.value;
    const newP = newMasterPassword.value;
    const confirm = confirmMasterPassword.value;
    if (!current.trim()) {
      showError(changePasswordError, 'Enter your current password.');
      return;
    }
    if (!newP.trim()) {
      showError(changePasswordError, 'Enter a new password.');
      return;
    }
    if (newP.length < MIN_MASTER_PASSWORD_LENGTH) {
      showError(changePasswordError, `New password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters. Mix letters, numbers, and symbols.`);
      return;
    }
    if (newP !== confirm) {
      showError(changePasswordError, 'New password and confirmation do not match.');
      return;
    }
    try {
      await window.vault.changeMasterPassword(current, newP);
      changePasswordDialog.close();
    } catch (err) {
      showError(changePasswordError, err.message || 'Failed to change password.');
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    btnThemeLight?.classList.toggle('active', theme === 'light');
    btnThemeDark?.classList.toggle('active', theme === 'dark');
  }

  function showAboutDialog(data) {
    const aboutDialog = $('aboutDialog');
    const aboutIcon = $('aboutIcon');
    const aboutTitle = $('aboutDialogTitle');
    const aboutVersion = $('aboutVersion');
    const aboutCopyright = $('aboutCopyright');
    aboutTitle.textContent = data.name || 'Mimi Desktop';
    aboutVersion.textContent = `Version ${data.version || '1.0.1'}`;
    aboutCopyright.textContent = `Copyright © 2002 - ${new Date().getFullYear()} by CodeGator. All rights reserved`;
    if (data.iconDataUrl) {
      aboutIcon.src = data.iconDataUrl;
      aboutIcon.hidden = false;
    } else {
      aboutIcon.hidden = true;
    }
    aboutDialog.showModal();
  }

  // --- Init: register app callbacks, theme, screen state ---
  async function init() {
    window.app?.onShowAbout?.(showAboutDialog);
    const theme = await window.vault.getTheme();
    applyTheme(theme);
    const unlocked = await window.vault.isUnlocked();
    const hasVault = await window.vault.hasVault();
    setUnlockScreenCopy(hasVault);
    setScreen(unlocked);
  }

  // --- Event bindings ---
  masterPasswordInput.addEventListener('input', updateUnlockPasswordStrength);
  let unlockPasteWarningTimeout = null;
  masterPasswordInput.addEventListener('paste', () => {
    if (unlockPasteWarning) {
      unlockPasteWarning.hidden = false;
      clearTimeout(unlockPasteWarningTimeout);
      unlockPasteWarningTimeout = setTimeout(() => {
        unlockPasteWarning.hidden = true;
      }, 5000);
    }
  });
  unlockForm.addEventListener('submit', unlock);
  window.app?.onLock?.(lock);
  window.app?.onFocusUnlock?.(() => {
    if (unlockScreen && !unlockScreen.hidden) masterPasswordInput?.focus();
  });
  async function refreshDataPath() {
    const dir = await window.vault.getDataDirectory();
    dataPathDisplay.textContent = dir || '—';
  }
  btnThemeLight.addEventListener('click', async () => {
    await window.vault.setTheme('light');
    applyTheme('light');
  });
  btnThemeDark.addEventListener('click', async () => {
    await window.vault.setTheme('dark');
    applyTheme('dark');
  });
  const idleLockSelect = $('idleLockMinutes');
  if (idleLockSelect) {
    idleLockSelect.addEventListener('change', async () => {
      const minutes = parseInt(idleLockSelect.value, 10);
      await window.vault.setIdleLockMinutes(minutes);
    });
  }
  btnBrowseDataLocation.addEventListener('click', async () => {
    const selected = await window.vault.selectDataDirectory();
    if (selected) {
      await window.vault.setDataDirectory(selected);
      await refreshDataPath();
      secrets = [];
      setScreen(false);
    }
  });
  $('btnBackupData').addEventListener('click', async () => {
    const status = $('backupStatus');
    status.hidden = true;
    status.textContent = '';
    try {
      const result = await window.vault.backupData();
      if (result.success) {
        status.textContent = `Backup saved to ${result.path}`;
        status.classList.remove('error');
        status.hidden = false;
      }
    } catch (err) {
      status.textContent = err.message || 'Backup failed';
      status.classList.add('error');
      status.hidden = false;
    }
  });
  $('btnRestoreBackup').addEventListener('click', () => {
    confirmRestoreDialog.showModal();
  });
  async function doConfirmRestore() {
    confirmRestoreDialog.close();
    const status = $('backupStatus');
    status.hidden = true;
    status.textContent = '';
    try {
      const result = await window.vault.restoreFromBackup();
      if (result.success) {
        status.textContent = 'Restore complete. Please unlock with your master password.';
        status.classList.remove('error');
        status.hidden = false;
        secrets = [];
        setScreen(false);
      } else if (result.error) {
        status.textContent = result.error;
        status.classList.add('error');
        status.hidden = false;
      }
    } catch (err) {
      status.textContent = err.message || 'Restore failed';
      status.classList.add('error');
      status.hidden = false;
    }
  }
  $('btnCancelConfirmRestore').addEventListener('click', () => confirmRestoreDialog.close());
  $('btnConfirmRestore').addEventListener('click', doConfirmRestore);
  $('btnImportLastPassCsv').addEventListener('click', () => importFromLastPassCsv());
  $('btnLastPassIgnoreAll').addEventListener('click', () => setAllLastPassConflictChoices('ignore'));
  $('btnLastPassOverwriteAll').addEventListener('click', () => setAllLastPassConflictChoices('overwrite'));
  $('btnCancelLastPassConflict').addEventListener('click', () => {
    pendingLastPass = null;
    $('lastPassConflictDialog').close();
  });
  $('btnApplyLastPassConflict').addEventListener('click', () => applyLastPassImport());
  btnChangeMasterPassword.addEventListener('click', () => openChangePassword());
  const CONFIRM_PHRASE = 'delete everything';
  function openDeleteAllDialog() {
    deleteConfirmPhrase.value = '';
    btnConfirmDeleteAll.disabled = true;
    deleteAllDialog.showModal();
  }
  function closeDeleteAllDialog() {
    deleteAllDialog.close();
  }
  btnDeleteAll.addEventListener('click', openDeleteAllDialog);
  deleteConfirmPhrase.addEventListener('input', () => {
    btnConfirmDeleteAll.disabled = deleteConfirmPhrase.value.trim() !== CONFIRM_PHRASE;
  });
  btnCancelDeleteAll.addEventListener('click', closeDeleteAllDialog);
  btnConfirmDeleteAll.addEventListener('click', () => {
    if (deleteConfirmPhrase.value.trim() !== CONFIRM_PHRASE) return;
    closeDeleteAllDialog();
    window.vault.deleteAll().then(() => {
      secrets = [];
      setScreen(false);
    });
  });
  newMasterPassword.addEventListener('input', updateNewPasswordStrength);
  changePasswordForm.addEventListener('submit', submitChangePassword);
  btnCancelChangePassword.addEventListener('click', () => changePasswordDialog.close());
  tabNotes.addEventListener('click', () => setTab('notes'));
  tabLogins.addEventListener('click', () => setTab('logins'));
  tabOptions.addEventListener('click', () => setTab('options'));
  btnNewNote.addEventListener('click', () => openCreate('note'));
  btnNewLogin.addEventListener('click', () => openCreate('password'));
  searchNotes.addEventListener('input', () => {
    notesPage = 1;
    renderNotesList();
  });
  searchLogins.addEventListener('input', () => {
    loginsPage = 1;
    renderLoginsList();
  });
  $('notesSort').addEventListener('change', (e) => {
    notesSort = e.target.value;
    notesPage = 1;
    renderNotesList();
  });
  $('loginsSort').addEventListener('change', (e) => {
    loginsSort = e.target.value;
    loginsPage = 1;
    renderLoginsList();
  });
  $('notesPageSize').addEventListener('change', (e) => {
    notesPageSize = parseInt(e.target.value, 10);
    notesPage = 1;
    renderNotesList();
  });
  $('loginsPageSize').addEventListener('change', (e) => {
    loginsPageSize = parseInt(e.target.value, 10);
    loginsPage = 1;
    renderLoginsList();
  });
  $('btnLoginsSelectAll').addEventListener('click', () => {
    const logins = secrets.filter((s) => s.type === 'password');
    const query = searchLogins ? searchLogins.value : '';
    const filtered = sortSecrets(filterByQuery(logins, query), loginsSort);
    filtered.forEach((s) => checkedLogins.add(s.id));
    renderLoginsList();
  });
  $('btnLoginsUnselectAll').addEventListener('click', () => {
    checkedLogins.clear();
    renderLoginsList();
  });
  $('btnCancelExportWarning').addEventListener('click', () => {
    pendingExportData = null;
    $('exportWarningDialog').close();
  });
  $('btnConfirmExportWarning').addEventListener('click', () => {
    $('exportWarningDialog').close();
    showExportPasswordDialog();
  });
  $('btnCancelExportPassword').addEventListener('click', () => {
    pendingExportData = null;
    $('exportPasswordDialog').close();
  });
  $('btnConfirmExportPassword').addEventListener('click', () => doExportWithPassword());
  $('toggleExportPassword')?.addEventListener('click', () => {
    const input = $('exportPasswordInput');
    const btn = $('toggleExportPassword');
    if (input && btn) togglePasswordVisibility(input, btn);
  });
  $('btnExportLogins').addEventListener('click', exportSelectedLogins);
  $('btnImportLogins').addEventListener('click', importLogins);
  $('btnPrintLogins').addEventListener('click', printSelectedLogins);
  $('btnDeleteSelectedLogins').addEventListener('click', openConfirmDeleteSelected);
  $('btnCancelImportConflict').addEventListener('click', () => {
    pendingImportNew = [];
    pendingImportConflicts = [];
    $('importConflictDialog').close();
  });
  $('btnApplyImportConflict').addEventListener('click', doApplyImportConflict);
  $('btnCancelImportPassword').addEventListener('click', () => {
    pendingImportPassword = null;
    $('importPasswordDialog').close();
  });
  $('btnConfirmImportPassword').addEventListener('click', () => doImportWithPassword());
  $('toggleImportPassword')?.addEventListener('click', () => {
    const input = $('importPasswordInput');
    const btn = $('toggleImportPassword');
    if (input && btn) togglePasswordVisibility(input, btn);
  });
  $('btnCloseImportTypeMismatch').addEventListener('click', () => $('importTypeMismatchDialog').close());
  $('btnExportNotes').addEventListener('click', exportSelectedNotes);
  $('btnImportNotes').addEventListener('click', importNotes);
  $('btnCancelImportNoteConflict').addEventListener('click', () => {
    pendingImportNotesNew = [];
    pendingImportNotesConflicts = [];
    $('importNoteConflictDialog').close();
  });
  $('btnApplyImportNoteConflict').addEventListener('click', doApplyImportNoteConflict);
  $('btnNotesSelectAll').addEventListener('click', () => {
    const notes = secrets.filter((s) => s.type === 'note');
    const query = searchNotes ? searchNotes.value : '';
    const filtered = sortSecrets(filterByQuery(notes, query), notesSort);
    filtered.forEach((s) => checkedNotes.add(s.id));
    renderNotesList();
  });
  $('btnNotesUnselectAll').addEventListener('click', () => {
    checkedNotes.clear();
    renderNotesList();
  });
  $('btnPrintNotes').addEventListener('click', printSelectedNotes);
  $('btnDeleteSelectedNotes').addEventListener('click', openConfirmDeleteSelectedNotes);
  $('notesPrevPage').addEventListener('click', () => {
    if (notesPage > 1) {
      notesPage--;
      renderNotesList();
    }
  });
  $('notesNextPage').addEventListener('click', () => {
    notesPage++;
    renderNotesList();
  });
  $('loginsPrevPage').addEventListener('click', () => {
    if (loginsPage > 1) {
      loginsPage--;
      renderLoginsList();
    }
  });
  $('loginsNextPage').addEventListener('click', () => {
    loginsPage++;
    renderLoginsList();
  });
  secretForm.addEventListener('submit', saveSecret);
  btnCancelSecret.addEventListener('click', () => secretDialog.close());
  $('btnGeneratePassword').addEventListener('click', openPasswordGenerator);
  $('generatorLength').addEventListener('input', () => {
    const slider = $('generatorLength');
    const val = slider.value;
    const el = $('generatorLengthValue');
    if (el) el.textContent = val;
    slider.setAttribute('aria-valuenow', val);
    updateGeneratorPreview();
  });
  [$('generatorUppercase'), $('generatorLowercase'), $('generatorNumbers'), $('generatorSymbols')].forEach((cb) => {
    if (cb) cb.addEventListener('change', () => { ensureOneGeneratorCheckbox(); updateGeneratorPreview(); });
  });
  $('btnCancelGenerator').addEventListener('click', () => $('passwordGeneratorDialog').close());
  $('btnOkGenerator').addEventListener('click', applyGeneratedPassword);
  $('btnCloseAbout').addEventListener('click', () => $('aboutDialog').close());
  $('aboutSourceLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.app.openExternal('https://github.com/CodeGator/MimiDesktop');
  });
  $('btnCancelConfirmDelete').addEventListener('click', () => {
    pendingDeleteSecret = null;
    pendingDeleteLoginIds = null;
    pendingDeleteNoteIds = null;
    confirmDeleteDialog.close();
  });
  $('btnConfirmDelete').addEventListener('click', doConfirmDelete);
  confirmDeleteDialog.addEventListener('close', () => {
    pendingDeleteSecret = null;
    pendingDeleteLoginIds = null;
    pendingDeleteNoteIds = null;
  });

  toggleMasterPassword.addEventListener('click', () => togglePasswordVisibility(masterPasswordInput, toggleMasterPassword));
  togglePassword.addEventListener('click', () => togglePasswordVisibility(secretPassword, togglePassword));
  $('copyPassword').addEventListener('click', async () => {
    const pwd = secretPassword.value;
    if (pwd) {
      try {
        await navigator.clipboard.writeText(pwd);
        const btn = $('copyPassword');
        const origTitle = btn.getAttribute('title');
        btn.setAttribute('title', 'Copied!');
        btn.setAttribute('aria-label', 'Copied!');
        setTimeout(() => {
          btn.setAttribute('title', origTitle);
          btn.setAttribute('aria-label', origTitle);
        }, 1500);
      } catch (err) {
        showError(secretError, 'Could not copy to clipboard');
      }
    }
  });
  toggleCurrentMasterPassword.addEventListener('click', () => togglePasswordVisibility(currentMasterPassword, toggleCurrentMasterPassword));
  function toggleNewAndConfirmPasswordVisibility() {
    const showPassword = newMasterPassword.type === 'password';
    newMasterPassword.type = showPassword ? 'text' : 'password';
    confirmMasterPassword.type = showPassword ? 'text' : 'password';
    [toggleNewMasterPassword, toggleConfirmMasterPassword].forEach((btn) => {
      const eye = btn.querySelector('.icon-eye');
      const eyeOff = btn.querySelector('.icon-eye-off');
      if (eye) eye.hidden = showPassword;
      if (eyeOff) eyeOff.hidden = !showPassword;
      btn.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
      btn.setAttribute('title', showPassword ? 'Hide password' : 'Show password');
    });
  }
  toggleNewMasterPassword.addEventListener('click', toggleNewAndConfirmPasswordVisibility);
  toggleConfirmMasterPassword.addEventListener('click', toggleNewAndConfirmPasswordVisibility);

  secretDialog.addEventListener('close', () => {
    secretPassword.type = 'password';
    const eye = togglePassword.querySelector('.icon-eye');
    const eyeOff = togglePassword.querySelector('.icon-eye-off');
    if (eye) eye.hidden = false;
    if (eyeOff) eyeOff.hidden = true;
  });

  changePasswordDialog.addEventListener('close', () => {
    if (newPasswordStrengthEl) {
      newPasswordStrengthEl.textContent = '';
      newPasswordStrengthEl.className = 'password-strength';
      newPasswordStrengthEl.hidden = true;
    }
    currentMasterPassword.type = 'password';
    newMasterPassword.type = 'password';
    confirmMasterPassword.type = 'password';
    [toggleCurrentMasterPassword, toggleNewMasterPassword, toggleConfirmMasterPassword].forEach((btn) => {
      const eye = btn.querySelector('.icon-eye');
      const eyeOff = btn.querySelector('.icon-eye-off');
      if (eye) eye.hidden = false;
      if (eyeOff) eyeOff.hidden = true;
    });
  });

  init();
})();
