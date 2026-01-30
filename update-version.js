/**
 * Run by npm during "npm version" (patch/minor/major).
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const versionTag = 'v' + version;

  // Today's date (YYYY-MM-DD)
  const today = new Date().toISOString().slice(0, 10);

  // 1. CHANGELOG.md
  const changelogPath = path.join(root, 'CHANGELOG.md');
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  const newSection = `## ${versionTag}
*${today}*

-

`;
  changelog = newSection + changelog;
  fs.writeFileSync(changelogPath, changelog);

  // 2. imgextract.html and standalone.html — replace version in footer
  const versionRegex = /v\d+\.\d+\.\d+/;
  for (const name of ['imgextract.html', 'standalone.html']) {
    const htmlPath = path.join(root, 'static', name);
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(versionRegex, versionTag);
    fs.writeFileSync(htmlPath, html);
  }

  console.log('Updated version to', versionTag, 'in CHANGELOG.md, imgextract.html, standalone.html');
} catch (err) {
  console.error('update-version.js:', err.message);
  process.exit(1);
}
