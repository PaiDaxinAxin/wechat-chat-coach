import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaMcpHandler } from '../src/beta-mcp.mjs';
import { createPostgresStore } from '../src/postgres-store.mjs';
import { initializePostgresSchema } from '../src/postgres-schema.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';
import { QUESTIONNAIRES } from '../src/domain.mjs';

const connectionString = process.env.CHAT_COACH_TEST_DATABASE_URL;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('two HTTP/MCP instances use Postgres ownership, tasks and atomic context completion', { skip: !connectionString }, async (t) => {
  const target = new URL(connectionString);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/coach_[a-z0-9_]+$/);
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 8 }), peerPool = new Pool({ connectionString, max: 8 });
  const servers = [];
  let modelCalls = 0, providerGate = deferred(), providerStarted = deferred();
  let completionGate, completionStarted;
  t.after(async () => {
    providerGate.resolve(); completionGate?.resolve();
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await server.storeClosed;
    }
    await pool.end(); await peerPool.end();
  });
  await initializePostgresSchema(pool);
  const settings = { freeProviderDailyLimit: 100, paidProviderDailyLimit: 100, globalProviderDailyLimit: 10_000 };
  const store = await createPostgresStore({ pool, ...settings }), peer = await createPostgresStore({ pool: peerPool, ...settings });
  const password = 'SyntheticHttpPostgres2026';
  const owner = await store.seedOwner({ username: `http_${randomUUID().slice(0, 8)}`, password });
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledge = { text: knowledgeText, hash: createHash('sha256').update(knowledgeText).digest('hex'), bytes: Buffer.byteLength(knowledgeText) };
  const originalComplete = store.completeJob;
  store.completeJob = async (...args) => {
    if (completionGate) { completionStarted.resolve(); await completionGate.promise; }
    return originalComplete(...args);
  };
  const replyFn = async (_input, config) => {
    modelCalls++;
    assert.ok(config.knowledgeText === knowledgeText);
    providerStarted.resolve();
    await providerGate.promise;
    return { reply: '你最近看了什么电影？', reason: '延伸当前话题。', action: 'reply', styleNote: '保持简短自然。' };
  };
  for (const database of [store, peer]) {
    const server = await createBetaServer({ store: database, storeKnowledge: { read: async () => knowledge }, archiveKnowledge: async (snapshot) => ({ hash: snapshot.hash, bytes: snapshot.bytes, version: 'synthetic-version', archived: true }), ownsStore: false, webDir: null, providerEnv: {}, replyFn, classifyFn: async () => { throw new Error('UNEXPECTED_CLASSIFICATION'); } });
    server.setMcpHandler(createBetaMcpHandler(server));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
  }
  const origin = (index) => `http://127.0.0.1:${servers[index].address().port}`;
  let session;
  const call = async (index, method, path, body, authenticated = true) => {
    const response = await fetch(origin(index) + path, { method, headers: { origin: origin(index), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated && session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, payload: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = await call(0, 'POST', '/api/login', { username: owner.username, password });
  assert.equal(login.status, 200);
  session = { cookie: login.cookie, csrfToken: login.payload.data.csrfToken };
  assert.equal((await call(1, 'GET', '/api/me')).payload.data.user.id, owner.id);
  assert.equal((await call(1, 'GET', '/api/me', undefined, false)).status, 401);
  const profile = { background: '虚构设计师。', style: '简短自然。', growthGoals: '练习表达兴趣。', relationshipGoal: '双方愿意时见面。', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) } };
  assert.equal((await call(0, 'PUT', '/api/profile', profile)).status, 200);
  const created = await call(0, 'POST', '/api/counterparts', { alias: '虚构对象', channel: 'app', appProfile: '喜欢电影。', offlineScene: '', background: '虚构背景。', rounds: 2 });
  const id = created.payload.data.counterpart.id;
  assert.equal((await call(0, 'POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '最近一直忙工作。' })).status, 200);

  const request = { requestId: randomUUID(), direction: 'down' };
  const pending = call(0, 'POST', `/api/counterparts/${id}/reply`, request);
  await providerStarted.promise;
  const duplicate = await call(1, 'POST', `/api/counterparts/${id}/reply`, request);
  assert.equal(duplicate.status, 409); assert.equal(duplicate.payload.error.code, 'JOB_IN_PROGRESS');
  assert.equal(modelCalls, 1);
  assert.equal((await call(1, 'POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '今天终于忙完了。' })).status, 200);
  providerGate.resolve();
  const invalidated = await pending;
  assert.equal(invalidated.status, 409); assert.equal(invalidated.payload.error.code, 'CONTEXT_CHANGED');
  assert.equal((await store.listSuggestions(owner.id, id)).length, 0);

  providerGate = deferred(); providerStarted = deferred(); completionGate = deferred(); completionStarted = deferred();
  const finalRequest = { requestId: randomUUID(), direction: 'sideways' };
  const completing = call(0, 'POST', `/api/counterparts/${id}/reply`, finalRequest);
  await providerStarted.promise; providerGate.resolve();
  await completionStarted.promise;
  const contextWrite = call(1, 'PUT', '/api/profile', { ...profile, style: '新的风格。' });
  for (let count = 0; count < 100; count++) {
    const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND classid=1784961896 AND objid=1 AND NOT granted");
    if (waiting.rows[0].count) break;
    assert.ok(count < 99, 'a second HTTP instance cannot write between context verification and task completion');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  completionGate.resolve();
  const completed = await completing;
  assert.equal(completed.status, 200); assert.equal(modelCalls, 2);
  assert.equal((await contextWrite).status, 200);
  const history = await call(1, 'GET', `/api/counterparts/${id}`);
  assert.equal(history.status, 200);
  assert.equal(history.payload.data.directReply, null, 'the subsequent profile change makes the completed reply historical');
  assert.ok(!JSON.stringify(history.payload).includes('context_snapshot_json'));
  assert.ok(!JSON.stringify(history.payload).includes(knowledgeText));
  assert.equal((await call(1, 'GET', '/knowledge/game-system.md')).status, 404);
  assert.equal((await call(1, 'POST', '/api/demo/session', {})).status, 404);

  const { token } = await store.createMcpToken({ ownerId: owner.id, userId: owner.id });
  const mcp = async (index, message) => {
    const response = await fetch(origin(index) + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(message) });
    return { status: response.status, payload: await response.json() };
  };
  const tools = await mcp(1, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(tools.status, 200);
  assert.deepEqual(tools.payload.result.tools.map(({ name }) => name).sort(), ['coach_classify', 'coach_reply', 'counterparts_list', 'feedback_submit']);
  const listed = await mcp(0, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'counterparts_list', arguments: {} } });
  assert.equal(listed.status, 200);
  assert.ok(!JSON.stringify(listed.payload).includes(knowledgeText));
  assert.equal(modelCalls, 2);
});
