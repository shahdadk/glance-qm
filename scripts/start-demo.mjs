#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configDir = join(homedir(), '.config/glance-qm');
const localDir = resolve(process.env.GLANCE_LOCAL_DIR || join(root, '.local'));
mkdirSync(localDir, { recursive: true, mode: 0o700 });
chmodSync(localDir, 0o700);
const stateFile = join(localDir, 'demo-processes.json');
const logFile = join(localDir, 'demo-backend.log');
const node = process.env.QM_NODE_BIN || ['/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node'].find(existsSync) || process.execPath;
const allowed = new Set(`PATH HOME TMPDIR LANG LC_ALL TZ USER LOGNAME SHELL NODE_EXTRA_CA_CERTS PORT HOST WEB_PORT GLANCE_LOCAL_DIR GLANCE_OPERATOR_TOKEN GLANCE_ALLOWED_ORIGINS GLANCE_DECISION_MODE QM_BASE_URL QM_SOURCE_SECRET QM_SIGNING_SECRET CORE_SIGNING_SECRET QM_PROJECT_ID QM_THREAD_REF QM_ACTOR_EXTERNAL_ID QM_PRINCIPAL_ID QM_ACTOR_DISPLAY_NAME QM_ACTOR_EMAIL QM_MODEL QM_HARNESS QM_THINKING_LEVEL QM_JUDGE_MODEL QM_JUDGE_THINKING_LEVEL QM_JUDGE_FAST_MODE QM_CONNECTION_FILE QM_RUNTIME_ENV GBRAIN_CONFIG_FILE GBRAIN_MCP_URL GBRAIN_BASE_URL GBRAIN_CLIENT_ID GBRAIN_CLIENT_SECRET GBRAIN_TOKEN_URL GBRAIN_RECALL_TOOL GBRAIN_SAVE_SUMMARY_TOOL GBRAIN_GET_PAGE_TOOL GBRAIN_AUTH_MODE GBRAIN_BEARER_TOKEN GBRAIN_API_TOKEN MEMORABLE_API_KEY MEMORABLE_BIN MEMORABLE_HOME MEMORABLE_BASE_URL MEMORABLE_API_TOKEN MEMORABLE_CONFIG_FILE GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REFRESH_TOKEN GOOGLE_ACCESS_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN GOOGLE_CALENDAR_ID GOOGLE_OAUTH_CONFIG_FILE GOOGLE_WORKSPACE_CLI_CONFIG_DIR GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE JEV_API_KEY TYPESAFE_API_KEY JEV_MODEL JEV_BASE_URL`.split(' '));
const env = {};
function merge(source) {
  for (const [key, value] of Object.entries(source)) if (allowed.has(key) && typeof value === 'string' && value.trim()) env[key] = value;
  const secret = source.QM_SOURCE_SECRET || source.QM_SIGNING_SECRET || source.CORE_SIGNING_SECRET;
  if (secret) env.QM_SOURCE_SECRET = secret;
  const actor = source.QM_ACTOR_EXTERNAL_ID || source.QM_PRINCIPAL_ID;
  if (actor) env.QM_ACTOR_EXTERNAL_ID = actor;
}
function envFile(path) { return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}; }
function jsonFile(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function privateWrite(path, value) { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); }
const runtimePath = process.env.QM_RUNTIME_ENV || join(configDir, 'runtime.env');
const runtime = envFile(runtimePath);
const connectionPath = process.env.QM_CONNECTION_FILE || join(configDir, 'connection.json');
const connection = existsSync(connectionPath) ? jsonFile(connectionPath) : {};
merge({ HOME: homedir(), PATH: `${dirname(node)}:${process.env.PATH || '/usr/bin:/bin'}`, PORT: '8790', WEB_PORT: '5174', HOST: '0.0.0.0', GLANCE_LOCAL_DIR: localDir,
  QM_JUDGE_MODEL: 'gpt-6-luna', QM_JUDGE_THINKING_LEVEL: 'low', QM_JUDGE_FAST_MODE: 'true', QM_BASE_URL: connection.baseUrl, QM_SOURCE_SECRET: runtime.CORE_SIGNING_SECRET, QM_PROJECT_ID: connection.projectId, QM_THREAD_REF: connection.threadRef, QM_ACTOR_EXTERNAL_ID: connection.principalIds?.[0], QM_MODEL: runtime.CODEX_MODEL, QM_HARNESS: runtime.HARNESS,
  MEMORABLE_BIN: existsSync(join(configDir, 'tools/node_modules/.bin/memorable')) ? join(configDir, 'tools/node_modules/.bin/memorable') : undefined, GBRAIN_RECALL_TOOL: 'search', GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page', GBRAIN_CONFIG_FILE: join(homedir(), '.local/share/glance-qm/gbrain-runtime/backend-oauth.json'), GOOGLE_WORKSPACE_CLI_CONFIG_DIR: join(configDir, 'gws') });
for (const path of [join(configDir, 'memorable.env'), join(configDir, 'google.env'), join(configDir, 'jev.env'), join(configDir, 'demo.env'), join(root, '.env')]) merge(envFile(path));
merge(process.env);
if (process.env.GLANCE_USE_GOOGLE_SHELL_ENV !== '1') merge(envFile(join(configDir, 'google.env')));
env.GLANCE_LOCAL_DIR = localDir;
if (env.CORE_SIGNING_SECRET && !env.QM_SOURCE_SECRET) env.QM_SOURCE_SECRET = env.CORE_SIGNING_SECRET;
const port = Number(env.PORT), webPort = Number(env.WEB_PORT);
if (![port, webPort].every(value => Number.isInteger(value) && value > 1024 && value < 65536) || port === 8787 || port === webPort) throw new Error('Choose distinct nonprivileged demo ports; existing Glance port 8787 is reserved.');
if (!['0.0.0.0', '127.0.0.1', 'localhost'].includes(env.HOST)) throw new Error('Demo HOST must be a loopback address or 0.0.0.0 for LAN.');
const loopback = `http://127.0.0.1:${port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const owned = [];
function identity(pid) { const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }
function saveState(extra = {}) { privateWrite(stateFile, JSON.stringify({ version: 1, root, localDir, processes: owned, ...extra }, null, 2) + '\n'); }
async function fetchLocal(path, options = {}) { return fetch(`${loopback}${path}`, { ...options, signal: AbortSignal.timeout(2000), redirect: 'error' }); }
async function healthy() { try { const r = await fetchLocal('/api/health'); const data = await r.json(); return r.ok && data.service === 'glance-qm' && data.ok === true ? data : null; } catch { return null; } }
async function authCheck() {
  const denied = await fetchLocal('/api/meetings/__launcher_probe__');
  const allowed = await fetchLocal('/api/meetings/__launcher_probe__', { headers: { authorization: `Bearer ${env.GLANCE_OPERATOR_TOKEN}` } });
  if (denied.status !== 401 || allowed.status !== 404) throw new Error('Backend failed the unauthorized/authorized authentication checks.');
}
async function terminate(record) {
  if (!record || identity(record.pid) !== record.identity) return;
  process.kill(record.pid, 'SIGTERM');
  for (let n = 0; n < 60 && identity(record.pid) === record.identity; n++) await delay(100);
  if (identity(record.pid) === record.identity) process.kill(record.pid, 'SIGKILL');
}
function launch(name, args, childEnv) {
  const path = name === 'backend' ? logFile : join(localDir, 'demo-web.log');
  const fd = openSync(path, 'a', 0o600); chmodSync(path, 0o600);
  const child = spawn(node, args, { cwd: root, env: childEnv, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd); child.unref();
  if (!child.pid) throw new Error(`Could not spawn ${name}; inspect its private log.`);
  const record = { name, pid: child.pid, identity: identity(child.pid), logFile: path };
  if (!record.identity) throw new Error(`${name} exited before its process identity could be recorded.`);
  owned.push(record); saveState(); return record;
}
async function waitBackend(record) {
  for (let n = 0; n < 100; n++) {
    if (await healthy()) return;
    if (identity(record.pid) !== record.identity) throw new Error('Backend exited; inspect the private backend log.');
    await delay(100);
  }
  throw new Error('Backend health did not become ready; inspect the private backend log.');
}
async function checkProviders() {
  for (const key of ['QM_BASE_URL', 'QM_SOURCE_SECRET', 'QM_PROJECT_ID', 'QM_THREAD_REF']) if (!env[key]) throw new Error(`Missing ${key}; provision the real QM instance first.`);
  let qmURL;
  try { qmURL = new URL(env.QM_BASE_URL); } catch { throw new Error('QM_BASE_URL must be a valid HTTP(S) base URL.'); }
  if (!['http:', 'https:'].includes(qmURL.protocol) || qmURL.username || qmURL.password || qmURL.search || qmURL.hash) throw new Error('QM_BASE_URL must not contain credentials, query parameters, or fragments.');
  const path = `/v1/projects?principalId=${encodeURIComponent(env.QM_ACTOR_EXTERNAL_ID || env.QM_PRINCIPAL_ID || 'glance-founder')}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', env.QM_SOURCE_SECRET).update(`v0:${timestamp}:GET\n${path}\n`).digest('hex')}`;
  const response = await fetch(`${env.QM_BASE_URL}${path}`, { headers: { 'x-timestamp': timestamp, 'x-signature': signature }, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error('QM authenticated project readiness check failed. Start the documented QM runtime first.');
  const projects = await response.json();
  if (!projects.projects?.some(project => project.id === env.QM_PROJECT_ID)) throw new Error('Configured QM project is unavailable to the operator.');
  const code = `import {readFileSync,existsSync} from 'node:fs'; import {GBrainClient} from './src/integrations/gbrain.ts'; const e=process.env; const f=e.GBRAIN_CONFIG_FILE&&existsSync(e.GBRAIN_CONFIG_FILE)?JSON.parse(readFileSync(e.GBRAIN_CONFIG_FILE,'utf8')):{}; const c={url:e.GBRAIN_MCP_URL||e.GBRAIN_BASE_URL||f.url,clientId:e.GBRAIN_CLIENT_ID||f.clientId,clientSecret:e.GBRAIN_CLIENT_SECRET||f.clientSecret,tokenUrl:e.GBRAIN_TOKEN_URL||f.tokenUrl,bearerToken:e.GBRAIN_BEARER_TOKEN||(e.GBRAIN_AUTH_MODE==='bearer'?(e.GBRAIN_API_TOKEN||f.bearerToken):undefined)}; const tools=await new GBrainClient(c).listTools(); if(!tools.length) process.exit(1);`;
  const probe = spawnSync(node, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: root, env, stdio: 'pipe', timeout: 30000 });
  if (probe.status !== 0) throw new Error('GBrain authenticated MCP catalog readiness check failed. Start the documented GBrain runtime first.');
  console.log('Verified QM project access and authenticated GBrain MCP tools.');
}
function report(data, tokenPath, pairingPath) {
  console.log(`Desktop: http://localhost:${webPort}`);
  console.log(`Backend: ${loopback}`);
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, values]) => (values || []).filter(address => address.family === 'IPv4' && !address.internal && /^(en|eth|wlan)/.test(name)).map(address => address.address));
  const ip = process.env.GLANCE_LAN_IP || candidates[0];
  const nativeURL = env.HOST === '0.0.0.0' && ip ? `http://${ip}:${port}` : loopback;
  if (env.HOST === '0.0.0.0' && ip) console.log(`Native LAN: ${nativeURL}`);
  else console.log('Native LAN unavailable; select an active LAN interface and HOST=0.0.0.0.');
  privateWrite(pairingPath, JSON.stringify({ serverURL: nativeURL, operatorToken: env.GLANCE_OPERATOR_TOKEN }, null, 2) + '\n');
  console.log(`Operator token file: ${tokenPath}`);
  console.log(`Private native pairing file: ${pairingPath}`);
  console.log(`Provider mode: ${data.providerMode}; QM/GBrain readiness verified. Optional providers require their own live checks.`);
}
try {
  const checkFd = openSync(join(localDir, 'demo-typecheck.log'), 'w', 0o600); chmodSync(join(localDir, 'demo-typecheck.log'), 0o600);
  const check = spawnSync(node, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit'], { cwd: root, env, stdio: ['ignore', checkFd, checkFd], timeout: 60000 }); closeSync(checkFd);
  if (check.status !== 0) throw new Error('Backend typecheck failed; inspect .local/demo-typecheck.log before starting.');
  let tokenPath = join(localDir, 'operator-token');
  if (env.GLANCE_OPERATOR_TOKEN) { tokenPath = join(localDir, 'operator-token.launch'); if (env.GLANCE_OPERATOR_TOKEN.length < 32) throw new Error('Operator token must contain at least 32 characters.'); privateWrite(tokenPath, env.GLANCE_OPERATOR_TOKEN + '\n'); }
  else {
    const tokenCode = `import {loadOperatorToken} from './src/server/auth.ts'; await loadOperatorToken(process.env.GLANCE_LOCAL_DIR+'/operator-token');`;
    const created = spawnSync(node, ['--import', 'tsx', '--input-type=module', '-e', tokenCode], { cwd: root, env, stdio: 'pipe', timeout: 10000 });
    if (created.status !== 0) throw new Error('Could not load the private operator token.');
    env.GLANCE_OPERATOR_TOKEN = readFileSync(tokenPath, 'utf8').trim();
  }
  await checkProviders();
  const configHash = createHash('sha256').update(JSON.stringify(Object.entries(env).sort())).digest('hex');
  const previous = existsSync(stateFile) ? jsonFile(stateFile) : undefined;
  const current = await healthy();
  if (current) {
    const backend = previous?.processes?.find(item => item.name === 'backend');
    if (!backend || identity(backend.pid) !== backend.identity) throw new Error('Port is occupied by an unowned backend; refusing to replace or adopt it.');
    if (previous.configHash !== configHash) throw new Error('Demo configuration changed. Run stop-demo.mjs, then start-demo.mjs to load it.');
    await authCheck(); report(current, tokenPath, join(localDir, 'pairing.json'));
  } else {
    if (previous?.processes?.some(record => identity(record.pid) === record.identity)) throw new Error('An owned demo process is running but unhealthy. Stop it with stop-demo.mjs before restarting.');
    const probe = launch('backend', ['--import', 'tsx', join(root, 'src/server/index.ts')], { ...env, HOST: '127.0.0.1', GLANCE_LOCAL_DIR: join(localDir, 'launcher-auth-probe') });
    await waitBackend(probe); await authCheck();
    await terminate(probe); owned.splice(owned.indexOf(probe), 1); saveState();
    const backend = launch('backend', ['--import', 'tsx', join(root, 'src/server/index.ts')], env);
    await waitBackend(backend); await authCheck();
    const data = await healthy();
    if (data.providers?.qm !== 'configured' || data.providers?.gbrain !== 'configured' || data.providerMode === 'fixture') throw new Error('Backend did not load the live provider configuration.');
    let webReady = false;
    try { const r = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(2000) }); webReady = r.ok && (await r.text()).includes('/@vite/client'); } catch {}
    if (!webReady) {
      const webEnv = Object.fromEntries(Object.entries(env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME'].includes(key)));
      const web = launch('web', [join(root, 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.ts', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webEnv);
      for (let n = 0; n < 60; n++) { try { webReady = (await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(1000) })).ok; } catch {} if (webReady) break; if (identity(web.pid) !== web.identity) break; await delay(100); }
      if (!webReady) throw new Error('Web surface failed to become healthy; inspect its private log.');
    }
    saveState({ configHash, backendURL: loopback, startedAt: new Date().toISOString(), authVerified: true });
    report(data, tokenPath, join(localDir, 'pairing.json'));
  }
} catch (error) {
  for (const record of [...owned].reverse()) await terminate(record);
  if (owned.length) saveState({ failed: true });
  console.error(error instanceof Error ? error.message : 'Demo startup failed.');
  process.exitCode = 1;
}
