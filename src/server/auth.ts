import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Local installation has exactly one operator; display names never grant membership. */
export async function loadOperatorToken(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, 'wx', 0o600);
    const token = randomBytes(32).toString('base64url');
    try { await handle.writeFile(token + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await chmod(path, 0o600);
    const token = (await readFile(path, 'utf8')).trim();
    if (token.length < 32) throw new Error('Local operator token is invalid');
    return token;
  }
}

export function validToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
