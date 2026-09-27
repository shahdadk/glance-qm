import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Metadata only: never print credential contents or test an external write.
const base = join(homedir(), '.config', 'glance-qm');
const files = ['connection.json', 'runtime.env', 'memorable.env', 'google.env', 'google-client.json'];
const results = await Promise.all(files.map(async (name) => {
  try {
    const path = join(base, name);
    const metadata = await stat(path);
    const result = { file: name, present: true, private: (metadata.mode & 0o077) === 0 };
    if (name.endsWith('.env')) {
      const content = await readFile(path, 'utf8');
      result.keys = [...content.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]);
    }
    return result;
  } catch (error) {
    if (error.code === 'ENOENT') return { file: name, present: false };
    return { file: name, present: null, error: 'Could not inspect file metadata' };
  }
}));
console.log(JSON.stringify({ directory: base, files: results, note: 'Presence is not authentication or live verification.' }, null, 2));
