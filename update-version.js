// Sync version to __init__.py
const fs = require('fs');
const path = require('path');

try {
  const pkgPath = path.join(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;
} catch (err) {
  console.warn('update-version.js:', err.message);
}
process.exit(0);
