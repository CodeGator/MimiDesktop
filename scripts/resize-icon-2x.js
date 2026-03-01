/**
 * Resizes build/nd0021/nd0021-48.png to 2x (96x96) and saves as nd0021-96.png.
 * Run: node scripts/resize-icon-2x.js
 * Requires: npm install sharp (dev)
 */
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = path.join(root, 'build', 'nd0021', 'nd0021-48.png');
const dest = path.join(root, 'build', 'nd0021', 'nd0021-96.png');

sharp(src)
  .resize(96, 96)
  .toFile(dest)
  .then(() => console.log('Created:', dest))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
