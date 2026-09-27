#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = join(resolve(process.env.GLANCE_LOCAL_DIR || join(root, '.local')), 'demo-processes.json');
if (!existsSync(stateFile)) { console.log('No owned demo processes recorded.'); process.exit(0); }
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
if (state.root !== root || state.version !== 1 || !Array.isArray(state.processes)) throw new Error('Invalid process ownership record; refusing to stop anything.');
function identity(pid) { const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }
for (const record of [...state.processes].reverse()) {
  if (!Number.isInteger(record.pid) || record.pid <= 1 || !['backend', 'web'].includes(record.name)) throw new Error('Invalid owned process record.');
  const expected = record.name === 'backend' ? join(root, 'src/server/index.ts') : join(root, 'node_modules/vite/bin/vite.js');
  if (!record.identity?.includes(expected) || identity(record.pid) !== record.identity) { console.log(`Skipped ${record.name}: recorded process no longer matches.`); continue; }
  process.kill(record.pid, 'SIGTERM');
  for (let n = 0; n < 60 && identity(record.pid) === record.identity; n++) await new Promise(resolve => setTimeout(resolve, 100));
  if (identity(record.pid) === record.identity) process.kill(record.pid, 'SIGKILL');
  console.log(`Stopped owned ${record.name}.`);
}
unlinkSync(stateFile);
console.log('QM, GBrain, Docker, and pre-existing frontend processes were preserved.');
