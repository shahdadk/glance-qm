import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAmbientProviders } from '../src/integrations/ambient.ts';
import { GBrainClient, toolResultData } from '../src/integrations/gbrain.ts';
const configPath = join(homedir(), '.local/share/glance-qm/gbrain-runtime/backend-oauth.json');
const providers = createAmbientProviders({ GBRAIN_CONFIG_FILE: configPath, GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page' });
const reader = new GBrainClient(JSON.parse(readFileSync(configPath, 'utf8')));
const meetingId = `synthetic-repeat-memory-${randomUUID()}`;
const slug = `chan-glance-demo/meetings/${meetingId}`;
const signal = AbortSignal.timeout(30000);
const checkpoints = [];
let report;
try {
  for (const revision of [1, 2]) {
    const marker = `Synthetic repeat memory checkpoint ${revision}`;
    const receipt = await providers.saveSummary({ meetingId, title: 'SYNTHETIC repeat GBrain checkpoint QA', transcript: [{ id: `synthetic-segment-${revision}`, revision: 1, text: marker, isFinal: true, capturedAt: new Date().toISOString() }], summary: { text: marker, decisions: [], openQuestions: [], owners: [], nextSteps: [], revision, createdAt: new Date().toISOString() } }, signal);
    const page = toolResultData(await reader.callTool('get_page', { slug, source_id: 'glance-demo', include_content: true }, signal));
    const matched = page.content?.includes(marker) || page.compiled_truth?.includes(marker);
    if (!matched || !page.revision) throw new Error('Independent checkpoint readback failed');
    checkpoints.push({ sequence: revision, receiptId: receipt.id, pageRevision: page.revision, readbackMatched: Boolean(matched) });
  }
  report = { verifiedAt: new Date().toISOString(), scope: 'Two actual provider saveSummary calls to one new synthetic QA page, each independently read back; no real room, QM action, or message touched.', meetingId, slug, passed: checkpoints.length === 2 && checkpoints[0].pageRevision !== checkpoints[1].pageRevision, checkpoints };
} catch (error) {
  report = { verifiedAt: new Date().toISOString(), passed: false, meetingId, checkpoints, errorCode: error.code || error.name, error: error.message };
  process.exitCode = 1;
}
mkdirSync(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 });
writeFileSync(new URL('../.local/live-gbrain-repeat-write.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report));
