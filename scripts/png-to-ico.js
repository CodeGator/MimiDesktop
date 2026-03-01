/**
 * Creates nd0021.ico from nd0021-256.png for NSIS (installer requires .ico).
 * Run: node scripts/png-to-ico.js  or  npm run icon:ico
 */
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const src = path.join(root, 'build', 'nd0021', 'nd0021-256.png');
const dest = path.join(root, 'build', 'nd0021', 'nd0021.ico');

async function main() {
  const pngToIco = (await import('png-to-ico')).default;
  const buf = await pngToIco(src);
  fs.writeFileSync(dest, buf);
  console.log('Created:', dest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
