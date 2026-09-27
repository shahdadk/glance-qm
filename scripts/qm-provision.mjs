import { mkdirSync, writeFileSync } from 'node:fs';
import { request, runtimeConfig } from '../integrations/qm/source-client.mjs';

const config = runtimeConfig();
const participants = [
  { principalId: 'glance-founder', displayName: 'Shahdad', type: 'internal' },
  { principalId: 'glance-teammate', displayName: 'Teammate', type: 'internal' },
];
await request('POST', '/v1/directory', { members: participants });
const existing = await (await request('GET', '/v1/projects?principalId=glance-founder')).json();
let project = existing.projects.find(project => project.name === 'Glance Shared Meeting');
if (!project) ({ project } = await (await request('POST', '/v1/projects', { principalId: 'glance-founder', name: 'Glance Shared Meeting' })).json());
if (!project.members?.some(member => member.principalId === 'glance-teammate')) {
  ({ project } = await (await request('POST', `/v1/projects/${project.id}/members`, { principalId: 'glance-founder', memberId: 'glance-teammate' })).json());
}
const metadata = { qmCommit: 'a5a36675041a85e30b9ff3632f678ba36837aabf', baseUrl: config.baseUrl, secretEnvFile: config.envFile, principalIds: participants.map(member => member.principalId), projectId: project.id, scopeId: project.scopeId, channelRef: `web-project-${project.id}`, threadRef: `web:glance-founder:meeting:${project.id}` };
const stateDir = `${process.env.HOME}/.config/glance-qm`;
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
writeFileSync(`${stateDir}/connection.json`, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(metadata, null, 2));
