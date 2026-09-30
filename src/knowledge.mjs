import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, rename, unlink, mkdir, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_KNOWLEDGE_PATH = join(PROJECT_ROOT, 'knowledge/game-system.md');
export const DEFAULT_FEEDBACK_DIR = join(PROJECT_ROOT, 'data/feedback/raw');
export const SOURCE_START = '<!-- BEGIN_SOURCE_GAME_3_3 -->';
export const SOURCE_END = '<!-- END_SOURCE_GAME_3_3 -->';

const queues = new Map();
export class KnowledgeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function validateSource(text) {
  if (text.split(SOURCE_START).length !== 2 || text.split(SOURCE_END).length !== 2 ||
      text.indexOf(SOURCE_START) >= text.indexOf(SOURCE_END)) {
    throw new KnowledgeError('KNOWLEDGE_SOURCE_MARKERS_INVALID');
  }
}

async function serialized(path, operation) {
  const previous = queues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(path, current);
  try { return await current; }
  finally { if (queues.get(path) === current) queues.delete(path); }
}

async function acquireWriterLock(lockPath) {
  const deadline = Date.now() + 2_000;
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), id: randomUUID() }));
      return handle;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
      if (error.code !== 'EEXIST') throw new KnowledgeError('KNOWLEDGE_APPEND_FAILED');
      if (Date.now() >= deadline) throw new KnowledgeError('KNOWLEDGE_WRITE_BUSY');
      // A crashed writer leaves a lock for explicit owner recovery; never delete it automatically.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Paths are selected by the process owner at startup, never by tool arguments. */
export function createKnowledgeStore({ knowledgePath = DEFAULT_KNOWLEDGE_PATH } = {}) {
  const path = resolve(knowledgePath);
  async function read() {
    try {
      const bytes = await readFile(path);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      validateSource(text);
      return { text, hash: hash(bytes), bytes: bytes.length };
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('KNOWLEDGE_READ_FAILED');
    }
  }

  async function append({ content, expectedHash }) {
    if (typeof content !== 'string' || !content.trim() || content.length > 32_000 ||
        content.includes(SOURCE_START) || content.includes(SOURCE_END) ||
        typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new KnowledgeError('KNOWLEDGE_APPEND_INVALID');
    }
    return serialized(path, async () => {
      // O_EXCL protects simultaneous owner stdio processes, in addition to the in-process queue.
      const lockPath = `${path}.lock`;
      const lock = await acquireWriterLock(lockPath);
      const temporary = join(dirname(path), `.knowledge-${randomUUID()}.tmp`);
      try {
        const current = await read();
        if (current.hash !== expectedHash) throw new KnowledgeError('KNOWLEDGE_VERSION_CONFLICT');
        const addition = `\n\n## Owner reviewed supplement (${new Date().toISOString()})\n\n${content.trim()}\n`;
        const updated = Buffer.concat([Buffer.from(current.text, 'utf8'), Buffer.from(addition, 'utf8')]);
        const metadata = await stat(path);
        await writeFile(temporary, updated, { flag: 'wx', mode: metadata.mode & 0o777 });
        await rename(temporary, path);
        return { hash: hash(updated), bytes: updated.length, appended: true };
      } catch (error) {
        if (error instanceof KnowledgeError) throw error;
        throw new KnowledgeError('KNOWLEDGE_APPEND_FAILED');
      } finally {
        await unlink(temporary).catch(() => {});
        await lock.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    });
  }
  return { read, append };
}

/** Raw observations stay outside canonical knowledge and never enter model context automatically. */
export async function saveFeedback(feedback, { feedbackDir = DEFAULT_FEEDBACK_DIR, sourceMode = 'owner' } = {}) {
  if (!['owner', 'restricted'].includes(sourceMode)) throw new KnowledgeError('FEEDBACK_SAVE_FAILED');
  const id = randomUUID();
  const directory = resolve(feedbackDir);
  const record = { id, createdAt: new Date().toISOString(), stage: 'raw_untrusted', sourceMode, feedback };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { id, stage: record.stage, validation: 'not_cleaned' };
  } catch {
    throw new KnowledgeError('FEEDBACK_SAVE_FAILED');
  }
}

function normalize(value) { return value.normalize('NFC').replace(/\s+/gu, ' ').trim(); }
function stringsIn(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

/** A conservative exact-excerpt filter, not a guarantee against paraphrase or extraction. */
export function guardRestrictedOutput(value, knowledgeText, { maxBytes = 16_000, excerptLength = 128 } = {}) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new KnowledgeError('OUTPUT_INVALID'); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new KnowledgeError('OUTPUT_LIMIT_EXCEEDED');
  }
  const source = normalize(knowledgeText);
  // Join adjacent fields too, so splitting an excerpt between fields does not evade this basic filter.
  const values = stringsIn(value).map(normalize);
  values.push(values.join(' '));
  for (const text of values) {
    for (let offset = 0; offset <= text.length - excerptLength; offset++) {
      if (source.includes(text.slice(offset, offset + excerptLength))) {
        throw new KnowledgeError('OUTPUT_KNOWLEDGE_EXCERPT_BLOCKED');
      }
    }
  }
  return value;
}
