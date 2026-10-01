import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaMcpHandler } from '../src/beta-mcp.mjs';
import { createBetaStore, seedOwner } from '../src/beta-store.mjs';
import { QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';

const password = 'SyntheticAsyncPassword123';
const profile = { background: 'Synthetic personal background.', style: 'Brief and natural.', growthGoals: 'Listen before asking.', relationshipGoal: 'Learn about each other.', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) } };
const counterpart = { alias: 'Synthetic counterpart', channel: 'app', appProfile: 'Synthetic interests.', offlineScene: '', background: 'Two introductory exchanges.', rounds: 2 };
const opening = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'async-test', version: '1.0.0' } } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, { replyFn } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'beta-async-store-'));
  const base = createBetaStore({ dataDir: join(directory, 'fixture') });
  const owner = await seedOwner(base, { username: 'async-owner', password });
  base.putProfile(owner.id, validateProfile(profile, owner.plan));
  const person = base.putCounterpart(owner.id, counterpart);
  base.putMessage(owner.id, person.id, { speaker: 'other', text: 'What are you working on this week?' });
  const text = '# Synthetic private knowledge\n' + 'Complete context must remain private. '.repeat(80);
  const snapshot = { text, hash: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
  const calls = [], reservations = [], rateWindows = new Map(), denyKeys = new Set();
  const scope = new AsyncLocalStorage();
  let recoveries = 0, closes = 0, closed = false, replies = 0, archives = 0;
  const store = new Proxy(base, { get(target, key) {
    if (key === 'withSnapshot' || key === 'withTransaction') return async (callback) => {
      if (scope.getStore()) return await callback(store);
      const kind = key === 'withSnapshot' ? 'snapshot' : 'transaction';
      calls.push([key, kind]);
      return await scope.run(kind, () => callback(store));
    };
    if (key === 'recoverAbandonedJobs') return async () => { throw new Error('External jobs must never be blanket-recovered.'); };
    if (key === 'recoverExpiredJobs') return async () => { await tick(); recoveries++; return 0; };
    if (key === 'takeRateLimit') return async ({ key: rateKey, limit, windowMs }) => {
      await tick(); calls.push(['takeRateLimit', rateKey, limit, windowMs]);
      const count = (rateWindows.get(rateKey) || 0) + 1; rateWindows.set(rateKey, count);
      return { allowed: !denyKeys.has(rateKey) && count <= limit, remaining: Math.max(0, limit - count), resetAt: Date.now() + windowMs };
    };
    if (key === 'close') return async () => { await tick(); closes++; if (!closed) { base.close(); closed = true; } };
    const value = target[key];
    if (typeof value !== 'function') return value;
    return async (...args) => { await tick(); calls.push([key, scope.getStore()]); if (key === 'reserveJob') reservations.push(args[0]); if (key === 'completeJob') assert.equal(scope.getStore(), 'transaction'); return await value.apply(target, args); };
  } });
  const servers = [];
  async function server(options = {}) {
    const instance = await createBetaServer({ store, dataDir: join(directory, 'must-not-exist'), knowledgePath: '/missing/private/knowledge.md',
      storeKnowledge: { read: async () => { await tick(); return snapshot; } },
      archiveKnowledge: async (value) => { await tick(); assert.equal(scope.getStore(), undefined); assert.deepEqual(value, snapshot); archives++; return { hash: value.hash, bytes: value.bytes, sourceRevision: 'game-3.3', version: 'synthetic-version', archived: true }; },
      replyFn: async (input, settings) => { replies++; assert.equal(scope.getStore(), undefined); assert.equal(settings.knowledgeText, text); return replyFn ? await replyFn(input, settings) : { reply: 'Tell me more about that project.', reason: 'Follow the current topic.', action: 'reply', styleNote: 'Keep it brief.' }; },
      ...options });
    servers.push(instance); await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve)); return instance;
  }
  function client(instance) {
    const origin = `http://127.0.0.1:${instance.address().port}`;
    return { cookie: '', csrf: '', async call(method, path, input, headers = {}) {
      const response = await fetch(origin + path, { method, headers: { origin, cookie: this.cookie, 'x-csrf-token': this.csrf, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      const payload = await response.json();
      if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
      if (payload.data?.csrfToken) this.csrf = payload.data.csrfToken;
      return { status: response.status, ...payload };
    } };
  }
  t.after(async () => {
    for (const instance of servers) { if (instance.listening) { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); } await instance.storeClosed; }
    if (!closed) base.close(); await rm(directory, { recursive: true, force: true });
  });
  return { directory, base, store, owner, person, calls, reservations, denyKeys, server, client,
    get recoveries() { return recoveries; }, get closes() { return closes; }, get replies() { return replies; }, get archives() { return archives; } };
}

test('external async store awaits HTTP values, private projections and mutations without local initialization', async (t) => {
  const f = await fixture(t); const server = await f.server({ workerId: 'async-worker-one' }); const client = f.client(server);
  assert.equal(server.betaStore, f.store); assert.equal(f.recoveries, 0);
  await assert.rejects(access(join(f.directory, 'must-not-exist')), { code: 'ENOENT' });
  assert.equal((await client.call('POST', '/api/login', { username: 'async-owner', password })).status, 200);
  const me = await client.call('GET', '/api/me'); assert.equal(me.data.profile.background, profile.background); assert.equal(typeof me.data.quota, 'object');
  assert.equal((await client.call('PUT', '/api/profile', profile)).status, 200);
  const created = await client.call('POST', '/api/counterparts', { ...counterpart, alias: 'Another synthetic person' }); const id = created.data.counterpart.id;
  assert.equal(created.status, 200); assert.equal((await client.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: 'How was your weekend?' })).status, 200);
  const generated = await client.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'async-reply-request', direction: 'down' }); assert.equal(generated.status, 200); assert.equal(typeof generated.data.suggestion.id, 'string');
  const detail = await client.call('GET', `/api/counterparts/${id}`); assert.equal(detail.status, 200); assert.deepEqual(detail.data.currentSuggestionIds, [generated.data.suggestion.id]); assert.equal(detail.data.messages.length, 1); assert.equal(detail.data.jobs.length, 1);
  assert.equal(JSON.stringify(detail.data).includes('modelInput'), false); assert.equal(JSON.stringify(detail.data).includes('Complete context must remain private.'), false);
  const listed = await client.call('GET', '/api/counterparts'); assert.equal(listed.data.counterparts.length, 2); assert.equal((await client.call('GET', '/api/admin/users')).data.users[0].id, f.owner.id);
  assert.equal((await client.call('PUT', `/api/counterparts/${id}/meeting`, { status: 'none', time: '', place: '', note: '' })).status, 200);
  assert.equal((await client.call('POST', '/api/logout', {})).status, 200); assert.equal((await client.call('GET', '/api/me')).status, 401);
  assert.equal(f.recoveries, 1); assert.equal(f.reservations[0].workerId, 'async-worker-one'); assert.equal(f.archives, 1); assert.equal(f.replies, 1);
  assert.ok(f.calls.some(([method, kind]) => method === 'getProfile' && kind === 'snapshot'));
  assert.ok(f.calls.some(([method, kind]) => method === 'getCounterpart' && kind === 'snapshot'));
  assert.ok(f.calls.some(([method, kind]) => method === 'listMessages' && kind === 'transaction'));
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await server.storeClosed; assert.equal(f.closes, 0);
});

test('separate instances coordinate pending and cached model work through the async store', async (t) => {
  let release, entered; const started = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { replyFn: async () => { entered(); await gate; return { reply: 'Tell me more about your work.', reason: 'Follow the topic.', action: 'reply' }; } });
  const first = await f.server({ workerId: 'first-worker' }), second = await f.server({ workerId: 'second-worker' });
  const initialProviderRemaining = f.base.quota(f.owner.id).providerRemaining;
  const operation = (requestId) => ({ accountId: f.owner.id, method: 'POST', path: `/api/counterparts/${f.person.id}/reply`, body: { requestId, direction: 'down' } });
  const pending = first.invokeForAccount(operation('async-held-request')); await started;
  try { await assert.rejects(second.invokeForAccount(operation('async-other-request')), { code: 'JOB_IN_PROGRESS', status: 409 }); }
  finally { release(); }
  const result = await pending; const replay = await second.invokeForAccount(operation('async-other-request'));
  assert.equal(replay.data.cached, true); assert.equal(replay.data.suggestion.id, result.data.suggestion.id); assert.equal(f.replies, 1);
  assert.equal(f.base.quota(f.owner.id).providerRemaining, initialProviderRemaining - 1);
});

test('async account MCP auth and rate limits are shared across instances, with local demo still unavailable', async (t) => {
  const f = await fixture(t); const first = await f.server(), second = await f.server();
  const { token } = f.base.createMcpToken({ ownerId: f.owner.id, userId: f.owner.id });
  for (const server of [first, second]) server.setMcpHandler(createBetaMcpHandler(server, { rateLimitPerMinute: 1 }));
  const request = (server, bearer = token) => fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(opening) });
  assert.equal((await request(first)).status, 200); assert.equal((await request(second)).status, 429);
  assert.equal((await request(second, 'x'.repeat(43))).status, 401);
  assert.ok(f.calls.some(([method, key]) => method === 'takeRateLimit' && key === `mcp:${f.owner.id}`));
  const http = f.client(first); assert.equal((await http.call('POST', '/api/demo/session', {})).status, 404);
  f.denyKeys.add('auth:127.0.0.1'); assert.equal((await http.call('POST', '/api/login', { username: 'async-owner', password })).status, 429);
});

test('injected store ownership is explicit and missing cloud dependencies fail before filesystem access', async (t) => {
  const f = await fixture(t); const server = await f.server({ ownsStore: true });
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await server.storeClosed; assert.equal(f.closes, 1);
  await assert.rejects(createBetaServer({ store: {}, dataDir: '/missing/no-write' }), { code: 'STORE_CONFIGURATION_INVALID' });
  await assert.rejects(f.server({ localDemoMode: true }), { code: 'DEMO_LOCAL_STORE_REQUIRED' });
});

test('cloud API module import never loads node:sqlite through indirect helpers', () => {
  const url = new URL('../src/beta-api.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `import {registerHooks} from 'node:module'; registerHooks({resolve(name,context,next){if(name==='node:sqlite')throw new Error('SQLite must stay local');return next(name,context);}}); await import(${JSON.stringify(url)});`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
