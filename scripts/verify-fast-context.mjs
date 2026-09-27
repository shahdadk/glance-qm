import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { WebSocket } from 'ws';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, '.local', `fast-context-qa-${Date.now()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const config = join(homedir(), '.config/glance-qm');
const readEnv = name => parseEnv(readFileSync(join(config, name), 'utf8'));
const runtime = readEnv('runtime.env'); const connection = JSON.parse(readFileSync(join(config, 'connection.json')));
const token = readFileSync(join(root, '.local/operator-token'), 'utf8').trim();
const node = ['/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node'].find(existsSync) || process.execPath;
const port = Number(process.env.GLANCE_FAST_TEST_PORT || 8792);
if ([8790, 8787, 5174].includes(port)) throw new Error('Isolated test port must not be a live service port.');
const base = `http://127.0.0.1:${port}`;
const timingPath = join(directory, 'provider-timings.ndjson');
const env = { PATH: `${dirname(node)}:${process.env.PATH}`, HOME: homedir(), PORT: String(port), HOST: '127.0.0.1', GLANCE_LOCAL_DIR: directory, GLANCE_OPERATOR_TOKEN: token, GLANCE_DECISION_MODE: 'jev-native', GLANCE_INSTANT_CONTEXT: 'true', GLANCE_AMBIENT_DEBOUNCE_MS: '100', GLANCE_PROVIDER_TIMING_FILE: timingPath, QM_BASE_URL: connection.baseUrl, QM_SOURCE_SECRET: runtime.CORE_SIGNING_SECRET, QM_PROJECT_ID: connection.projectId, QM_THREAD_REF: connection.threadRef, QM_ACTOR_EXTERNAL_ID: connection.principalIds[0], QM_MODEL: runtime.CODEX_MODEL, QM_HARNESS: 'codex', QM_JUDGE_MODEL: 'gpt-6-luna', QM_JUDGE_THINKING_LEVEL: 'low', QM_JUDGE_FAST_MODE: 'true', GBRAIN_CONFIG_FILE: join(homedir(), '.local/share/glance-qm/gbrain-runtime/backend-oauth.json'), GBRAIN_RECALL_TOOL: 'search', GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page' };
for (const file of ['jev.env', 'exa.env']) for (const [key, value] of Object.entries(readEnv(file))) if (['JEV_API_KEY', 'TYPESAFE_API_KEY', 'JEV_MODEL', 'EXA_API_KEY'].includes(key)) env[key] = value;
const fd = openSync(join(directory, 'backend.log'), 'a', 0o600);
const child = spawn(node, ['--import', join(root, 'scripts/observe-provider-timing.mjs'), '--import', 'tsx', join(root, 'src/server/index.ts')], { cwd: root, env, stdio: ['ignore', fd, fd] }); closeSync(fd);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = () => existsSync(timingPath) ? readFileSync(timingPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const cases = [];
const asr = process.argv.includes('--asr');
const isHeld = choice => choice.choice === '__hold__' || choice.confidence < 0.8 || choice.chosenProbability < 0.8;
async function api(path, body) { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error(`Isolated API returned ${response.status}`); return response.json(); }
async function runCase(prefetch, negative = false) {
  const label = negative ? 'ambiguous-name' : asr ? 'asr-corrected-name' : prefetch ? 'prefetched' : 'cold';
  const meeting = await api('/api/meetings', { title: `SYNTHETIC isolated fast-context ${label}` });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/meetings/${meeting.id}/events`);
  let cueAt; let latest;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', raw => { const event = JSON.parse(raw.toString()); if (event.type === 'snapshot' && event.payload?.cue && !cueAt) cueAt = Date.now(); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const startIndex = events().length;
  const segmentId = `fast-${label}`;
  const text = negative ? "I'm John Smith." : asr ? "I’m Gary Tatten. I’m Gary Tan." : "I'm Garry Tan.";
  let partialAt;
  if (prefetch) {
    partialAt = Date.now();
    await api(`/api/meetings/${meeting.id}/transcript`, { segmentId, revision: 1, isFinal: false, text, speaker: 'synthetic-qa' });
    const until = Date.now() + 5000;
    while (Date.now() < until && !events().slice(startIndex).some(event => event.provider === 'exa' && event.event === 'complete')) await wait(20);
    await wait(75);
  }
  const submittedAt = Date.now();
  const accepted = await api(`/api/meetings/${meeting.id}/transcript`, { segmentId, revision: prefetch ? 2 : 1, isFinal: true, text, speaker: 'synthetic-qa' });
  const receivedAt = Date.parse(accepted.transcript.find(segment => segment.id === segmentId).capturedAt);
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    latest = await api(`/api/meetings/${meeting.id}`);
    if (latest.cue && latest.decisionReceipts?.some(receipt => receipt.kind === 'cue')) break;
    if (negative && events().slice(startIndex).some(event => event.event === 'complete' && event.choices?.some(isHeld))) { await wait(150); latest = await api(`/api/meetings/${meeting.id}`); break; }
    await wait(30);
  }
  if (latest.cue && !cueAt) await wait(100);
  const stageEvents = events().slice(startIndex);
  const complete = (phase, afterFinal = false) => stageEvents.find(event => event.phase === phase && event.event === 'complete' && (!afterFinal || event.at >= receivedAt))?.at;
  const started = phase => stageEvents.find(event => event.phase === phase && event.event === 'start')?.at;
  const cueReceipt = latest.decisionReceipts?.find(receipt => receipt.kind === 'cue');
  const external = latest.cue?.evidence?.filter(evidence => evidence.kind === 'external') || [];
  const result = { label, meetingId: meeting.id, passed: negative ? !latest.cue && stageEvents.some(event => event.choices?.some(isHeld)) : Boolean(cueAt && latest.cue && external.length && cueReceipt && stageEvents.some(event => event.provider === 'exa' && event.status === 200) && !stageEvents.some(event => event.provider === 'qm')), submittedAt, finalReceivedAt: receivedAt, partialLeadMs: partialAt ? receivedAt - partialAt : undefined, jevLookupStartedAt: started('jev_lookup'), jevLookupCompleteAt: complete('jev_lookup'), exaCompleteAt: complete('exa'), jevCueCompleteAt: complete('jev_cue_authorize', true), cueReceiptAt: cueReceipt?.receipt?.issuedAt, snapshotObservedAt: cueAt, finalToSnapshotMs: cueAt ? cueAt - receivedAt : undefined, cue: latest.cue?.text, sourceURLs: external.map(evidence => evidence.url), finalCueReceiptId: cueReceipt?.receiptId, acceptedResearchReceipts: latest.decisionReceipts?.filter(receipt => receipt.kind === 'research').length || 0, qmCalls: stageEvents.filter(event => event.provider === 'qm' && event.event === 'start').length, stages: stageEvents };
  cases.push(result); console.log(JSON.stringify(result));
  ws.close(); await api(`/api/meetings/${meeting.id}/control`, { action: 'pause' });
}
try {
  let ready = false;
  for (let n = 0; n < 100; n++) { try { ready = (await api('/api/health')).decisionMode === 'jev-native'; } catch {} if (ready) break; if (child.exitCode !== null) throw new Error('Isolated backend exited'); await wait(50); }
  if (!ready) throw new Error('Isolated backend did not become ready');
  await runCase(false); if (asr) await runCase(false, true); else await runCase(true);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  const report = { verifiedAt: new Date().toISOString(), isolatedPort: port, cases, scope: 'Synthetic isolated API/WS probes. No main-room input, delivery, or physical speech claim.' };
  writeFileSync(join(root, asr ? '.local/fast-context-asr-verification.json' : '.local/fast-context-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (cases.length !== 2 || cases.some(result => !result.passed)) process.exitCode = 1;
}
