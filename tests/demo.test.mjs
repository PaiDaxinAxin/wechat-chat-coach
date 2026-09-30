import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';
import { assertLocalDemoRequest } from '../src/demo.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-coach-local-demo-'));
  const knowledgePath = join(directory, 'knowledge.md');
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  await writeFile(knowledgePath, knowledgeText);
  let modelCalls = 0;
  const noModel = async () => { modelCalls++; throw new Error('Unexpected model invocation'); };
  const settings = { dataDir: join(directory, 'demo'), knowledgePath, webDir: null, localDemoMode: true, classifyFn: noModel, replyFn: noModel, ...options };
  let server;
  async function start() { server = await createBetaServer(settings); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); }
  await start();
  async function stop() { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } }
  t.after(async () => { await stop(); await rm(directory, { force: true, recursive: true }); });
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, input, { cookie, csrf, headers = {} } = {}) {
    const response = await fetch(origin() + path, { method, headers: { origin: origin(), ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, ...(await response.json()), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { directory, knowledgePath, knowledgeText, call, origin, get server() { return server; }, get modelCalls() { return modelCalls; }, async restart() { await stop(); await start(); } };
}

test('local demo creates one fixed synthetic account and complete saved context without any model call', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('GET', '/api/meta')).data.localDemo, { enabled: true, synthetic: true });
  const results = await Promise.all(Array.from({ length: 5 }, () => f.call('POST', '/api/demo/session', {})));
  for (const result of results) { assert.equal(result.status, 200); assert.equal(result.data.synthetic, true); assert.ok(result.data.csrfToken); assert.ok(result.cookie); }
  assert.equal(new Set(results.map((result) => result.data.user.id)).size, 1);
  assert.equal(new Set(results.map((result) => result.data.counterpartId)).size, 1);
  const session = results[0];
  const headers = { cookie: session.cookie, csrf: session.data.csrfToken };
  const me = await f.call('GET', '/api/me', undefined, headers);
  assert.equal(Object.keys(me.data.profile.questionnaire.answers).length, 10);
  assert.match(me.data.profile.background, /虚构/);
  const detail = await f.call('GET', `/api/counterparts/${session.data.counterpartId}`, undefined, headers);
  assert.equal(detail.data.messages.length, 4); assert.match(detail.data.messages[1].text, /忙工作/);
  assert.equal(detail.data.classification, null); assert.equal(detail.data.suggestions.length, 0);
  const receipt = JSON.parse(await readFile(join(f.directory, 'demo/demo-seed.json'), 'utf8'));
  assert.equal(receipt.userId, session.data.user.id); assert.equal(receipt.password, undefined);
  assert.equal((await stat(join(f.directory, 'demo/demo-seed.json'))).mode & 0o777, 0o600);
  assert.equal(f.modelCalls, 0); assert.equal(await readFile(f.knowledgePath, 'utf8'), f.knowledgeText);
});

test('demo bootstrap refuses caller identities, cross-origin, proxy headers and all nonlocal sockets', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('POST', '/api/demo/session', { userId: 'someone', role: 'owner' })).status, 400);
  assert.equal((await f.call('POST', '/api/demo/session', {}, { headers: { origin: 'https://foreign.example' } })).status, 403);
  for (const [name, value] of [['forwarded', 'for=127.0.0.1'], ['x-forwarded-for', '127.0.0.1'], ['x-forwarded-host', 'localhost'], ['x-forwarded-proto', 'http'], ['x-real-ip', '127.0.0.1'], ['via', 'demo-proxy']]) {
    const denied = await f.call('POST', '/api/demo/session', {}, { headers: { [name]: value } });
    assert.equal(denied.status, 403); assert.equal(denied.error.code, 'DEMO_LOOPBACK_REQUIRED');
  }
  for (const address of ['203.0.113.1', '10.0.0.2', '::ffff:192.168.1.5', undefined]) assert.throws(() => assertLocalDemoRequest({ socket: { remoteAddress: address }, headers: {} }), { code: 'DEMO_LOOPBACK_REQUIRED', status: 403 });
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.doesNotThrow(() => assertLocalDemoRequest({ socket: { remoteAddress: address }, headers: {} }));
  const hostAttack = await new Promise((resolve, reject) => {
    const req = request(`${f.origin()}/api/demo/session`, { method: 'POST', headers: { host: 'foreign.example', origin: f.origin(), 'content-type': 'application/json' } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end('{}');
  });
  assert.equal(hostAttack, 403); assert.equal(f.modelCalls, 0);
});

test('demo endpoints stay unavailable in ordinary beta and cannot be enabled with a nonlocal public origin', async (t) => {
  await assert.rejects(createBetaServer({ webDir: null, localDemoMode: true, publicOrigin: 'https://demo.example' }), { code: 'DEMO_LOOPBACK_REQUIRED' });
  const f = await fixture(t, { localDemoMode: false });
  assert.deepEqual((await f.call('GET', '/api/meta')).data.localDemo, { enabled: false, synthetic: false });
  assert.equal((await f.call('POST', '/api/demo/session', {})).status, 404);
  assert.equal((await f.call('GET', '/api/demo/session')).status, 404);
  await assert.rejects(f.server.ensureDemoSeed(), { code: 'NOT_FOUND' });
  assert.equal(f.modelCalls, 0);
});

test('demo retains edited profile, messages and objects on session replay and restart, and does not restore deletions', async (t) => {
  const f = await fixture(t);
  const initial = await f.call('POST', '/api/demo/session', {});
  const { user, counterpartId, csrfToken } = initial.data;
  const headers = { cookie: initial.cookie, csrf: csrfToken };
  const profile = (await f.call('GET', '/api/me', undefined, headers)).data.profile;
  const { updatedAt, questionnaireVersion, questionnaireHypotheses, ...input } = profile;
  assert.equal((await f.call('PUT', '/api/profile', { ...input, style: '演示中自己修改的风格。' }, headers)).status, 200);
  const detail = (await f.call('GET', `/api/counterparts/${counterpartId}`, undefined, headers)).data;
  await f.call('PUT', `/api/counterparts/${counterpartId}/messages/${detail.messages[0].id}`, { speaker: 'self', text: '演示中自己修改的开头。' }, headers);
  const { id, revision, createdAt, updatedAt: counterpartUpdatedAt, ...counterpartInput } = detail.counterpart;
  await f.call('PUT', `/api/counterparts/${counterpartId}`, { ...counterpartInput, alias: '自己修改的名字' }, headers);
  await f.restart();
  const replay = await f.call('POST', '/api/demo/session', {});
  assert.equal(replay.data.user.id, user.id); assert.equal(replay.data.counterpartId, counterpartId);
  const repeated = { cookie: replay.cookie, csrf: replay.data.csrfToken };
  assert.equal((await f.call('GET', '/api/me', undefined, repeated)).data.profile.style, '演示中自己修改的风格。');
  const persisted = (await f.call('GET', `/api/counterparts/${counterpartId}`, undefined, repeated)).data;
  assert.equal(persisted.messages.length, 4); assert.equal(persisted.messages[0].text, '演示中自己修改的开头。'); assert.equal(persisted.counterpart.alias, '自己修改的名字');
  await f.call('DELETE', `/api/counterparts/${counterpartId}`, {}, repeated);
  assert.equal((await f.call('POST', '/api/demo/session', {})).data.counterpartId, null);
  await f.restart();
  const deleted = await f.call('POST', '/api/demo/session', {});
  assert.equal(deleted.data.counterpartId, null); assert.equal(f.server.betaStore.listCounterparts(user.id).length, 0);
  assert.equal(f.modelCalls, 0);
});

test('demo uses normal CSRF controls, blocks admin and MCP, and isolates raw feedback from knowledge', async (t) => {
  const f = await fixture(t);
  const session = await f.call('POST', '/api/demo/session', {});
  const { counterpartId, user } = session.data;
  const headers = { cookie: session.cookie, csrf: session.data.csrfToken };
  assert.equal((await f.call('POST', `/api/counterparts/${counterpartId}/messages`, { speaker: 'other', text: '新的虚构消息' }, { cookie: session.cookie })).status, 403);
  assert.equal((await f.call('GET', '/api/me')).status, 401);
  for (const path of ['/api/admin/feedback', '/api/admin/users']) assert.equal((await f.call('GET', path, undefined, headers)).status, 404);
  assert.equal((await f.call('POST', '/api/admin/invites', { plan: 'paid' }, headers)).status, 404);
  for (const path of ['/api/login', '/api/register']) assert.equal((await f.call('POST', path, {}, headers)).status, 404);
  let mcpCalls = 0;
  f.server.setMcpHandler(async (_req, res) => { mcpCalls++; res.end('{}'); });
  assert.equal((await f.call('POST', '/mcp', {}, headers)).status, 404); assert.equal(mcpCalls, 0);
  // Store a synthetic suggestion receipt locally to exercise feedback without a provider call.
  const reservation = f.server.betaStore.reserveJob({ userId: user.id, counterpartId, operation: 'reply', requestId: 'demo_feedback_fixture', contextHash: 'synthetic', knowledgeHash: 'synthetic', workerId: 'fixture', providerModel: 'fixture' });
  f.server.betaStore.markJobRunning(reservation.job.id);
  const suggestion = { id: 'demo-suggestion', reply: '周末有空再聊。', knowledgeHash: 'synthetic', contextHash: 'synthetic' };
  f.server.betaStore.completeJob(reservation.job.id, { suggestion }, suggestion);
  const submitted = await f.call('POST', `/api/counterparts/${counterpartId}/feedback`, { suggestionId: suggestion.id, actualSentText: suggestion.reply, counterpartReply: '好呀。', observation: '纯虚构反馈。', kind: 'positive', consent: true }, headers);
  assert.equal(submitted.status, 200); assert.equal(submitted.data.stage, 'raw_untrusted');
  assert.equal((await f.call('POST', `/api/admin/feedback/${submitted.data.id}/clean`, {}, headers)).status, 404);
  assert.equal(await readFile(f.knowledgePath, 'utf8'), f.knowledgeText); assert.equal(f.modelCalls, 0);
});
