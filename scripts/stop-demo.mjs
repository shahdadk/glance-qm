#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = join(resolve(process.env.GLANCE_LOCAL_DIR || join(root, '.local')), 'demo-processes.json');
if (!existsSync(stateFile)) { console.log('No owned demo processes recorded.'); process.exit(0); }
const backendOnly = process.argv.includes('--backend-only');
if (process.argv.slice(2).some(arg => arg !== '--backend-only')) throw new Error('Usage: node scripts/stop-demo.mjs [--backend-only]');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const retained = [];
if (state.root !== root || state.version !== 1 || !Array.isArray(state.processes)) throw new Error('Invalid process ownership record; refusing to stop anything.');
function identity(pid) { const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }
for (const record of [...state.processes].reverse()) {
  if (backendOnly && record.name !== 'backend') { retained.push(record); continue; }
  if (!Number.isInteger(record.pid) || record.pid <= 1 || !['backend', 'web', 'tunnel'].includes(record.name)) throw new Error('Invalid owned process record.');
  const expected = record.name === 'backend' ? join(root, 'src/server/index.ts') : record.name === 'web' ? join(root, 'node_modules/vite/bin/vite.js') : 'cloudflared tunnel --config /dev/null --no-autoupdate --protocol http2 --url http://127.0.0.1:8790';
  if (!record.identity?.includes(expected) || identity(record.pid) !== record.identity) { console.log(`Skipped ${record.name}: recorded process no longer matches.`); continue; }
  process.kill(record.pid, 'SIGTERM');
  for (let n = 0; n < 60 && identity(record.pid) === record.identity; n++) await new Promise(resolve => setTimeout(resolve, 100));
  if (identity(record.pid) === record.identity) process.kill(record.pid, 'SIGKILL');
  console.log(`Stopped owned ${record.name}.`);
}
if (retained.length) { state.processes = retained.reverse(); writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); chmodSync(stateFile, 0o600); }
else unlinkSync(stateFile);
console.log(backendOnly ? 'Backend-only stop: owned tunnel and frontend processes preserved.' : 'QM, GBrain, Docker, and pre-existing frontend processes were preserved.');
