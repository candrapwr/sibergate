#!/usr/bin/env node
/**
 * Start the admin (Next.js) on the port from packages/admin/.env.local.
 *
 * Why this exists: `next dev -p ${SIBERGATE_ADMIN_PORT:-3000}` in package.json
 * doesn't work, because the shell expands ${...} BEFORE dotenv-cli can load
 * .env.local — so the port always falls back to 3000. This tiny loader reads
 * .env.local first (so SIBERGATE_ADMIN_PORT is defined), then spawns `next`
 * with the resolved port. Next.js itself also reads .env.local for app code.
 *
 * Usage (from packages/admin): node scripts/start.mjs dev|start
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(__dirname, '..');

// Load .env.local into process.env (minimal parser — KEY=VALUE per line).
const envFile = resolve(adminDir, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}

const port = process.env.SIBERGATE_ADMIN_PORT || '3000';
const mode = process.argv[2] === 'build' ? 'build' : process.argv[2] || 'dev';

// Spawn next with the resolved port. Inherit stdio so logs stream to the parent.
// In an npm workspace the `next` bin is hoisted to the repo root node_modules,
// so fall back to that if the local one isn't present.
const candidates = [
  resolve(adminDir, 'node_modules/.bin/next'),
  resolve(adminDir, '../../node_modules/.bin/next'),
];
const nextBin = candidates.find((p) => existsSync(p));
if (!nextBin) {
  console.error('Could not find the `next` binary. Run `npm install` first.');
  process.exit(1);
}
const args = mode === 'build' ? ['build'] : [mode, '-p', port];
const child = spawn(nextBin, args, {
  cwd: adminDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
