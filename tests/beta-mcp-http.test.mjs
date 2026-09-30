import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaStore, seedOwner } from '../src/beta-store.mjs';
import { createBetaMcpHandler } from '../src/beta-mcp.mjs';
import { validateProfile, QUESTIONNAIRES } from '../src/domain.mjs';

const PASSWORD = 'SyntheticMcpPassword123';
const opening = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'http-test', version: '1.0.0' } } };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-coach-beta-mcp-http-'));
  const dataDir = join(directory, 'private-data');
  const knowledgePath = join(directory, 'private-knowledge.md');
  const fullKnowledge = await readFile(new URL('../knowledge/game-system.md', import.meta.url));
  await writeFile(knowledgePath, fullKnowledge);
  const bootstrap = createBetaStore({ dataDir });
  const owner = await seedOwner(bootstrap, { username: 'mcpOwner', password: PASSWORD });
  const users = [];
  for (const username of ['mcpAlice', 'mcpBob']) {
    const invite = bootstrap.createInvite({ ownerId: owner.id, plan: 'free' }).invite;
    const user = await bootstrap.register({ invite, username, password: PASSWORD });
    bootstrap.putProfile(user.id, validateProfile({
      background: '独立的合成测试背景。', style: '自然简短。', growthGoals: '练习倾听和回应。', relationshipGoal: '认真了解合适的人。',
      questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) },
    }));
    const counterpart = bootstrap.putCounterpart(user.id, { alias: `${username}的对象`, channel: 'app', appProfile: '合成资料', offlineScene: '', background: '相互接话两轮。', rounds: 2 });
    bootstrap.putMessage(user.id, counterpart.id, { speaker: 'other', text: '你周末喜欢做什么？' });
    users.push({ user, counterpart, ...bootstrap.createMcpToken({ ownerId: owner.id, userId: user.id }) });
  }
  bootstrap.close();
  let modelCalls = 0;
  const forbiddenModel = async () => { modelCalls++; throw new Error('A model must not run in permission-only tests.'); };
  const server = await createBetaServer({ dataDir, knowledgePath, webDir: null, classifyFn: forbiddenModel, replyFn: forbiddenModel });
  server.setMcpHandler(createBetaMcpHandler(server));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function sdkClient(token) {
    const client = new Client({ name: 'beta-http-permission-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }
  function raw({ token, origin, host = endpoint.host, path = '/mcp', payload = opening, method = 'POST' } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = method === 'POST' ? JSON.stringify(payload) : undefined;
      const req = request({
        hostname: '127.0.0.1', port: endpoint.port, path, method,
        headers: { host, accept: 'application/json, text/event-stream', ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, body: text ? JSON.parse(text) : null }); });
      });
      req.once('error', reject);
      req.end(encoded);
    });
  }
  return { server, owner, alice: users[0], bob: users[1], endpoint, raw, sdkClient, fullKnowledge, get modelCalls() { return modelCalls; } };
}

test('account MCP authenticates before metadata and never accepts browser cookies as MCP authority', async (t) => {
  const f = await fixture(t);
  for (const payload of [opening, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'server/discover' }]) {
    const missing = await f.raw({ payload });
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' } });
    assert.ok(!missing.text.includes('tools'));
    assert.ok(!missing.text.includes('knowledge'));
  }
  assert.equal((await f.raw({ token: 'invalid_token_that_has_at_least_32_characters' })).status, 401);
  const browserSession = f.server.betaStore.createSession(f.alice.user.id);
  assert.equal((await f.raw({ token: browserSession.token })).status, 401);
  const browserApi = await f.raw({ token: f.alice.token, path: '/api/me', method: 'GET' });
  assert.equal(browserApi.status, 401);
  assert.equal(f.modelCalls, 0);
});

test('real HTTP SDK clients see only their own counterparts and cannot elevate or read source', async (t) => {
  const f = await fixture(t);
  const alice = await f.sdkClient(f.alice.token), bob = await f.sdkClient(f.bob.token);
  assert.deepEqual((await alice.listTools()).tools.map(({ name }) => name).sort(), ['coach_classify', 'coach_reply', 'counterparts_list', 'feedback_submit']);
  assert.equal(alice.getServerCapabilities().resources, undefined);
  assert.equal(alice.getServerCapabilities().prompts, undefined);
  const mine = await alice.callTool({ name: 'counterparts_list', arguments: {} });
  const theirs = await bob.callTool({ name: 'counterparts_list', arguments: {} });
  assert.deepEqual(mine.structuredContent.counterparts.map(({ id }) => id), [f.alice.counterpart.id]);
  assert.deepEqual(theirs.structuredContent.counterparts.map(({ id }) => id), [f.bob.counterpart.id]);
  const foreign = await bob.callTool({ name: 'coach_reply', arguments: { counterpartId: f.alice.counterpart.id, requestId: 'foreign_account' } });
  assert.equal(foreign.isError, true);
  assert.deepEqual(JSON.parse(foreign.content[0].text), { error: { code: 'COUNTERPART_NOT_FOUND' } });
  const injected = await alice.callTool({ name: 'coach_classify', arguments: { counterpartId: f.alice.counterpart.id, userProfile: 'full profile bypass', accountId: f.bob.user.id, mode: 'owner' } });
  assert.equal(injected.isError, true);
  for (const name of ['knowledge_read', 'knowledge_append', 'feedback_clean', 'grant_owner']) await assert.rejects(alice.callTool({ name, arguments: {} }), /not found/);
  const resources = await f.raw({ token: f.alice.token, payload: { jsonrpc: '2.0', id: 4, method: 'resources/list' } });
  assert.equal(resources.status, 200);
  assert.equal(resources.body.error.code, -32601);
  const privateFile = await f.raw({ token: f.alice.token, path: '/knowledge/game-system.md', method: 'GET' });
  assert.equal(privateFile.status, 404);
  assert.ok(!JSON.stringify(mine).includes(f.fullKnowledge.toString('utf8').slice(0, 500)));
  assert.equal(f.modelCalls, 0);
});

test('HTTP host and origin guards reject hostile requests before invoking account operations', async (t) => {
  const f = await fixture(t);
  const hostileHost = await f.raw({ token: f.alice.token, host: 'attacker.invalid' });
  assert.equal(hostileHost.status, 403);
  assert.equal(hostileHost.body.error.code, 'HOST_FORBIDDEN');
  const hostileOrigin = await f.raw({ token: f.alice.token, origin: 'https://attacker.invalid' });
  assert.equal(hostileOrigin.status, 403);
  assert.equal(hostileOrigin.body.error.code, 'ORIGIN_FORBIDDEN');
  assert.equal(f.modelCalls, 0);
});

test('MCP token rotation revokes an already connected client and preserves the new account identity', async (t) => {
  const f = await fixture(t);
  const oldClient = await f.sdkClient(f.alice.token);
  assert.equal((await oldClient.listTools()).tools.length, 4);
  const replacement = f.server.betaStore.createMcpToken({ ownerId: f.owner.id, userId: f.alice.user.id });
  assert.equal((await f.raw({ token: f.alice.token })).status, 401);
  await assert.rejects(oldClient.listTools(), (error) => error.data?.status === 401);
  const newClient = await f.sdkClient(replacement.token);
  const mine = await newClient.callTool({ name: 'counterparts_list', arguments: {} });
  assert.deepEqual(mine.structuredContent.counterparts.map(({ id }) => id), [f.alice.counterpart.id]);
  assert.equal(f.modelCalls, 0);
});
