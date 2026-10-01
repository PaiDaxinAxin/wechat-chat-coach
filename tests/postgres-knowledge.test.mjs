import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DEFAULT_KNOWLEDGE_PATH, SOURCE_START, SOURCE_END } from '../src/knowledge.mjs';
import { archivePostgresKnowledgeVersion, createPostgresKnowledgeStore, initializePostgresKnowledgeSchema, publishPostgresKnowledgeSnapshot, seedPostgresKnowledge } from '../src/postgres-knowledge.mjs';
import { createPostgresStore } from '../src/postgres-store.mjs';
import { initializePostgresSchema } from '../src/postgres-schema.mjs';

const snapshot = (text) => ({ text, hash: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'), bytes: Buffer.byteLength(text, 'utf8') });
const sample = snapshot(`\ufeff# Complete knowledge\r\n${SOURCE_START}\r\n原始字节：你好🙂。\r\n${SOURCE_END}\r\n既有补充。\r\n`);

test('PostgreSQL knowledge validates snapshot bytes and append authority before any connection', async () => {
  let contacts = 0;
  const pool = { connect: () => { contacts++; throw new Error('never contact database'); } };
  for (const invalid of [null, { ...sample, hash: '0'.repeat(64) }, { ...sample, bytes: sample.bytes + 1 }, snapshot('missing markers'), snapshot(`${SOURCE_END}${SOURCE_START}`), snapshot(`${SOURCE_START}a${SOURCE_START}${SOURCE_END}`), snapshot(`${SOURCE_START}\ud800${SOURCE_END}`)]) {
    await assert.rejects(seedPostgresKnowledge(pool, invalid), { code: 'KNOWLEDGE_SEED_INVALID' });
    await assert.rejects(archivePostgresKnowledgeVersion(pool, invalid), { code: 'KNOWLEDGE_ARCHIVE_FAILED', status: 500 });
    await assert.rejects(publishPostgresKnowledgeSnapshot(pool, { snapshot: invalid, expectedHash: sample.hash }), { code: 'KNOWLEDGE_PUBLISH_INVALID' });
  }
  for (const expectedHash of [undefined, 'bad', 'A'.repeat(64)]) await assert.rejects(publishPostgresKnowledgeSnapshot(pool, { snapshot: sample, expectedHash }), { code: 'KNOWLEDGE_PUBLISH_INVALID' });
  const store = createPostgresKnowledgeStore({ pool });
  for (const input of [null, {}, { content: SOURCE_START, expectedHash: sample.hash }, { content: ' ', expectedHash: sample.hash }, { content: 'x'.repeat(32_001), expectedHash: sample.hash }, { content: 'fine', expectedHash: 'bad' }]) {
    await assert.rejects(store.append(input), { code: 'KNOWLEDGE_APPEND_INVALID' });
  }
  assert.equal(contacts, 0);
});

test('PostgreSQL knowledge returns only fixed errors without connection details or full knowledge', async () => {
  const secret = `upstream-private-password:${sample.text}`;
  const pool = { query: async () => { throw new Error(secret); }, connect: async () => { throw new Error(secret); } };
  for (const [operation, code] of [
    [() => createPostgresKnowledgeStore({ pool }).read(), 'KNOWLEDGE_READ_FAILED'],
    [() => createPostgresKnowledgeStore({ pool }).append({ content: 'Owner addition.', expectedHash: sample.hash }), 'KNOWLEDGE_APPEND_FAILED'],
    [() => seedPostgresKnowledge(pool, sample), 'KNOWLEDGE_SEED_FAILED'],
    [() => publishPostgresKnowledgeSnapshot(pool, { snapshot: sample, expectedHash: sample.hash }), 'KNOWLEDGE_PUBLISH_FAILED'],
    [() => initializePostgresKnowledgeSchema(pool), 'KNOWLEDGE_SCHEMA_FAILED'],
    [() => archivePostgresKnowledgeVersion(pool, sample), 'KNOWLEDGE_ARCHIVE_FAILED'],
  ]) {
    await assert.rejects(operation(), (error) => error.code === code && error.message === code && error.cause === undefined);
  }
});

test('scoped knowledge reads retain complete byte validation and sanitized errors', async () => {
  const sourceHash = createHash('sha256').update(sample.text.split(SOURCE_START)[1].split(SOURCE_END)[0]).digest('hex');
  const pool = { query: () => { throw new Error('must reuse scoped reader'); } };
  const row = { ...sample, source_hash: sourceHash };
  assert.deepEqual(await createPostgresKnowledgeStore({ pool, readCurrent: async () => row }).read(), sample);
  for (const invalid of [{ ...row, bytes: row.bytes + 1 }, { ...row, source_hash: '0'.repeat(64) }, null]) {
    await assert.rejects(createPostgresKnowledgeStore({ pool, readCurrent: async () => invalid }).read(), { code: 'KNOWLEDGE_READ_FAILED' });
  }
  await assert.rejects(createPostgresKnowledgeStore({ pool, readCurrent: async () => { throw new Error('private SQL credentials'); } }).read(),
    (error) => error.message === 'KNOWLEDGE_READ_FAILED' && error.cause === undefined);
});

const connectionString = process.env.CHAT_COACH_TEST_DATABASE_URL;
test('isolated PostgreSQL keeps complete immutable versions, transactional CAS and private role access', { skip: !connectionString }, async (t) => {
  const location = new URL(connectionString);
  // This suite may drop only its dedicated localhost fixture, never a cloud DB.
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && location.pathname === '/coach_knowledge', 'Use the dedicated loopback coach_knowledge test database.');
  const pool = new Pool({ connectionString, max: 8 });
  t.after(async () => { await pool.query('DROP SCHEMA IF EXISTS chat_coach CASCADE'); await pool.end(); });
  const canonical = snapshot(await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8'));
  async function reset(input = canonical) {
    await pool.query('DROP SCHEMA IF EXISTS chat_coach CASCADE');
    assert.deepEqual(await initializePostgresKnowledgeSchema(pool), { initialized: true });
    if (input) await seedPostgresKnowledge(pool, input);
    return createPostgresKnowledgeStore({ pool });
  }

  await t.test('construction does not migrate or bootstrap; explicit seed never overwrites a current version', async () => {
    await pool.query('DROP SCHEMA IF EXISTS chat_coach CASCADE');
    const store = createPostgresKnowledgeStore({ pool });
    assert.equal((await pool.query("SELECT to_regnamespace('chat_coach') AS schema")).rows[0].schema, null);
    await assert.rejects(store.read(), { code: 'KNOWLEDGE_READ_FAILED' });
    await initializePostgresKnowledgeSchema(pool);
    const seeds = await Promise.all([seedPostgresKnowledge(pool, canonical), seedPostgresKnowledge(pool, snapshot(`${canonical.text}\nA separate reviewed bootstrap version.\n`))]);
    assert.equal(seeds.filter(({ seeded }) => seeded).length, 1);
    const original = await store.read();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 1);
    const repeated = await seedPostgresKnowledge(pool, sample);
    assert.equal(repeated.seeded, false); assert.equal(repeated.hash, original.hash); assert.deepEqual(await store.read(), original);
  });

  await t.test('read returns every canonical UTF8 byte; append retains source and local supplement format', async () => {
    const store = await reset();
    assert.deepEqual(await store.read(), canonical);
    const result = await store.append({ content: '  Owner reviewed precise addition.  ', expectedHash: canonical.hash });
    const updated = await store.read();
    assert.deepEqual(result, { hash: updated.hash, bytes: updated.bytes, appended: true });
    assert.deepEqual(Buffer.from(updated.text).subarray(0, canonical.bytes), Buffer.from(canonical.text));
    assert.match(updated.text.slice(canonical.text.length), /^\n\n## Owner reviewed supplement \(\d{4}-\d\d-\d\dT.+Z\)\n\nOwner reviewed precise addition\.\n$/);
    assert.equal((await pool.query('SELECT text FROM chat_coach.knowledge_versions WHERE hash=$1', [canonical.hash])).rows[0].text, canonical.text);
    const second = await reset(sample);
    const preserved = await second.read();
    assert.deepEqual(preserved, sample); assert.deepEqual(Buffer.from(preserved.text), Buffer.from(sample.text));
  });

  await t.test('independent concurrent writers allow exactly one CAS update and leave no lost or orphan supplement', async () => {
    const store = await reset();
    const second = createPostgresKnowledgeStore({ pool });
    const results = await Promise.allSettled([
      store.append({ content: 'Concurrent owner A.', expectedHash: canonical.hash }),
      second.append({ content: 'Concurrent owner B.', expectedHash: canonical.hash }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'KNOWLEDGE_VERSION_CONFLICT');
    const updated = await store.read();
    assert.equal(Number(updated.text.includes('Concurrent owner A.')) + Number(updated.text.includes('Concurrent owner B.')), 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 2);
    assert.equal(updated.text.slice(0, canonical.text.length), canonical.text);
  });

  await t.test('owner publication keeps exact local bytes and hash without adding a second supplement header', async () => {
    const store = await reset(sample);
    const updated = snapshot(`${sample.text}\r\n## Owner reviewed supplement (2026-10-01T07:50:45.846Z)\r\n\r\nExact owner content 🙂。\r\n`);
    assert.deepEqual(await publishPostgresKnowledgeSnapshot(pool, { snapshot: updated, expectedHash: sample.hash }), { hash: updated.hash, bytes: updated.bytes, published: true });
    assert.deepEqual(await store.read(), updated);
    assert.deepEqual(Buffer.from((await store.read()).text), Buffer.from(updated.text));
    assert.equal((await pool.query('SELECT text FROM chat_coach.knowledge_versions WHERE hash=$1', [sample.hash])).rows[0].text, sample.text);
    assert.deepEqual(await publishPostgresKnowledgeSnapshot(pool, { snapshot: updated, expectedHash: sample.hash }), { hash: updated.hash, bytes: updated.bytes, published: false });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 2);
  });

  await t.test('owner publication rejects wrong CAS, changed existing text, changed source and empty additions', async () => {
    const store = await reset(sample);
    const updated = snapshot(`${sample.text}\nReviewed addition.\n`);
    await assert.rejects(publishPostgresKnowledgeSnapshot(pool, { snapshot: updated, expectedHash: '0'.repeat(64) }), { code: 'KNOWLEDGE_VERSION_CONFLICT' });
    for (const changed of [
      snapshot(sample.text.replace('既有补充。', '改写既有补充。') + '\nReviewed addition.\n'),
      snapshot(sample.text.replace('原始字节：你好🙂。', 'Changed original source.') + '\nReviewed addition.\n'),
      snapshot(`${sample.text}\r\n  \t`),
      snapshot(sample.text.slice(0, -2)),
    ]) await assert.rejects(publishPostgresKnowledgeSnapshot(pool, { snapshot: changed, expectedHash: sample.hash }), { code: 'KNOWLEDGE_PUBLISH_INVALID' });
    assert.deepEqual(await store.read(), sample);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 1);
  });

  await t.test('concurrent exact publications admit one winner and do not insert the losing version', async () => {
    const store = await reset();
    const versions = [snapshot(`${canonical.text}\nPublished A.\n`), snapshot(`${canonical.text}\nPublished B.\n`)];
    const results = await Promise.allSettled(versions.map((updated) => publishPostgresKnowledgeSnapshot(pool, { snapshot: updated, expectedHash: canonical.hash })));
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'KNOWLEDGE_VERSION_CONFLICT');
    const winner = versions[results.findIndex(({ status }) => status === 'fulfilled')];
    assert.deepEqual(await store.read(), winner);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 2);
  });

  await t.test('a failed pointer write rolls back both the added version and canonical update', async () => {
    const store = await reset();
    await pool.query(`CREATE FUNCTION chat_coach.fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'private-trigger-message'; END; $$;
      CREATE TRIGGER fixture_failure BEFORE UPDATE ON chat_coach.knowledge_current FOR EACH ROW EXECUTE FUNCTION chat_coach.fixture_failure();`);
    await assert.rejects(store.append({ content: 'Must not partially persist.', expectedHash: canonical.hash }), (error) => error.code === 'KNOWLEDGE_APPEND_FAILED' && error.message === 'KNOWLEDGE_APPEND_FAILED');
    const published = snapshot(`${canonical.text}\nExact publication must not partially persist.\n`);
    await assert.rejects(publishPostgresKnowledgeSnapshot(pool, { snapshot: published, expectedHash: canonical.hash }), (error) => error.code === 'KNOWLEDGE_PUBLISH_FAILED' && error.message === 'KNOWLEDGE_PUBLISH_FAILED' && error.cause === undefined);
    assert.deepEqual(await store.read(), canonical);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 1);
    await pool.query('DROP TRIGGER fixture_failure ON chat_coach.knowledge_current');
    assert.equal((await publishPostgresKnowledgeSnapshot(pool, { snapshot: published, expectedHash: canonical.hash })).published, true);
    assert.deepEqual(await store.read(), published);
    assert.equal((await store.append({ content: 'Must not partially persist.', expectedHash: published.hash })).appended, true);
  });

  await t.test('content-addressed archive is complete and idempotent without changing canonical current', async () => {
    const store = await reset();
    const historical = snapshot(`${canonical.text}\nOwner reviewed historical supplement.\n`);
    const expected = { sourceRevision: 'game-3.3', version: `game-3.3+${historical.hash.slice(0, 12)}`, hash: historical.hash, bytes: historical.bytes, archived: true };
    assert.deepEqual(await archivePostgresKnowledgeVersion(pool, historical), expected);
    assert.deepEqual(await archivePostgresKnowledgeVersion(pool, historical), expected);
    assert.deepEqual(await store.read(), canonical);
    assert.equal((await pool.query('SELECT text FROM chat_coach.knowledge_versions WHERE hash=$1', [historical.hash])).rows[0].text, historical.text);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 2);
    const changedSource = snapshot(canonical.text.replace(SOURCE_START, `${SOURCE_START}\nChanged original source.`));
    await assert.rejects(archivePostgresKnowledgeVersion(pool, changedSource), { code: 'KNOWLEDGE_ARCHIVE_FAILED', status: 500 });
    await assert.rejects(pool.query('UPDATE chat_coach.knowledge_versions SET text=text WHERE hash=$1', [historical.hash]), { code: '55000' });
    await assert.rejects(pool.query('DELETE FROM chat_coach.knowledge_versions WHERE hash=$1', [historical.hash]), { code: '55000' });
  });

  await t.test('four writer transactions reuse their clients for complete knowledge reads without starving the pool', async () => {
    await reset();
    await initializePostgresSchema(pool);
    const bounded = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 2000 });
    let firstEntered, releaseFirst;
    const entered = new Promise((resolve) => { firstEntered = resolve; });
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    const pending = [];
    try {
      const store = await createPostgresStore({ pool: bounded });
      let independentReads = 0;
      // A read through pool.query would require a fifth connection. Reject that
      // exact path immediately instead of waiting for a production lock timeout.
      bounded.query = async () => { independentReads++; throw new Error('SECOND_CONNECTION_UNDER_WRITER_LOCK'); };
      const knowledge = createPostgresKnowledgeStore({ pool: bounded, readCurrent: () => store.getCurrentKnowledgeVersion() });
      pending.push(store.withTransaction(async () => {
        firstEntered(); await release;
        return knowledge.read();
      }));
      await entered;
      for (let index = 0; index < 3; index++) pending.push(store.withTransaction(() => knowledge.read()));
      for (let index = 0; index < 200 && bounded.totalCount !== 4; index++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(bounded.totalCount, 4, 'all four transactions must overlap');
      assert.equal(bounded.idleCount, 0);
      releaseFirst();
      const reads = await Promise.all(pending);
      assert.equal(reads.length, 4);
      reads.forEach((value) => assert.deepEqual(value, canonical));
      assert.equal(independentReads, 0);
      assert.equal(bounded.waitingCount, 0);
    } finally {
      releaseFirst(); await Promise.allSettled(pending); await bounded.end();
    }
  });

  await t.test('a malformed stored source is rejected with the same marker failure as local knowledge', async () => {
    const store = await reset();
    const invalid = snapshot('Stored content without original source markers.');
    await pool.query('INSERT INTO chat_coach.knowledge_versions(hash,text,bytes,source_hash) VALUES($1,$2,$3,$4)', [invalid.hash, invalid.text, invalid.bytes, '0'.repeat(64)]);
    await pool.query('UPDATE chat_coach.knowledge_current SET hash=$1', [invalid.hash]);
    await assert.rejects(store.read(), { code: 'KNOWLEDGE_SOURCE_MARKERS_INVALID' });
    await assert.rejects(store.append({ expectedHash: invalid.hash, content: 'Cannot append to malformed source.' }), { code: 'KNOWLEDGE_SOURCE_MARKERS_INVALID' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.knowledge_versions')).rows[0].n, 2);
  });

  await t.test('PUBLIC is revoked and RLS denies unconfigured roles while a specific private server role can operate', async () => {
    await reset();
    const role = `coach_knowledge_${randomUUID().replaceAll('-', '')}`;
    const denied = `coach_knowledge_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE ROLE ${role} LOGIN; CREATE ROLE ${denied} LOGIN;
      GRANT USAGE ON SCHEMA chat_coach TO PUBLIC;
      GRANT SELECT ON chat_coach.knowledge_versions,chat_coach.knowledge_current TO PUBLIC;
      CREATE POLICY fixture_public_read ON chat_coach.knowledge_versions FOR SELECT USING(TRUE);`);
    const roleConnection = (name) => { const url = new URL(connectionString); url.username = name; return url.href; };
    const serverPool = new Pool({ connectionString: roleConnection(role), max: 4 });
    const deniedPool = new Pool({ connectionString: roleConnection(denied), max: 2 });
    try {
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='chat_coach'")).rows[0].n, 1);
      await initializePostgresKnowledgeSchema(pool);
      await assert.rejects(deniedPool.query('SELECT text FROM chat_coach.knowledge_versions'), { code: '42501' });
      const tableSecurity = (await pool.query("SELECT relrowsecurity FROM pg_class JOIN pg_namespace ON relnamespace=pg_namespace.oid WHERE nspname='chat_coach' AND relname IN ('knowledge_versions','knowledge_current')")).rows;
      assert.equal(tableSecurity.length, 2); assert.ok(tableSecurity.every(({ relrowsecurity }) => relrowsecurity));
      assert.deepEqual((await pool.query("SELECT policyname FROM pg_policies WHERE schemaname='chat_coach'")).rows, []);
      await pool.query(`GRANT USAGE ON SCHEMA chat_coach TO ${role};
        GRANT SELECT,INSERT ON chat_coach.knowledge_versions TO ${role};
        GRANT SELECT,INSERT,UPDATE ON chat_coach.knowledge_current TO ${role};`);
      // Privileges alone do not bypass RLS; only the explicit server policy does.
      assert.deepEqual((await serverPool.query('SELECT hash FROM chat_coach.knowledge_versions')).rows, []);
      await pool.query(`CREATE POLICY knowledge_server ON chat_coach.knowledge_versions TO ${role} USING(TRUE) WITH CHECK(TRUE);
        CREATE POLICY knowledge_server ON chat_coach.knowledge_current TO ${role} USING(TRUE) WITH CHECK(TRUE);`);
      const serverStore = createPostgresKnowledgeStore({ pool: serverPool });
      assert.deepEqual(await serverStore.read(), canonical);
      assert.equal((await serverStore.append({ content: 'Server-only approved addition.', expectedHash: canonical.hash })).appended, true);
      await initializePostgresKnowledgeSchema(pool);
      assert.equal((await serverStore.read()).text.endsWith('Server-only approved addition.\n'), true);
      const policies = (await pool.query("SELECT roles FROM pg_policies WHERE schemaname='chat_coach' ORDER BY tablename")).rows;
      assert.equal(policies.length, 2); assert.ok(policies.every(({ roles }) => String(roles) === `{${role}}`));
      await assert.rejects(deniedPool.query('SELECT text FROM chat_coach.knowledge_versions'), { code: '42501' });
    } finally {
      await serverPool.end(); await deniedPool.end();
      await pool.query(`DROP OWNED BY ${role},${denied}; DROP ROLE ${role},${denied};`);
    }
  });
});
