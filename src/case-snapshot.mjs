import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BetaError } from './store-contract.mjs';

// Content-addressed, complete knowledge versions stay inside the private data
// directory. No HTTP or MCP route reads these files.
export async function archiveKnowledgeVersion(dataDir, snapshot) {
  const bytes = Buffer.from(snapshot.text, 'utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (snapshot.hash !== hash) throw new BetaError('KNOWLEDGE_ARCHIVE_FAILED', 500);
  const directory = join(dataDir, 'knowledge-versions');
  const destination = join(directory, `${hash}.md`);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(destination);
      if (createHash('sha256').update(existing).digest('hex') !== hash) throw new Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try { await link(temporary, destination); }
      catch (cause) {
        if (cause.code !== 'EEXIST' || createHash('sha256').update(await readFile(destination)).digest('hex') !== hash) throw cause;
      }
    }
    return { sourceRevision: 'game-3.3', version: `game-3.3+${hash.slice(0, 12)}`, hash, bytes: bytes.length, archived: true };
  } catch { throw new BetaError('KNOWLEDGE_ARCHIVE_FAILED', 500); }
  finally { await unlink(temporary).catch(() => {}); }
}
