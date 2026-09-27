import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createAmbientProviders } from '../src/integrations/ambient.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(homedir(), '.config/glance-qm');
const runtime = parseEnv(readFileSync(join(config, 'runtime.env'), 'utf8'));
const connection = JSON.parse(readFileSync(join(config, 'connection.json')));
const jev = parseEnv(readFileSync(join(config, 'jev.env'), 'utf8'));
const directory = join(root, '.local', `qm-role-qa-${Date.now()}`, 'meetings');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const env = { QM_BASE_URL: connection.baseUrl, QM_SOURCE_SECRET: runtime.CORE_SIGNING_SECRET, QM_PROJECT_ID: connection.projectId, QM_THREAD_REF: connection.threadRef, QM_ACTOR_EXTERNAL_ID: connection.principalIds[0], QM_MODEL: runtime.CODEX_MODEL, QM_HARNESS: 'codex', GLANCE_DECISION_MODE: 'jev-native', JEV_API_KEY: jev.JEV_API_KEY || jev.TYPESAFE_API_KEY, JEV_MODEL: jev.JEV_MODEL, GBRAIN_CONFIG_FILE: join(homedir(), '.local/share/glance-qm/gbrain-runtime/backend-oauth.json'), GBRAIN_RECALL_TOOL: 'search', GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page' };

const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.pathname === '/v1/turns') { const body = JSON.parse(init.body); requests.push({ threadRef: body.conversation.threadRef, role: body.text.startsWith('You are the meeting summary model') ? 'summary' : 'judgment' }); }
  return originalFetch(input, init);
};
const providers = createAmbientProviders(env);
const meetingId = `synthetic-role-isolation-${Date.now()}`;
const text = 'Synthetic QA: the team discussed two sketches and will compare them later. No task or external action is requested.';
const input = { anchor: { meetingId, revision: 1, correctionEpoch: 0, finalCount: 1, capturedAt: Date.now() }, meeting: { id: meetingId, title: 'SYNTHETIC QM role isolation', participants: [] }, recentTranscript: [{ id: 'role-qa', text, isFinal: true, revision: 1, capturedAt: new Date().toISOString() }], evidence: [{ id: 'transcript:role-qa:1', kind: 'transcript', label: 'Synthetic transcript', text }], operatorMessages: [] };
let report;
try {
  const summary = await providers.summarize(input, AbortSignal.timeout(45000));
  const judgment = await providers.judge(input, AbortSignal.timeout(45000));
  const distinctThreads = requests.length === 2 && requests[0].threadRef !== requests[1].threadRef;
  report = { verifiedAt: new Date().toISOString(), scope: 'Real QM summary followed by a real QM/Jev judgment for one synthetic meeting; no live room or external action.', summaryPresent: Boolean(summary.text), judgmentKind: judgment.kind, judgmentRunId: judgment.qmTrace?.runId, requests, distinctThreads, passed: Boolean(summary.text && judgment.qmTrace?.runId && distinctThreads) };
  if (!report.passed) process.exitCode = 1;
} catch (error) { report = { passed: false, error: error.message, requests }; process.exitCode = 1; }
finally { globalThis.fetch = originalFetch; writeFileSync(join(root, '.local/qm-role-isolation-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(report)); }
