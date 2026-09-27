#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Resolver } from 'node:dns';
import { request as httpsRequest } from 'node:https';
const resolver = new Resolver({ timeout: 2000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);
const publicLookup = (host, options, callback) => resolver.resolve4(host, (error, addresses) => {
  if (error) return callback(error);
  if (options?.all) callback(null, addresses.map(address => ({ address, family: 4 })));
  else callback(null, addresses[0], 4);
});
function publicRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { lookup: publicLookup, headers, timeout: 8000 }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode === 200, json: async () => JSON.parse(text) }));
    });
    request.on('timeout', () => request.destroy(new Error('Public HTTPS verification timed out.')));
    request.on('error', reject); request.end();
  });
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(process.env.GLANCE_LOCAL_DIR || join(root, '.local'));
const statePath = join(local, 'demo-processes.json');
const tunnelPath = join(local, 'tunnel.json');
const pairingPath = join(local, 'pairing.json');
const origin = 'http://127.0.0.1:8790';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = pid => { const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
const save = (path, value) => { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); chmodSync(path, 0o600); };
async function check(url) {
  const health = url.startsWith('https:') ? await publicRequest(`${url}/api/health`) : await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  const body = await health.json();
  if (!health.ok || body.service !== 'glance-qm' || body.providerMode !== 'live') throw new Error('Live backend health check failed.');
  const headers = { authorization: 'Bearer invalid-tunnel-probe' };
  const denied = url.startsWith('https:') ? await publicRequest(`${url}/api/meetings/__tunnel_probe__`, headers) : await fetch(`${url}/api/meetings/__tunnel_probe__`, { headers, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (denied.status !== 401) throw new Error('Backend did not reject invalid authentication.');
}
const pairing = JSON.parse(readFileSync(pairingPath, 'utf8'));
if (typeof pairing.operatorToken !== 'string' || pairing.operatorToken.length < 32) throw new Error('Existing private pairing token is required.');
await check(origin);
let record = existsSync(tunnelPath) ? JSON.parse(readFileSync(tunnelPath, 'utf8')) : undefined;
let ownedNew = false;
try {
  if (!record || identity(record.pid) !== record.identity) {
    const binary = process.env.CLOUDFLARED_BIN || '/opt/homebrew/bin/cloudflared';
    if (!existsSync(binary)) throw new Error('Install cloudflared or set CLOUDFLARED_BIN.');
    const logPath = join(local, `tunnel-${Date.now()}.log`);
    const fd = openSync(logPath, 'w', 0o600);
    const args = ['tunnel', '--config', '/dev/null', '--no-autoupdate', '--protocol', 'http2', '--url', origin];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key)));
    const child = spawn(binary, args, { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd); child.unref();
    if (!child.pid) throw new Error('Could not start the owned tunnel.');
    record = { name: 'tunnel', pid: child.pid, identity: identity(child.pid), logFile: logPath, origin };
    ownedNew = true; save(tunnelPath, record);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.root !== root) throw new Error('App process ownership record does not match.');
    state.processes = [...state.processes.filter(item => item.name !== 'tunnel'), record]; save(statePath, state);
    for (let n = 0; n < 120; n++) {
      const text = readFileSync(logPath, 'utf8');
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) { record.url = match[0]; break; }
      if (identity(record.pid) !== record.identity) throw new Error('Tunnel exited; inspect its private log.');
      await pause(250);
    }
    if (!record.url) throw new Error('Quick Tunnel URL was not allocated within 30 seconds.');
    save(tunnelPath, record);
  }
  let ready = false; let readinessError;
  for (let n = 0; n < 60; n++) { try { await check(record.url); ready = true; break; } catch (error) { readinessError = error; await pause(1000); } }
  if (!ready) throw new Error(`Public HTTPS readiness check pending: ${readinessError?.message || 'unavailable'}`);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(record.url.replace('https:', 'wss:') + '/api/meetings/__tunnel_probe__/events', { lookup: publicLookup });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Public WebSocket auth probe timed out.')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'invalid-tunnel-probe' })));
    ws.on('close', code => { clearTimeout(timer); code === 4401 ? resolve() : reject(new Error('WebSocket initial authentication was not enforced.')); });
    ws.on('error', () => { clearTimeout(timer); reject(new Error('Public WebSocket upgrade failed.')); });
  });
  let authenticatedSnapshot = false;
  const testMeeting = process.env.GLANCE_TUNNEL_TEST_MEETING_ID;
  if (testMeeting) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(testMeeting)) throw new Error('Invalid WebSocket test meeting ID.');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(record.url.replace('https:', 'wss:') + `/api/meetings/${testMeeting}/events`, { lookup: publicLookup });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Authenticated WebSocket snapshot timed out.')); }, 8000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: pairing.operatorToken })));
      ws.on('message', raw => {
        try { const event = JSON.parse(raw.toString()); if (event.type === 'snapshot' && event.meetingId === testMeeting) { authenticatedSnapshot = true; clearTimeout(timer); ws.close(); resolve(); } }
        catch { clearTimeout(timer); ws.terminate(); reject(new Error('WebSocket returned an invalid event.')); }
      });
      ws.on('close', () => { if (!authenticatedSnapshot) { clearTimeout(timer); reject(new Error('Authenticated WebSocket closed before snapshot.')); } });
      ws.on('error', () => { clearTimeout(timer); reject(new Error('Authenticated WebSocket probe failed.')); });
    });
  }
  save(pairingPath, { ...pairing, serverURL: record.url });
  save(tunnelPath, { ...record, verifiedAt: new Date().toISOString(), checks: { health: 200, invalidBearer: 401, websocketInvalidAuth: 4401, ...(authenticatedSnapshot ? { authenticatedSnapshot: true } : {}) } });
  console.log(`Temporary native HTTPS: ${record.url}`);
  console.log(`Private pairing file: ${pairingPath}`);
  console.log('External health200, invalid bearer401, and WebSocket initial-auth4401 verified. Token unchanged.');
  if (authenticatedSnapshot) console.log('Authenticated external WebSocket snapshot verified; content omitted.');
} catch (error) {
  if (ownedNew && record && identity(record.pid) === record.identity && !record.url) process.kill(record.pid, 'SIGTERM');
  console.error(error instanceof Error ? error.message : 'Tunnel startup failed.'); process.exitCode = 1;
}
