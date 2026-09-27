// Explicit live synthetic QA: writes a synthetic meeting, summary and document.
// Never confirms a calendar action. Never emits tokens or provider content.
import { readFile, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:8790';
const token = (await readFile(new URL('../.local/operator-token', import.meta.url), 'utf8')).trim();
const started = Date.now();
const checks = [];
const receipts = [];
const record = (name, pass, detail = {}) => { checks.push({ name, pass, elapsedMs: Date.now() - started, ...detail }); console.log(JSON.stringify(checks.at(-1))); };
async function api(path, body, authenticated = true) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json() };
}
async function poll(id, predicate, ms = 60000) {
  const until = Date.now() + ms;
  let value;
  while (Date.now() < until) {
    value = (await api(`/api/meetings/${id}`)).data;
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return value;
}
let meeting;
try {
  const health = await api('/api/health');
  record('live provider configuration', health.data.providerMode === 'live' && health.data.providers.qm === 'configured' && health.data.providers.gbrain === 'configured', { providers: health.data.providers });
  const denied = await api('/api/meetings', { title: 'Denied QA' }, false);
  record('missing authentication rejected', denied.status === 401);
  const created = await api('/api/meetings', { title: `SYNTHETIC QA launch rehearsal ${new Date().toISOString()}`, participantNames: ['Synthetic observer'] });
  if (created.status !== 201) throw new Error('meeting_create_failed');
  meeting = created.data.id;
  record('meeting created', true, { meetingId: meeting });
  record('single operator boundary disclosed', created.data.participants.length === 1 && created.data.warnings.some(w => w.code === 'single_operator'));
  const impersonation = await api(`/api/meetings/${meeting}/messages`, { participantId: 'synthetic-observer', text: 'Synthetic input' });
  record('participant impersonation rejected', impersonation.status === 403);
  const append = async (segmentId, text, revision = 1, isFinal = true) => {
    const result = await api(`/api/meetings/${meeting}/transcript`, { segmentId, text, revision, isFinal, speaker: 'operator' });
    if (result.status !== 200) throw new Error('transcript_rejected');
    return result;
  };
  await append('budget', 'Synthetic launch budget is 200. What did we decide in previous meetings about this synthetic launch?', 1, false);
  await append('budget', 'Synthetic launch budget is 200. What did we decide in previous meetings about this synthetic launch?');
  let value = await poll(meeting, v => !!v.memoryQuery || !!v.cue || v.warnings.some(w => w.code === 'ambient_unavailable'), 30000);
  record('ambient judgment completed', !!value.memoryQuery || !!value.cue, { recalled: !!value.memoryQuery, memoryEvidenceCount: value.memoryEvidence.length, cuePresent: !!value.cue, warningCodes: value.warnings.map(w => w.code) });
  if (value.memoryQuery) record('GBrain recall returned', true, { evidenceCount: value.memoryEvidence.length });
  const corrected = await append('budget', 'Correction: the synthetic launch budget is 300. Previous 200 is wrong.', 2);
  record('correction increments epoch with cue cleared', corrected.data.correctionEpoch === 1 && !corrected.data.cue);
  await append('calculation', 'For this synthetic launch, we have 12 units at 25 each. What is the total? Please show the arithmetic result as a short grounded cue.');
  value = await poll(meeting, v => !!v.cue, 30000);
  record('grounded cue visible', !!value.cue && value.cue.evidence.length > 0, { evidenceCount: value.cue?.evidence.length ?? 0 });
  await append('calendar-preview', 'Please prepare, but do not send, a synthetic QA review invitation for qa@example.com on 2026-10-20 from 10:00 to 10:30 America/Los_Angeles, UTC offset -07:00. Title: Synthetic QA review. Description: Review the synthetic launch brief. I will review the preview separately.');
  value = await poll(meeting, v => !!v.calendarAction, 30000);
  record('calendar preview prepared without sending', value.calendarAction?.status === 'proposed', { status: value.calendarAction?.status ?? 'not-proposed' });
  const negative = await api(`/api/meetings/${meeting}/actions/synthetic-unconfirmed/confirm`, { proposalVersion: 1 }, false);
  record('calendar confirmation without authentication rejected', negative.status === 401);
  await append('assignment', 'New topic: please prepare a concise synthetic launch brief for me, the operator, using the corrected budget of 300. This is an explicit document assignment. Do not send invitations or messages.');
  await api(`/api/meetings/${meeting}/end`, {});
  value = await poll(meeting, v => ['completed', 'failed'].includes(v.finalization.state) && v.tasks.length > 0 && v.tasks.every(t => !['queued', 'running'].includes(t.status)), 60000);
  record('end summary persisted', value.finalization.state === 'completed', { state: value.finalization.state, summaryPresent: !!value.summary, ...(value.finalization.state === 'failed' ? { failure: 'Provider summary persistence failed; inspect server state locally.' } : {}) });
  record('document completed', value.tasks.some(t => t.status === 'completed'), { taskStatuses: value.tasks.map(t => t.status) });
  record('calendar not sent', !['sent', 'confirmed'].includes(value.calendarAction?.status), { status: value.calendarAction?.status ?? 'not-proposed' });
  if (value.finalization.receipt?.id) receipts.push({ provider: 'GBrain', id: value.finalization.receipt.id });
  for (const origin of Object.values(value.taskOrigins)) if (origin.receipt?.id) receipts.push({ provider: 'QM document', id: origin.receipt.id });
  for (const receipt of value.decisionReceipts ?? []) receipts.push({ provider: 'decision', id: receipt.receiptId });
} catch (error) {
  record('driver completed', false, { error: error?.name ?? 'Error' });
} finally {
  const report = { verifiedAt: new Date().toISOString(), mode: 'live synthetic QA', meetingId: meeting, elapsedMs: Date.now() - started, passed: checks.filter(c => c.pass).length, total: checks.length, checks, receipts, limits: ['Local app authenticates one operator; no two-principal app verification.', 'No Meta hardware verification.', 'No calendar invite sent or authenticated confirmation attempted.', 'Recall may return no memory; no private source content included.'] };
  await writeFile(new URL('../docs/VERIFICATION.md', import.meta.url), '# Live verification receipt\n\nRun `node scripts/verify-live.mjs` against an already running configured backend. This creates synthetic QA provider data.\n\n```json\n' + JSON.stringify(report, null, 2) + '\n```\n');
  console.log(JSON.stringify({ passed: report.passed, total: report.total, elapsedMs: report.elapsedMs }));
  if (checks.some(c => !c.pass)) process.exitCode = 1;
}
