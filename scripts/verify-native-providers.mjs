import { readFileSync, writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:8790';
const token = readFileSync(new URL('../.local/operator-token', import.meta.url), 'utf8').trim();
const researchOnly = process.argv.includes('--research-only');
const started = Date.now();
const checks = [];
const record = (name, pass, details = {}) => { const item = { name, pass, elapsedMs: Date.now() - started, ...details }; checks.push(item); console.log(JSON.stringify(item)); };
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`App request failed (${response.status})`);
  return response.json();
}
async function wait(id, predicate, timeout = 90000) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) { value = await api(`/api/meetings/${id}`); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 500)); }
  return value;
}
async function append(id, segmentId, text) { return api(`/api/meetings/${id}/transcript`, { segmentId, revision: 1, isFinal: true, text, speaker: 'synthetic-qa' }); }
async function research() {
  const meeting = await api('/api/meetings', { title: `SYNTHETIC PROVIDER QA public research ${new Date().toISOString()}` });
  record('research meeting created', true, { meetingId: meeting.id, source: 'synthetic API input; not hardware' });
  await append(meeting.id, 'provider-qa-public-research', 'Please look up the current official Node.js LTS release information and give one short useful grounded cue with a public source. Use public web research because this is a current fact, not a memory question.');
  const value = await wait(meeting.id, value => value.externalEvidence?.length > 0 && value.cue?.evidence?.some(item => item.kind === 'external'), 55000);
  const receipt = value.decisionReceipts?.find(item => item.kind === 'research');
  record('real Exa research selected by Jev', Boolean(receipt && value.externalEvidence?.length), { meetingId: meeting.id, sourceCount: value.externalEvidence?.length ?? 0, receiptId: receipt?.receiptId, warningCodes: value.warnings?.map(item => item.code) });
  record('research cue grounded in external sources', Boolean(value.cue?.evidence?.some(item => item.kind === 'external')), { externalCueSources: value.cue?.evidence?.filter(item => item.kind === 'external').map(item => item.id) ?? [] });
  await api(`/api/meetings/${meeting.id}/control`, { action: 'pause' });
}
async function prd() {
  const meeting = await api('/api/meetings', { title: `SYNTHETIC PROVIDER QA immediate PRD ${new Date().toISOString()}` });
  record('PRD meeting created', true, { meetingId: meeting.id, source: 'synthetic API input; not hardware' });
  await append(meeting.id, 'provider-qa-prd-need', 'We need a concise product requirements document for our local restaurant reservation companion now, while we keep discussing. The host should manage reservations, detect duplicate bookings, and see a daily seating list. A PRD draft for us to review should include goals, user stories, acceptance criteria, and an initial milestone. There is no need to wait until the conversation ends. Do not send it to anyone.');
  let value = await wait(meeting.id, value => value.tasks?.some(task => ['running', 'completed', 'review_required', 'failed'].includes(task.status)), 45000);
  let task = value.tasks?.find(task => ['running', 'completed', 'review_required', 'failed'].includes(task.status));
  record('PRD work starts while listening without End', Boolean(task && value.status === 'listening' && task.status !== 'failed'), { meetingId: meeting.id, taskId: task?.id, status: task?.status, meetingStatus: value.status, decisionReceiptId: value.decisionReceipts?.find(item => item.kind === 'task')?.receiptId });
  if (task) {
    await append(meeting.id, 'provider-qa-prd-evolution', 'One additional requirement for that same draft: include keyboard-only navigation and a short accessibility checklist. We will review the draft after this discussion; do not share or send anything.');
    value = await wait(meeting.id, value => value.tasks?.some(item => item.id === task.id && ['completed', 'review_required', 'failed'].includes(item.status)), 100000);
    task = value.tasks.find(item => item.id === task.id);
  }
  record('actual QM document retained for current-context review', Boolean(task && ['completed', 'review_required'].includes(task.status) && (task.content || task.url) && value.taskOrigins?.[task.id]?.receipt?.id), { taskId: task?.id, status: task?.status, contentCharacters: task?.content?.length ?? 0, qmReceiptId: task && value.taskOrigins?.[task.id]?.receipt?.id });
  record('changed context requires artifact review', task?.status === 'review_required');
  record('no external delivery or calendar send', !['sent', 'confirmed', 'sending'].includes(value.deliveryAction?.status) && !['sent', 'confirmed'].includes(value.calendarAction?.status));
  await api(`/api/meetings/${meeting.id}/control`, { action: 'pause' });
}
try {
  const health = await api('/api/health');
  record('mandatory native Jev decision mode', health.decisionMode === 'jev-native' && health.providerMode === 'live', { decisionMode: health.decisionMode });
  if (health.decisionMode !== 'jev-native') throw new Error('Native Jev mode is not active');
  const results = await Promise.allSettled(researchOnly ? [research()] : [research(), prd()]);
  for (const result of results) if (result.status === 'rejected') record('scenario finished', false, { error: result.reason?.message || 'Scenario failed' });
} finally {
  const report = { verifiedAt: new Date().toISOString(), elapsedMs: Date.now() - started, passed: checks.filter(item => item.pass).length, total: checks.length, checks, scope: 'Synthetic API verification only; not a Meta hardware receipt. No email or invitation confirmation is called.' };
  writeFileSync(new URL(researchOnly ? '../.local/native-provider-research-verification.json' : '../.local/native-provider-verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, total: report.total, elapsedMs: report.elapsedMs }));
  if (checks.some(item => !item.pass)) process.exitCode = 1;
}
