import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { WebSocket } from 'ws';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, '.local', `speech-sequence-qa-${Date.now()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const config = join(homedir(), '.config/glance-qm');
const readEnv = name => parseEnv(readFileSync(join(config, name), 'utf8'));
const runtime = readEnv('runtime.env'); const connection = JSON.parse(readFileSync(join(config, 'connection.json')));
const token = readFileSync(join(root, '.local/operator-token'), 'utf8').trim();
const node = ['/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node'].find(existsSync) || process.execPath;
const port = Number(process.env.GLANCE_REPLAY_PORT || 8792);
if ([8790, 8787, 5174].includes(port)) throw new Error('Isolated test port must not be a live service port.');
const base = `http://127.0.0.1:${port}`;
const timingPath = join(directory, 'provider-timings.ndjson');
const env = { PATH: `${dirname(node)}:${process.env.PATH}`, HOME: homedir(), PORT: String(port), HOST: '127.0.0.1', GLANCE_LOCAL_DIR: directory, GLANCE_OPERATOR_TOKEN: token, GLANCE_DECISION_MODE: 'jev-native', GLANCE_INSTANT_CONTEXT: 'true', GLANCE_AMBIENT_DEBOUNCE_MS: '100', GLANCE_PROVIDER_TIMING_FILE: timingPath, GLANCE_PROVIDER_PUBLIC_CARD_TRACE: 'true', QM_BASE_URL: connection.baseUrl, QM_SOURCE_SECRET: runtime.CORE_SIGNING_SECRET, QM_PROJECT_ID: connection.projectId, QM_THREAD_REF: connection.threadRef, QM_ACTOR_EXTERNAL_ID: connection.principalIds[0], QM_MODEL: runtime.CODEX_MODEL, QM_HARNESS: 'codex', QM_JUDGE_MODEL: 'gpt-6-luna', QM_JUDGE_THINKING_LEVEL: 'low', QM_JUDGE_FAST_MODE: 'true', GBRAIN_CONFIG_FILE: join(homedir(), '.local/share/glance-qm/gbrain-runtime/backend-oauth.json'), GBRAIN_RECALL_TOOL: 'search', GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page' };
for (const file of ['jev.env', 'exa.env']) for (const [key, value] of Object.entries(readEnv(file))) if (['JEV_API_KEY', 'TYPESAFE_API_KEY', 'JEV_MODEL', 'EXA_API_KEY'].includes(key)) env[key] = value;
const inputPath = process.env.GLANCE_REPLAY_INPUT;
if (!inputPath) throw new Error('GLANCE_REPLAY_INPUT must select a private JSON array of captured final segments.');
const segments = JSON.parse(readFileSync(inputPath, 'utf8'));
if (!Array.isArray(segments) || !segments.length || segments.length > 20 || segments.some(segment => typeof segment.text !== 'string' || !Number.isFinite(Date.parse(segment.capturedAt)))) throw new Error('Replay needs 1–20 timestamped text segments.');
const fd = openSync(join(directory, 'backend.log'), 'a', 0o600);
const child = spawn(node, ['--import', join(root, 'scripts/observe-provider-timing.mjs'), '--import', 'tsx', join(root, 'src/server/index.ts')], { cwd: root, env, stdio: ['ignore', fd, fd] }); closeSync(fd);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = () => existsSync(timingPath) ? readFileSync(timingPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function api(path, body) { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error(`Isolated API returned ${response.status}`); return response.json(); }

let ws; let meeting; let report;
const cues = []; const accepted = [];
try {
  let ready = false;
  for (let n = 0; n < 100; n++) { try { ready = (await api('/api/health')).decisionMode === 'jev-native'; } catch {} if (ready) break; if (child.exitCode !== null) throw new Error('Isolated backend exited'); await wait(50); }
  if (!ready) throw new Error('Isolated backend did not become ready');
  meeting = await api('/api/meetings', { title: 'PRIVATE captured speech sequence replay — isolated verification' });
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/meetings/${meeting.id}/events`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', raw => { const event = JSON.parse(raw.toString()); const cue = event.type === 'snapshot' && event.payload?.cue; if (cue && !cues.some(previous => previous.id === cue.id)) cues.push({ ...cue, observedAt: Date.now() }); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const start = Date.now(); const originalStart = Date.parse(segments[0].capturedAt);
  for (const [index, segment] of segments.entries()) {
    const offset = Date.parse(segment.capturedAt) - originalStart;
    if (offset < 0 || offset > 90000) throw new Error('Sequence must be ordered and span at most 90 seconds');
    const delay = start + offset - Date.now(); if (delay > 0) await wait(delay);
    const snapshot = await api(`/api/meetings/${meeting.id}/transcript`, { segmentId: `replay-${index}`, revision: 1, isFinal: true, text: segment.text, speaker: 'isolated-captured-replay' });
    accepted.push({ index, at: Date.parse(snapshot.transcript.find(item => item.id === `replay-${index}`).capturedAt) });
  }
  await wait(10000);
  const latest = await api(`/api/meetings/${meeting.id}`);
  report = { verifiedAt: new Date().toISOString(), scope: 'Isolated HTTP/WebSocket replay of privately captured final ASR segments at original arrival spacing. No main-room writes or claim of new physical Display delivery.', meetingId: meeting.id, segmentCount: segments.length, accepted, cues: cues.map(cue => ({ text: cue.text, observedAt: cue.observedAt, sourceURLs: cue.evidence?.filter(item => item.kind === 'external').map(item => item.url), evidenceIds: cue.evidence?.map(item => item.id) })), receiptKinds: latest.decisionReceipts?.map(receipt => receipt.kind), warningCodes: latest.warnings?.map(warning => warning.code), stages: events(), passed: cues.some(cue => cue.evidence?.some(item => item.kind === 'external')) };
  await api(`/api/meetings/${meeting.id}/control`, { action: 'pause' });
  if (!report.passed) process.exitCode = 1;
} catch (error) { report = { passed: false, error: error.message, segmentCount: segments.length }; process.exitCode = 1; }
finally {
  ws?.close(); if (child.exitCode === null) child.kill('SIGTERM');
  writeFileSync(join(root, '.local/actual-sequence-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
