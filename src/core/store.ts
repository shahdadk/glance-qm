import { mkdir, open, readFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class NotFoundError extends Error {}

/** One atomic JSON snapshot per meeting. All read/modify/write operations are serialized. */
export class SnapshotStore<T extends { id: string }> {
  private tails = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string) {}

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new NotFoundError('Unknown meeting');
    return join(this.directory, `${id}.json`);
  }

  async read(id: string): Promise<T> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError('Unknown meeting');
      throw error;
    }
  }

  async readLocked<R>(id: string, accept: (value: T) => R): Promise<R> {
    return this.serial(id, async () => accept(await this.read(id)));
  }

  async list(): Promise<T[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    return Promise.all(names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => this.read(name.slice(0, -5))));
  }

  async create(value: T): Promise<T> {
    return this.serial(value.id, async () => {
      try { await this.read(value.id); throw new Error('Meeting already exists'); }
      catch (error) { if (!(error instanceof NotFoundError)) throw error; }
      await this.write(value);
      return structuredClone(value);
    });
  }

  async update<R>(id: string, mutate: (value: T) => R | Promise<R>): Promise<{ value: T; result: R }> {
    return this.serial(id, async () => {
      const value = await this.read(id);
      const result = await mutate(value);
      await this.write(value);
      return { value: structuredClone(value), result };
    });
  }

  private async serial<R>(id: string, operation: () => Promise<R>): Promise<R> {
    const prior = this.tails.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.tails.set(id, next);
    try { return await next; }
    finally { if (this.tails.get(id) === next) this.tails.delete(id); }
  }

  private async write(value: T): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(value.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
    // Flush the rename as well as the content before acknowledging accepted input.
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
