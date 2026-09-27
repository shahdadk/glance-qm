import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { MeetingController } from '../src/core/controller.ts';
import { createAmbientProviders } from '../src/integrations/ambient.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(homedir(), '.config/glance-qm');
const runtime = parseEnv(readFileSync(join(config, 'runtime.env'), 'utf8'));
const connection = JSON.parse(readFileSync(join(config, 'connection.json')));
const jev = parseEnv(readFileSync(join(config, 'jev.env'), 'utf8'));
const directory = join(root, '.local', `memory-checkpoint-qa-${Date.now()}`, 'meetings');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const env = { QM_BASE_URL: connection.baseUrl, QM_SOURCE_SECRET: runtime.CORE_SIGNING_SECRET, QM_PROJECT_ID: connection.projectId, QM_THREAD_REF: connection.threadRef, QM_ACTOR_EXTERNAL_ID: connection.principalIds[0], QM_MODEL: runtime.CODEX_MODEL, QM_HARNESS: 'codex', GLANCE_DECISION_MODE: 'jev-native', JEV_API_KEY: jev.JEV_API_KEY || jev.TYPESAFE_API_KEY, JEV_MODEL: jev.JEV_MODEL, GBRAIN_CONFIG_FILE: join(homedir(), '.local/share/glance-qm/gbrain-runtime/backend-oauth.json'), GBRAIN_RECALL_TOOL: 'search', GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page' };
const controller = new MeetingController({ directory, providers: createAmbientProviders(env), summaryIntervalMs: 500, debounceMs: 60000, maxWaitMs: 60000 });
const started = Date.now();
let report;
try {
  const meeting = await controller.create({ title: `SYNTHETIC rolling-memory checkpoint ${new Date().toISOString()}` });
  await controller.append(meeting.id, { segmentId: 'synthetic-live-memory-1', revision: 1, isFinal: true, speaker: 'synthetic-qa', text: 'Synthetic checkpoint: the team agreed the prototype will work locally. The next discussion will compare two interface sketches. No messages, invitations, or external delivery are requested.' });
  let snapshot;
  const until = Date.now() + 35000;
  while (Date.now() < until) { snapshot = await controller.get(meeting.id); if (['saved', 'failed'].includes(snapshot.memoryCheckpoint?.state)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const checkpoint = snapshot.memoryCheckpoint;
  const sameContext = snapshot.summaryContextDigest === checkpoint?.contextDigest;
  report = { verifiedAt: new Date().toISOString(), scope: 'Synthetic isolated live QM summary and GBrain save/readback; no End call and no physical-speech claim.', meetingId: meeting.id, elapsedMs: Date.now() - started, passed: snapshot.status === 'listening' && snapshot.finalization.state === 'not_started' && checkpoint?.state === 'saved' && Boolean(checkpoint.receipt?.id) && sameContext, meetingStatus: snapshot.status, finalizationState: snapshot.finalization.state, checkpointState: checkpoint?.state, receiptId: checkpoint?.receipt?.id, savedAt: checkpoint?.savedAt, sameContext, summaryPresent: Boolean(snapshot.summary), warningCodes: snapshot.warnings.map(warning => warning.code), error: checkpoint?.error };
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} finally {
  await controller.close();
  if (report) writeFileSync(join(root, '.local/live-memory-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
