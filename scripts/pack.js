#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release', 'n8n-nodes-concurrencylock');
const ARTIFACT = path.join(ROOT, 'n8n-nodes-concurrencylock.tgz');

// Clean staging dir
if (fs.existsSync(RELEASE_DIR)) fs.rmSync(RELEASE_DIR, { recursive: true });
fs.mkdirSync(RELEASE_DIR, { recursive: true });

// Copy compiled output
fs.cpSync(path.join(ROOT, 'dist'), path.join(RELEASE_DIR, 'dist'), { recursive: true });

// Write a stripped package.json with only production dependencies
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
delete pkg.devDependencies;
fs.writeFileSync(path.join(RELEASE_DIR, 'package.json'), JSON.stringify(pkg, null, 2));

// Install only production dependencies
execSync('npm install --omit=dev --legacy-peer-deps', { cwd: RELEASE_DIR, stdio: 'inherit' });

// Remove dist/package.json if tsc copied it (happens when package.json is in tsconfig include)
const spuriousPkg = path.join(RELEASE_DIR, 'dist', 'package.json');
if (fs.existsSync(spuriousPkg)) fs.rmSync(spuriousPkg);

// Create the artifact with the parent folder included.
// COPYFILE_DISABLE=1 prevents macOS BSD tar from embedding Apple extended attributes,
// which would cause harmless but noisy warnings when extracting on Linux.
const STAGING = path.join(ROOT, 'release');
execSync(`tar -czf "${ARTIFACT}" -C "${STAGING}" n8n-nodes-concurrencylock`, {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
});

// Cleanup staging dir
fs.rmSync(STAGING, { recursive: true });

console.log(`\nArtifact ready: n8n-nodes-concurrencylock.tgz`);
