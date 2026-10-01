import { createHash } from 'node:crypto';
import { KnowledgeError, SOURCE_START, SOURCE_END } from './knowledge.mjs';
import { BetaError } from './store-contract.mjs';

// Every writer of the singleton pointer uses this transaction-scoped lock.
// No connection, migration, bootstrap, or full-text read happens on import.
const WRITER_LOCK = [1784961896, 1];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validatedSnapshot(snapshot, errorCode, markerErrorCode = errorCode) {
  if (!snapshot || typeof snapshot.text !== 'string') throw new KnowledgeError(errorCode);
  const bytes = Buffer.from(snapshot.text, 'utf8');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text !== snapshot.text || text.includes('\0')) throw new KnowledgeError(errorCode);
  if (text.split(SOURCE_START).length !== 2 || text.split(SOURCE_END).length !== 2 ||
      text.indexOf(SOURCE_START) >= text.indexOf(SOURCE_END)) throw new KnowledgeError(markerErrorCode);
  const digest = hash(bytes);
  if (snapshot.hash !== digest || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes !== bytes.length) throw new KnowledgeError(errorCode);
  const source = bytes.subarray(bytes.indexOf(Buffer.from(SOURCE_START)) + Buffer.byteLength(SOURCE_START), bytes.indexOf(Buffer.from(SOURCE_END)));
  return { text, hash: digest, bytes: bytes.length, sourceHash: hash(source), source };
}

function versionSnapshot(row, errorCode) {
  if (!row) throw new KnowledgeError(errorCode);
  const snapshot = validatedSnapshot({ text: row.text, hash: row.hash, bytes: row.bytes }, errorCode, errorCode === 'KNOWLEDGE_READ_FAILED' ? 'KNOWLEDGE_SOURCE_MARKERS_INVALID' : errorCode);
  if (snapshot.sourceHash !== row.source_hash) throw new KnowledgeError(errorCode);
  return snapshot;
}

async function transaction(pool, operation, errorCode) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', WRITER_LOCK);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError(errorCode);
  } finally { client?.release(); }
}

async function currentVersion(queryable) {
  const result = await queryable.query(`SELECT version.hash,version.text,version.bytes,version.source_hash
    FROM chat_coach.knowledge_current current
    JOIN chat_coach.knowledge_versions version ON version.hash=current.hash
    WHERE current.singleton=TRUE`);
  return result.rows[0] ?? null;
}

async function insertVersion(client, snapshot, errorCode) {
  await client.query(`INSERT INTO chat_coach.knowledge_versions(hash,text,bytes,source_hash)
    VALUES($1,$2,$3,$4) ON CONFLICT(hash) DO NOTHING`, [snapshot.hash, snapshot.text, snapshot.bytes, snapshot.sourceHash]);
  const { rows } = await client.query('SELECT hash,text,bytes,source_hash FROM chat_coach.knowledge_versions WHERE hash=$1', [snapshot.hash]);
  const stored = versionSnapshot(rows[0], errorCode);
  if (stored.text !== snapshot.text || stored.sourceHash !== snapshot.sourceHash) throw new KnowledgeError(errorCode);
}

/** Explicit migration only. The app's private role grants/policies are separate. */
export async function initializePostgresKnowledgeSchema(pool) {
  return transaction(pool, async (client) => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS chat_coach;
      CREATE TABLE IF NOT EXISTS chat_coach.knowledge_versions (
        hash TEXT PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'),
        text TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes=octet_length(text)),
        source_hash TEXT NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS chat_coach.knowledge_current (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),
        hash TEXT NOT NULL REFERENCES chat_coach.knowledge_versions(hash),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION chat_coach.reject_knowledge_version_mutation()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
      BEGIN RAISE EXCEPTION 'IMMUTABLE_KNOWLEDGE_VERSION' USING ERRCODE='55000'; END;
      $function$;
      DROP TRIGGER IF EXISTS knowledge_version_immutable ON chat_coach.knowledge_versions;
      CREATE TRIGGER knowledge_version_immutable BEFORE UPDATE OR DELETE ON chat_coach.knowledge_versions
        FOR EACH ROW EXECUTE FUNCTION chat_coach.reject_knowledge_version_mutation();
      ALTER TABLE chat_coach.knowledge_versions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE chat_coach.knowledge_current ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON SCHEMA chat_coach FROM PUBLIC;
      REVOKE ALL ON chat_coach.knowledge_versions,chat_coach.knowledge_current FROM PUBLIC;
      REVOKE ALL ON FUNCTION chat_coach.reject_knowledge_version_mutation() FROM PUBLIC;
      DO $block$
      DECLARE private_table TEXT; public_policy TEXT; denied_role TEXT;
      BEGIN
        FOREACH denied_role IN ARRAY ARRAY['anon','authenticated'] LOOP
          IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=denied_role) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA chat_coach FROM %I',denied_role);
            EXECUTE format('REVOKE ALL ON chat_coach.knowledge_versions,chat_coach.knowledge_current FROM %I',denied_role);
            EXECUTE format('REVOKE ALL ON FUNCTION chat_coach.reject_knowledge_version_mutation() FROM %I',denied_role);
          END IF;
        END LOOP;
        FOREACH private_table IN ARRAY ARRAY['knowledge_versions','knowledge_current'] LOOP
          FOR public_policy IN SELECT policyname FROM pg_policies
            WHERE schemaname='chat_coach' AND tablename=private_table
              AND roles && ARRAY['public','anon','authenticated']::name[] LOOP
            EXECUTE format('DROP POLICY %I ON chat_coach.%I',public_policy,private_table);
          END LOOP;
        END LOOP;
      END;
      $block$;`);
    return { initialized: true };
  }, 'KNOWLEDGE_SCHEMA_FAILED');
}

/** Empty bootstrap only: existing canonical knowledge is never replaced. */
export async function seedPostgresKnowledge(pool, input) {
  const snapshot = validatedSnapshot(input, 'KNOWLEDGE_SEED_INVALID');
  return transaction(pool, async (client) => {
    const row = await currentVersion(client);
    if (row) {
      const current = versionSnapshot(row, 'KNOWLEDGE_READ_FAILED');
      return { hash: current.hash, bytes: current.bytes, seeded: false };
    }
    await insertVersion(client, snapshot, 'KNOWLEDGE_SEED_FAILED');
    await client.query('INSERT INTO chat_coach.knowledge_current(singleton,hash) VALUES(TRUE,$1)', [snapshot.hash]);
    return { hash: snapshot.hash, bytes: snapshot.bytes, seeded: true };
  }, 'KNOWLEDGE_SEED_FAILED');
}

/** Owner deployment only: publish exact reviewed bytes, never rewrite history. */
export async function publishPostgresKnowledgeSnapshot(pool, input) {
  const snapshot = validatedSnapshot(input?.snapshot, 'KNOWLEDGE_PUBLISH_INVALID');
  const expectedHash = input?.expectedHash;
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new KnowledgeError('KNOWLEDGE_PUBLISH_INVALID');
  return transaction(pool, async (client) => {
    const current = versionSnapshot(await currentVersion(client), 'KNOWLEDGE_READ_FAILED');
    // A lost deployment response can replay its original expected hash safely.
    if (current.hash === snapshot.hash) return { hash: current.hash, bytes: current.bytes, published: false };
    if (current.hash !== expectedHash) throw new KnowledgeError('KNOWLEDGE_VERSION_CONFLICT');
    if (!snapshot.source.equals(current.source) || !snapshot.text.startsWith(current.text) ||
        !snapshot.text.slice(current.text.length).trim()) throw new KnowledgeError('KNOWLEDGE_PUBLISH_INVALID');
    await insertVersion(client, snapshot, 'KNOWLEDGE_PUBLISH_FAILED');
    const result = await client.query('UPDATE chat_coach.knowledge_current SET hash=$1,updated_at=now() WHERE singleton=TRUE AND hash=$2', [snapshot.hash, expectedHash]);
    if (result.rowCount !== 1) throw new KnowledgeError('KNOWLEDGE_VERSION_CONFLICT');
    return { hash: snapshot.hash, bytes: snapshot.bytes, published: true };
  }, 'KNOWLEDGE_PUBLISH_FAILED');
}

/** Complete immutable private archive; no HTTP/MCP read authority is added. */
export async function archivePostgresKnowledgeVersion(pool, input) {
  try {
    const snapshot = validatedSnapshot(input, 'KNOWLEDGE_ARCHIVE_FAILED');
    return await transaction(pool, async (client) => {
      const row = await currentVersion(client);
      if (row && versionSnapshot(row, 'KNOWLEDGE_ARCHIVE_FAILED').sourceHash !== snapshot.sourceHash) throw new KnowledgeError('KNOWLEDGE_ARCHIVE_FAILED');
      await insertVersion(client, snapshot, 'KNOWLEDGE_ARCHIVE_FAILED');
      return { sourceRevision: 'game-3.3', version: `game-3.3+${snapshot.hash.slice(0, 12)}`, hash: snapshot.hash, bytes: snapshot.bytes, archived: true };
    }, 'KNOWLEDGE_ARCHIVE_FAILED');
  } catch { throw new BetaError('KNOWLEDGE_ARCHIVE_FAILED', 500); }
}

/** Pool is selected by server startup, never by a request/tool argument. */
export function createPostgresKnowledgeStore({ pool, readCurrent }) {
  async function read() {
    try {
      // A composed business transaction must reuse its existing connection.
      // Acquiring another pool connection while holding the writer lock can
      // starve a bounded pool whose other clients are waiting for that lock.
      const row = readCurrent ? await readCurrent() : await currentVersion(pool);
      const snapshot = versionSnapshot(row, 'KNOWLEDGE_READ_FAILED');
      return { text: snapshot.text, hash: snapshot.hash, bytes: snapshot.bytes };
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('KNOWLEDGE_READ_FAILED');
    }
  }
  async function append(input) {
    const content = input?.content, expectedHash = input?.expectedHash;
    if (typeof content !== 'string' || !content.trim() || content.length > 32_000 || content.includes('\0') ||
        content.includes(SOURCE_START) || content.includes(SOURCE_END) ||
        typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new KnowledgeError('KNOWLEDGE_APPEND_INVALID');
    return transaction(pool, async (client) => {
      const current = versionSnapshot(await currentVersion(client), 'KNOWLEDGE_READ_FAILED');
      if (current.hash !== expectedHash) throw new KnowledgeError('KNOWLEDGE_VERSION_CONFLICT');
      const addition = `\n\n## Owner reviewed supplement (${new Date().toISOString()})\n\n${content.trim()}\n`;
      const bytes = Buffer.concat([Buffer.from(current.text, 'utf8'), Buffer.from(addition, 'utf8')]);
      const updated = validatedSnapshot({ text: bytes.toString('utf8'), hash: hash(bytes), bytes: bytes.length }, 'KNOWLEDGE_APPEND_FAILED');
      if (!updated.source.equals(current.source)) throw new KnowledgeError('KNOWLEDGE_APPEND_FAILED');
      await insertVersion(client, updated, 'KNOWLEDGE_APPEND_FAILED');
      const result = await client.query('UPDATE chat_coach.knowledge_current SET hash=$1,updated_at=now() WHERE singleton=TRUE AND hash=$2', [updated.hash, expectedHash]);
      if (result.rowCount !== 1) throw new KnowledgeError('KNOWLEDGE_VERSION_CONFLICT');
      return { hash: updated.hash, bytes: updated.bytes, appended: true };
    }, 'KNOWLEDGE_APPEND_FAILED');
  }
  return { read, append };
}
