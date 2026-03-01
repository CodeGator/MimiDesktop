/**
 * Creates nd0021-256.png (256x256) from nd0021-48.png for electron-builder.
 * Windows build requires icon at least 256x256.
 * Run: node scripts/resize-icon-256.js  or  npm run icon:256
 */
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = path.join(root, 'build', 'nd0021', 'nd0021-48.png');
const dest = path.join(root, 'build', 'nd0021', 'nd0021-256.png');

sharp(src)
  .resize(256, 256)
  .toFile(dest)
  .then(() => console.log('Created:', dest))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
