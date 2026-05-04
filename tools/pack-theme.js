#!/usr/bin/env node
// Usage: node tools/pack-theme.js <theme-folder>
// e.g.:  node tools/pack-theme.js src/themes/dark-slate
// Outputs a .zip in the current directory ready to push to the themes branch.

const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const themeDir = process.argv[2];
if (!themeDir) { console.error('Usage: node tools/pack-theme.js <theme-folder>'); process.exit(1); }

const absDir = path.resolve(themeDir);
if (!fs.existsSync(absDir)) { console.error('Folder not found:', absDir); process.exit(1); }

const metaFile = path.join(absDir, 'theme.json');
if (!fs.existsSync(metaFile)) { console.error('theme.json not found in', absDir); process.exit(1); }

const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const slug = path.basename(absDir);
const outPath = path.join(process.cwd(), slug + '.zip');

const output = fs.createWriteStream(outPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`Packed "${meta.name}" → ${outPath} (${archive.pointer()} bytes)`);
});
archive.on('error', err => { throw err; });

archive.pipe(output);
archive.directory(absDir, false);
archive.finalize();
