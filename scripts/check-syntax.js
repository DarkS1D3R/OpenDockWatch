const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['server', 'public/js', 'scripts'];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

for (const root of roots) walk(path.join(__dirname, '..', root));

let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  } catch {
    failed = true;
  }
}

if (failed) {
  console.error(`\nSyntax check failed for one or more files.`);
  process.exit(1);
}
console.log(`Syntax OK (${files.length} files).`);
