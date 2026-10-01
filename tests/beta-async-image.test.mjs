import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaStore } from '../src/beta-store.mjs';
import { CoachError } from '../src/coach.mjs';
import { QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5p8AAAAASUVORK5CYII=';
const password = 'SyntheticImagePassword123';
const profile = { background: 'Fictional designer.', style: 'Brief.', growthGoals: 'Learn to listen.', relationshipGoal: 'Get to know each other.', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) } };
const counterpart = { alias: 'Fictional picture sender', channel: 'app', appProfile: 'Fictional interests.', offlineScene: '', background: 'Introductory exchanges.', rounds: 0 };
async function fixture(t, imageFn) {
  const directory = await mkdtemp(join(tmpdir(), 'beta-image-')); const base = createBetaStore({ dataDir: directory });
  const owner = await base.seedOwner({ username: 'picture-owner', password }); base.putProfile(owner.id, validateProfile(profile, owner.plan)); const person = base.putCounterpart(owner.id, counterpart);
  const knowledge = '# Synthetic private full knowledge\n' + 'Private source must stay intact. '.repeat(100);
  const snapshot = { text: knowledge, hash: createHash('sha256').update(knowledge).digest('hex'), bytes: Buffer.byteLength(knowledge) };
  const reservations = [], failures = []; let calls = 0;
  const store = new Proxy(base, { get(target, key) { const value = target[key]; return typeof value === 'function' ? async (...args) => { if (key === 'reserveJob') reservations.push(args[0]); if (key === 'failJob') failures.push(args); return await value.apply(target, args); } : value; } });
  const servers = [];
  async function server() {
    const result = await createBetaServer({ store, storeKnowledge: { read: async () => snapshot }, archiveKnowledge: async () => ({ hash: snapshot.hash, bytes: snapshot.bytes, version: 'fixture-private', archived: true }), imageFn: async (input, options) => { calls++; assert.equal(options.knowledgeText, knowledge); return imageFn ? await imageFn(input, options) : { description: '图片中有一只猫和“哈哈”字样。', kind: 'sticker', uncertainty: '不能确定实际语气。' }; } });
    await new Promise((resolve) => result.listen(0, '127.0.0.1', resolve)); servers.push(result); return result;
  }
  function client(instance) {
    const origin = `http://127.0.0.1:${instance.address().port}`;
    return { cookie: '', csrf: '', async call(method, path, input, headers = {}) {
      const response = await fetch(origin + path, { method, headers: { origin, cookie: this.cookie, 'x-csrf-token': this.csrf, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); const payload = await response.json();
      if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0]; if (payload.data?.csrfToken) this.csrf = payload.data.csrfToken; return { status: response.status, ...payload };
    } };
  }
  t.after(async () => { for (const instance of servers) { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); } base.close(); await rm(directory, { recursive: true, force: true }); });
  const first = await server(), account = client(first); await account.call('POST', '/api/login', { username: owner.username, password });
  function persisted() {
    const db = new DatabaseSync(join(directory, 'beta.sqlite'), { readOnly: true });
    try { return { jobs: db.prepare('SELECT state,result_json,context_snapshot_json,error_code FROM model_jobs').all(), audit: db.prepare('SELECT details_json FROM audit_log').all() }; }
    finally { db.close(); }
  }
  return { base, store, owner, person, reservations, failures, server, client, account, persisted, path: `/api/counterparts/${person.id}/image-read`, get calls() { return calls; } };
}
test('first message image reading uses bounded provider budget and durable replay without storing original bytes', async (t) => {
  const f = await fixture(t); const request = { requestId: 'first-image-read', image: png, explanation: '我理解她在开玩笑。' };
  const before = f.base.quota(f.owner.id); const result = await f.account.call('POST', f.path, request);
  assert.equal(result.status, 200); assert.equal(result.data.imageInterpretation.source, 'ai_image_description'); assert.equal(result.data.imageInterpretation.userExplanation.source, 'user_interpretation'); assert.equal(result.data.quota.classificationRemaining, before.classificationRemaining); assert.equal(result.data.quota.providerRemaining, before.providerRemaining - 1);
  assert.equal((await f.account.call('POST', f.path, request)).data.cached, true);
  assert.equal((await f.account.call('POST', f.path, { ...request, requestId: 'second-image-read' })).data.cached, true); assert.equal(f.calls, 1);
  assert.equal((await f.account.call('POST', f.path, { ...request, explanation: 'Changed interpretation.' })).error.code, 'REQUEST_ID_CONTEXT_CONFLICT');
  const saved = JSON.stringify(f.reservations[0].contextSnapshot); assert.equal(saved.includes('data:image'), false); assert.equal(saved.includes(png.split(',')[1]), false); assert.ok(saved.includes('user_interpretation'));
  assert.equal(f.reservations[0].operation, 'image_read'); assert.equal(f.reservations[0].contextSnapshot.modelInput.messages.length, 0); assert.equal((await f.account.call('GET', `/api/counterparts/${f.person.id}`)).data.messages.length, 0, 'reading does not silently save a message');
});
test('image ingress keeps account/CSRF/Origin guards and enlarges only its own authenticated body limit', async (t) => {
  const f = await fixture(t); const request = { requestId: 'image-auth-test', image: png };
  const unauthenticated = f.client(await f.server()); assert.equal((await unauthenticated.call('POST', f.path, { ...request, image: 'x'.repeat(300000) })).status, 401);
  assert.equal((await f.account.call('POST', f.path, request, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await f.account.call('POST', f.path, request, { origin: 'https://hostile.example' })).status, 403);
  assert.equal((await f.account.call('POST', f.path, { ...request, image: 'x'.repeat(300000) })).error.code, 'IMAGE_INVALID');
  assert.equal((await f.account.call('POST', `/api/counterparts/${f.person.id}/messages`, { speaker: 'other', text: 'x'.repeat(300000) })).status, 413);
  assert.equal((await f.account.call('POST', f.path, { ...request, image: 'https://example.test/image.png' })).error.code, 'IMAGE_INVALID'); assert.equal(f.calls, 0);
  await assert.rejects((await f.server()).invokeForAccount({ accountId: f.owner.id, method: 'POST', path: f.path, body: request }), { code: 'MCP_OPERATION_FORBIDDEN' });
});
test('cross-instance duplicate images do not charge twice and new messages invalidate an unfinished interpretation', async (t) => {
  let entered, release; const started = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { entered(); await gate; return { description: 'AI description.', kind: 'unknown', uncertainty: '' }; });
  const other = f.client(await f.server()); other.cookie = f.account.cookie; other.csrf = f.account.csrf;
  const request = { requestId: 'image-held-first', image: png };
  const pending = f.account.call('POST', f.path, request); await started;
  try { assert.equal((await other.call('POST', f.path, { ...request, requestId: 'image-held-second' })).error.code, 'JOB_IN_PROGRESS'); await other.call('POST', `/api/counterparts/${f.person.id}/messages`, { speaker: 'other', text: 'A new message while the image was being read.' }); }
  finally { release(); }
  assert.equal((await pending).error.code, 'CONTEXT_CHANGED'); assert.equal(f.calls, 1); assert.equal(f.base.listJobs(f.owner.id, f.person.id).find(({ cacheOf }) => !cacheOf).state, 'failed');
});
test('safe diagnostic paths retain fixed guidance fields without model text or arbitrary image details', async (t) => {
  const f = await fixture(t, async () => { throw new CoachError('invalid_model_output', undefined, [{ code: 'custom', path: ['guidance', 'relationMove'] }, { code: 'too_big', path: ['guidance', 'ownWordsGuide'] }, { code: 'custom', path: ['guidance', 'reentryWhen'] }, { code: 'custom', path: ['imageSecret', png] }]); });
  assert.equal((await f.account.call('POST', f.path, { requestId: 'image-diagnostics', image: png })).error.code, 'INVALID_MODEL_OUTPUT');
  assert.deepEqual(f.failures[0][2].diagnostics.map(({ path }) => path), [['guidance', 'relationMove'], ['guidance', 'ownWordsGuide'], ['guidance', 'reentryWhen']]);
});

test('raw image explanations fail before snapshot persistence or budget reservation while ordinary emoji notes pass', async (t) => {
  const f = await fixture(t), encoded = png.split(',')[1], before = f.base.quota(f.owner.id);
  for (const [index, explanation] of [png, encoded, encoded.replace(/(.{16})/g, '$1\n'), encoded.replace(/=+$/, '')].entries()) {
    const result = await f.account.call('POST', f.path, { requestId: `image-input-echo-${index}`, image: png, explanation });
    assert.equal(result.error.code, 'IMAGE_BYTES_BLOCKED'); assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result).includes(encoded), false);
  }
  assert.equal(f.calls, 0); assert.equal(f.reservations.length, 0); assert.equal(f.persisted().jobs.length, 0);
  assert.deepEqual(f.base.quota(f.owner.id), before);
  const result = await f.account.call('POST', f.path, { requestId: 'image-normal-emoji', image: png, explanation: '😂 我觉得这是开玩笑，不代表对方确认的意思。' });
  assert.equal(result.status, 200); assert.equal(f.calls, 1); assert.equal(f.persisted().jobs[0].state, 'succeeded');
  const retained = JSON.stringify(f.persisted()); assert.equal(retained.includes(encoded), false); assert.equal(retained.includes('data:image'), false);
});

test('injected image outputs cannot persist the original image in results, snapshots or audit and failed replay never calls again', async (t) => {
  const encoded = png.split(',')[1], cut = 40;
  const candidates = [
    { description: png, kind: 'sticker', uncertainty: '' },
    { description: '可见一张图片。', kind: 'sticker', uncertainty: encoded },
    { description: encoded.slice(0, cut), kind: 'sticker', uncertainty: encoded.slice(cut) },
    { uncertainty: `后半：${encoded.slice(cut)}。`, kind: 'unknown', description: `前半：${encoded.slice(0, cut)}。` },
    { description: '可见一张图片。', kind: 'unknown', uncertainty: '', extra: png },
    { description: encoded.slice(0, cut), kind: 'sticker', uncertainty: '', extra: [encoded.slice(cut)] },
    { description: '可见一张图片。', kind: 'unknown', uncertainty: '', [encoded]: 'private bytes as a key' },
  ];
  for (const [index, candidate] of candidates.entries()) await t.test(`echo variant ${index}`, async (st) => {
    const f = await fixture(st, async () => candidate), request = { requestId: `image-output-echo-${index}`, image: png, explanation: '😂 大概是开玩笑。' };
    const result = await f.account.call('POST', f.path, request);
    assert.equal(result.error.code, 'IMAGE_BYTES_BLOCKED'); assert.equal(result.status, 400); assert.equal(f.calls, 1);
    assert.deepEqual(result.error, { code: 'IMAGE_BYTES_BLOCKED', message: '解释或识读结果含有原图编码，未保存；请改用文字描述。' });
    const replay = await f.account.call('POST', f.path, request);
    assert.equal(replay.error.code, 'IMAGE_BYTES_BLOCKED'); assert.equal(f.calls, 1, 'a failed durable request does not retry the provider');
    const saved = f.persisted(); assert.equal(saved.jobs.length, 1); assert.equal(saved.jobs[0].state, 'failed'); assert.equal(saved.jobs[0].result_json, null);
    assert.equal(saved.jobs[0].error_code, 'IMAGE_BYTES_BLOCKED');
    const retained = JSON.stringify(saved); assert.equal(retained.includes('data:image'), false); assert.equal(retained.includes(encoded), false);
    assert.equal(retained.includes(encoded.slice(0, cut)), false); assert.equal(retained.includes(encoded.slice(cut)), false, 'even separated image fragments are absent from persisted fields');
    assert.deepEqual(f.failures[0].slice(1), ['IMAGE_BYTES_BLOCKED', undefined]);
  });
});
