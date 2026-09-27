import { readFileSync, writeFileSync } from 'node:fs';
const token = readFileSync(new URL('../.local/operator-token', import.meta.url), 'utf8').trim();
const base = 'http://127.0.0.1:8790';
const checks = [];
const started = Date.now();
const record = (name, pass, details = {}) => { const check = { name, pass, elapsedMs: Date.now() - started, ...details }; checks.push(check); console.log(JSON.stringify(check)); };
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  return response.json();
}
const scenarios = [
  { label: 'Garry Tan / Y Combinator', text: "I'm Garry Tan, from Y Combinator.", identity: /garry\s+tan/i, organization: /y\s*combinator/i },
  { label: 'Satya Nadella / Microsoft', text: "I'm Satya Nadella, from Microsoft.", identity: /satya\s+nadella/i, organization: /microsoft/i },
];
async function probe(scenario, index) {
  const meeting = await api('/api/meetings', { title: `SYNTHETIC PROACTIVE INTRO QA ${scenario.label} ${new Date().toISOString()}` });
  record('synthetic spoken introduction submitted without request', true, { case: scenario.label, meetingId: meeting.id, source: 'synthetic API transcript; no hardware or face recognition' });
  await api(`/api/meetings/${meeting.id}/transcript`, { segmentId: `public-intro-qa-${index}`, revision: 1, isFinal: true, speaker: 'synthetic-qa', text: scenario.text });
  let snapshot;
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    snapshot = await api(`/api/meetings/${meeting.id}`);
    if (snapshot.externalEvidence?.length && snapshot.cue?.evidence?.some(evidence => evidence.kind === 'external')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const external = snapshot.externalEvidence || [];
  const receipt = snapshot.decisionReceipts?.find(item => item.kind === 'research');
  const supported = external.filter(evidence => scenario.identity.test(`${evidence.label} ${evidence.text}`) && scenario.organization.test(`${evidence.label} ${evidence.text}`));
  const cueSources = snapshot.cue?.evidence?.filter(evidence => evidence.kind === 'external') || [];
  const cue = snapshot.cue?.text || '';
  const sourceText = cueSources.map(evidence => evidence.text).join('\n');
  record('proactive Exa research authorized by native Jev', Boolean(receipt && external.length), { case: scenario.label, sourceCount: external.length, jevReceiptId: receipt?.receiptId, warningCodes: snapshot.warnings?.map(warning => warning.code) });
  record('retrieved sources support the supplied public identity context', supported.length > 0, { case: scenario.label, supportingSourceIds: supported.map(evidence => evidence.id), sourceURLs: supported.map(evidence => evidence.url).filter(Boolean) });
  record('useful cue cites retrieved external evidence', Boolean(cue && cueSources.length), { case: scenario.label, cue, evidenceIds: cueSources.map(evidence => evidence.id) });
  record('Stanford claim requires retrieved Stanford support', !/stanford/i.test(cue) || /stanford/i.test(sourceText), { case: scenario.label, stanfordMentioned: /stanford/i.test(cue) });
  record('no external action sent', !['sent', 'confirmed', 'sending'].includes(snapshot.deliveryAction?.status) && !['sent', 'confirmed'].includes(snapshot.calendarAction?.status), { case: scenario.label });
  await api(`/api/meetings/${meeting.id}/control`, { action: 'pause' });
}
try {
  const health = await api('/api/health');
  record('native Jev decision mode required', health.decisionMode === 'jev-native');
  if (health.decisionMode !== 'jev-native') throw new Error('Wrong decision mode');
  const results = await Promise.allSettled(scenarios.map(probe));
  for (const result of results) if (result.status === 'rejected') record('scenario completed', false, { error: result.reason?.message || 'Unknown error' });
} finally {
  const report = { verifiedAt: new Date().toISOString(), elapsedMs: Date.now() - started, passed: checks.filter(check => check.pass).length, total: checks.length, checks, limits: ['Spoken assertions are test input, not verified personal identity.', 'No face recognition or hardware success is established by these synthetic probes.', 'No email or calendar confirmation is invoked.'] };
  writeFileSync(new URL('../.local/public-introduction-verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, total: report.total, elapsedMs: report.elapsedMs }));
  if (checks.some(check => !check.pass)) process.exitCode = 1;
}
