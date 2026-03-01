# Mimi Desktop

A local, encrypted password and note manager built with Electron. All data is stored in a single encrypted file on disk.

## Features

- **Encrypted at rest**: Vault file is encrypted with AES-256-GCM. The key is derived from your master password using PBKDF2 (600,000 iterations, SHA-256).
- **Passwords and notes**: Store login credentials (name, username, password) or secure notes.
- **CRUD**: Create, read, update, and delete secrets. Search by name, username, or note content.
- **No cloud**: Everything stays on your machine. The vault file lives in Electron’s user data directory.

## Security notes

- Your **master password is never stored**. It is only used to derive the encryption key and is kept in memory only while the vault is unlocked.
- **Lock** when you leave the app to clear the key from memory.
- Choose a **strong master password**. If you lose it, the vault cannot be recovered.
- The app uses a **Content-Security-Policy**, **contextIsolation**, and **sandbox** in the renderer. Crypto and file I/O run only in the main process.

## Requirements

- Node.js 18+
- npm or yarn

## Setup and run

**One-time setup:** run `npm install` in the project folder.

**To run the app:** double-click `Run.bat`. It starts the built exe if present; if not, it runs `npm start`. To build the exe, run `Build.bat` (or `npm run dist`). You can also run `npm start` from a terminal.

## Project structure

```
Mimi Desktop/
├── package.json
├── src/
│   ├── main/
│   │   ├── main.js           # Electron entry, window, IPC
│   │   ├── preload.js        # Context bridge for renderer
│   │   └── services/
│   │       ├── CryptoService.js   # Key derivation, encrypt/decrypt
│   │       └── VaultService.js    # Vault file I/O, CRUD
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       └── renderer.js
└── README.md
```

**Build.bat** runs `npm run dist`. Output is in `dist` (installer and `dist\win-unpacked\Mimi Desktop.exe`). For detailed build steps, code signing, and release verification, see **docs/BUILD-AND-RELEASE.md**.

## App data folder

Mimi Desktop stores its data in an app-specific folder created by Electron. On Windows this is typically a folder under `%APPDATA%` (e.g. `C:\Users\<user>\AppData\Roaming\<app-data-folder>`). You can change the data location via **Options → Data location → Browse**.

### Files and folders created by Mimi Desktop

| File / folder | Purpose |
|---------------|---------|
| `config.json` | App settings (e.g. custom data path if you chose a different folder) |
| `vault.enc` | Encrypted vault containing all notes and logins (when using the default data path) |
| `backups/` | Default folder for backup zip files. The save dialog opens here; you can choose another location. |

If you set a custom data path, `vault.enc` is stored in the folder you chose; `config.json` and `backups/` remain in the app data folder.

### Backup and restore

You can back up your data via **Options → Backup → Backup data**. This saves `vault.enc` and `config.json` to a timestamped folder of your choice.

**Restoring from a backup** (Options → Backup → Restore from backup) replaces your current vault and config with the backup. **Important:** Restoring also restores the master password to whatever it was when the backup was created. You must use that backup’s master password to unlock after a restore, not your current one.

### Folders created by Electron/Chromium

Electron uses Chromium for the app window; these folders are created automatically and are **not** created by Mimi Desktop:

| Folder | Purpose |
|--------|---------|
| `blob_storage` | Blob URLs and binary data used by the renderer |
| `Cache` | General browser cache |
| `Code Cache` | Cached compiled JavaScript |
| `DawnCache` | Chromium Dawn graphics cache |
| `GPUCache` | GPU shader and graphics cache |
| `Local Storage` | `localStorage` data for the web view |
| `Network` | HTTP/network cache |
| `Session Storage` | `sessionStorage` data for the web view |
| `Shared Dictionary` | Compression dictionaries |

You can delete these cache folders to free space; they will be recreated when the app runs again.

## License

MIT
