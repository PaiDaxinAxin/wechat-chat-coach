import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createKnowledgeStore, saveFeedback, guardRestrictedOutput, SOURCE_START, SOURCE_END } from '../src/knowledge.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-coach-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const text = `# Knowledge\n${SOURCE_START}\n${'保留原文，不做截断。'.repeat(40)}\n${SOURCE_END}\n# Accepted supplement\nKnown facts.\n`;
  const knowledgePath = join(directory, 'knowledge.md');
  await writeFile(knowledgePath, text);
  return { directory, text, knowledgePath, store: createKnowledgeStore({ knowledgePath }) };
}

test('read returns all original bytes and hash; append preserves the source exactly', async (t) => {
  const { text, knowledgePath, store } = await fixture(t);
  const original = await readFile(knowledgePath);
  const snapshot = await store.read();
  assert.equal(snapshot.text, text);
  assert.equal(snapshot.bytes, original.length);
  assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
  const result = await store.append({ expectedHash: snapshot.hash, content: 'Owner approved learning.' });
  const after = await readFile(knowledgePath);
  assert.deepEqual(after.subarray(0, original.length), original);
  assert.equal(result.hash, (await store.read()).hash);
  assert.ok(after.toString().endsWith('Owner approved learning.\n'));
});

test('concurrent revisions with the same expected hash allow exactly one append', async (t) => {
  const { store, knowledgePath } = await fixture(t);
  const hash = (await store.read()).hash;
  const secondStore = createKnowledgeStore({ knowledgePath });
  const results = await Promise.allSettled([
    store.append({ expectedHash: hash, content: 'First proposed supplement.' }),
    secondStore.append({ expectedHash: hash, content: 'Second proposed supplement.' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'KNOWLEDGE_VERSION_CONFLICT');
});

test('two owner processes with the same expected hash cannot lose a supplement', async (t) => {
  const { store, knowledgePath } = await fixture(t);
  const before = await readFile(knowledgePath);
  const expectedHash = (await store.read()).hash;
  const script = `import { createKnowledgeStore } from ${JSON.stringify(new URL('../src/knowledge.mjs', import.meta.url).href)};
const [knowledgePath, expectedHash, content] = process.argv.slice(1);
try { await createKnowledgeStore({ knowledgePath }).append({ expectedHash, content }); process.stdout.write('success'); }
catch (error) { process.stdout.write(error.code); }`;
  const run = (content) => new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, ['--input-type=module', '-e', script, knowledgePath, expectedHash, content], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    process_.stdout.on('data', (chunk) => { output += chunk; });
    process_.stderr.on('data', (chunk) => { errorOutput += chunk; });
    process_.once('error', reject);
    process_.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(errorOutput)));
  });
  const results = await Promise.all([run('Process A supplement.'), run('Process B supplement.')]);
  assert.deepEqual(results.sort(), ['KNOWLEDGE_VERSION_CONFLICT', 'success']);
  const after = await readFile(knowledgePath);
  assert.deepEqual(after.subarray(0, before.length), before);
  const suffix = after.subarray(before.length).toString();
  assert.equal(Number(suffix.includes('Process A supplement.')) + Number(suffix.includes('Process B supplement.')), 1);
});

test('invalid knowledge markers and additions are rejected without leaking a path', async (t) => {
  const { store, knowledgePath } = await fixture(t);
  const hash = (await store.read()).hash;
  await assert.rejects(store.append({ expectedHash: hash, content: SOURCE_START }), { code: 'KNOWLEDGE_APPEND_INVALID' });
  await writeFile(knowledgePath, 'No source markers.');
  await assert.rejects(store.read(), { code: 'KNOWLEDGE_SOURCE_MARKERS_INVALID' });
  const missing = createKnowledgeStore({ knowledgePath: join(knowledgePath, 'private-file') });
  await assert.rejects(missing.read(), (error) => error.code === 'KNOWLEDGE_READ_FAILED' && !error.message.includes(knowledgePath));
});

test('an existing filesystem writer lock prevents a concurrent process from overwriting knowledge', async (t) => {
  const { store, knowledgePath } = await fixture(t);
  const before = await readFile(knowledgePath);
  const expectedHash = (await store.read()).hash;
  await writeFile(`${knowledgePath}.lock`, '', { flag: 'wx' });
  await assert.rejects(store.append({ expectedHash, content: 'Cannot overwrite another writer.' }), { code: 'KNOWLEDGE_WRITE_BUSY' });
  assert.deepEqual(await readFile(knowledgePath), before);
});

test('feedback writes isolated raw untrusted data only and leaves knowledge untouched', async (t) => {
  const { store, directory, knowledgePath } = await fixture(t);
  const before = await readFile(knowledgePath);
  const feedbackDir = join(directory, 'feedback');
  const result = await saveFeedback({ observation: 'A user observation, not a trusted rule.' }, { feedbackDir, sourceMode: 'restricted' });
  const files = await readdir(feedbackDir);
  assert.deepEqual(files, [`${result.id}.json`]);
  const record = JSON.parse(await readFile(join(feedbackDir, files[0]), 'utf8'));
  assert.equal(record.stage, 'raw_untrusted');
  assert.equal(record.sourceMode, 'restricted');
  assert.equal(result.validation, 'not_cleaned');
  assert.deepEqual(await readFile(knowledgePath), before);
  assert.equal((await store.read()).hash.length, 64);
});

test('restricted output blocks long original excerpts and excessive output', () => {
  const knowledge = 'Only inside the service: ' + '甲乙丙丁戊己庚辛壬癸'.repeat(40);
  assert.throws(() => guardRestrictedOutput({ reply: knowledge.slice(30, 230) }, knowledge), { code: 'OUTPUT_KNOWLEDGE_EXCERPT_BLOCKED' });
  assert.throws(() => guardRestrictedOutput({ reply: 'a'.repeat(100) }, knowledge, { maxBytes: 20 }), { code: 'OUTPUT_LIMIT_EXCEEDED' });
  assert.deepEqual(guardRestrictedOutput({ reply: '你忙完再聊也可以。', reason: '给对方留出空间。' }, knowledge), { reply: '你忙完再聊也可以。', reason: '给对方留出空间。' });
});
