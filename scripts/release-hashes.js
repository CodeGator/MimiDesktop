/**
 * Prints SHA-256 hashes of critical source files for release verification.
 * Run with: npm run release:hashes
 * Publish the output with a release so others can verify the build matches the source.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  'src/main/main.js',
  'src/main/preload.js',
  'src/main/services/CryptoService.js',
  'src/main/services/VaultService.js',
  'src/renderer/index.html',
  'src/renderer/renderer.js',
  'src/renderer/styles.css',
];

console.log('SHA-256 hashes of source files (for release verification)\n');
for (const rel of files) {
  const full = path.join(root, rel);
  try {
    const data = fs.readFileSync(full);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    console.log(`${hash}  ${rel}`);
  } catch (err) {
    console.error(`Error reading ${rel}:`, err.message);
    process.exitCode = 1;
  }
}
