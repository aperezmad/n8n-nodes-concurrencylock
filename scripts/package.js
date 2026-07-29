#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

const packageName = pkg.name.split('/').pop();
const tarballName = `${packageName}-${pkg.version}.tgz`;

const stagingRoot = path.join(root, '.tmp', 'package');
const stagingDir = path.join(stagingRoot, packageName);

fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

fs.cpSync(path.join(root, 'dist'), path.join(stagingDir, 'dist'), { recursive: true });
fs.rmSync(path.join(stagingDir, 'dist', 'tsconfig.tsbuildinfo'), { force: true });

const { devDependencies, scripts, ...runtimePkg } = pkg;
fs.writeFileSync(
  path.join(stagingDir, 'package.json'),
  JSON.stringify(runtimePkg, null, 2) + '\n',
);

for (const file of ['README.md', 'LICENSE.md']) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(stagingDir, file));
  }
}

execSync('npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund', {
  cwd: stagingDir,
  stdio: 'inherit',
});

const tarballPath = path.join(root, tarballName);
fs.rmSync(tarballPath, { force: true });
execSync(`tar -czf "${tarballPath}" -C "${stagingRoot}" "${packageName}"`, {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});

fs.rmSync(stagingRoot, { recursive: true, force: true });

console.log(`Created ${tarballName}`);
console.log(`Extract it into .n8n/custom/ to get a ready-to-use ${packageName}/ folder.`);
