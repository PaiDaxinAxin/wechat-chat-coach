import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpServer, createHttpHandler } from '../src/mcp.mjs';
import { SOURCE_START, SOURCE_END } from '../src/knowledge.mjs';

const TOKEN = 'development-test-token-only-1234567890';
const context = {
  userProfile: '男生，风格直接但希望更会接话。',
  counterpartProfile: '交友软件认识，工作日较忙。',
  messages: [{ id: 'm1', speaker: 'other', text: '最近一直忙工作。' }],
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-coach-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const knowledge = `# Full private system\n${SOURCE_START}\n${'甲乙丙丁戊己庚辛壬癸'.repeat(100)}\n${SOURCE_END}\nAccepted supplement.\n`;
  const knowledgePath = join(directory, 'knowledge.md');
  const feedbackDir = join(directory, 'feedback', 'raw');
  await writeFile(knowledgePath, knowledge);
  return { directory, knowledge, knowledgePath, feedbackDir };
}

async function localClient(t, options) {
  const server = createMcpServer(options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function httpFixture(t, settings = {}) {
  const fixture_ = await fixture(t);
  const server = createServer(createHttpHandler({ token: TOKEN, mcpOptions: fixture_, ...settings }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  return { ...fixture_, endpoint, server };
}

test('owner SDK client lists owner tools and receives complete untruncated knowledge', async (t) => {
  const fixture_ = await fixture(t);
  const client = await localClient(t, { ...fixture_, mode: 'owner' });
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), ['coach_classify', 'coach_reply', 'feedback_submit', 'knowledge_append', 'knowledge_read']);
  const read = await client.callTool({ name: 'knowledge_read', arguments: {} });
  assert.equal(read.structuredContent.text, fixture_.knowledge);
  assert.deepEqual(Buffer.from(read.structuredContent.text), await readFile(fixture_.knowledgePath));
  const appended = await client.callTool({ name: 'knowledge_append', arguments: { expectedHash: read.structuredContent.hash, content: 'Reviewed owner supplement.' } });
  assert.equal(appended.structuredContent.appended, true);
});

test('restricted SDK client cannot discover or call owner knowledge tools or change startup mode', async (t) => {
  const fixture_ = await fixture(t);
  const client = await localClient(t, { ...fixture_, mode: 'restricted' });
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), ['coach_classify', 'coach_reply', 'feedback_submit']);
  await assert.rejects(client.callTool({ name: 'knowledge_read', arguments: {} }), /not found/);
  await assert.rejects(client.callTool({ name: 'grant_owner', arguments: { mode: 'owner' } }), /not found/);
  const badInput = await client.callTool({ name: 'coach_classify', arguments: { ...context, mode: 'owner', knowledgePath: '/private/knowledge' } });
  assert.equal(badInput.isError, true);
  assert.equal(client.getServerCapabilities().resources, undefined);
  assert.equal(client.getServerCapabilities().prompts, undefined);
});

test('restricted server sends full knowledge only to server-side model and blocks long excerpt output', async (t) => {
  const fixture_ = await fixture(t);
  let receivedKnowledge;
  const client = await localClient(t, {
    ...fixture_, mode: 'restricted',
    classifyFn: async (_input, options) => { receivedKnowledge = options.knowledgeText; return { suggestion: 'up', recommendationKind: 'uncalibrated' }; },
    replyFn: async (_input, options) => ({ reply: options.knowledgeText.slice(70, 270) }),
  });
  const classification = await client.callTool({ name: 'coach_classify', arguments: context });
  assert.equal(receivedKnowledge, fixture_.knowledge);
  assert.equal(classification.structuredContent.suggestion, 'up');
  const blocked = await client.callTool({ name: 'coach_reply', arguments: { context, direction: 'up' } });
  assert.equal(blocked.isError, true);
  assert.deepEqual(JSON.parse(blocked.content[0].text), { error: 'OUTPUT_KNOWLEDGE_EXCERPT_BLOCKED' });
  assert.ok(!JSON.stringify(blocked).includes(fixture_.knowledge.slice(70, 270)));
});

test('feedback tool isolates raw untrusted observations without modifying knowledge', async (t) => {
  const fixture_ = await fixture(t);
  const client = await localClient(t, { ...fixture_, mode: 'restricted' });
  const before = await readFile(fixture_.knowledgePath);
  const output = await client.callTool({ name: 'feedback_submit', arguments: {
    actualSentText: '你的手一定很好牵。', counterpartReply: '看来你牵过很多人的手。',
    observation: '需要结合上下文判断，单句可能调侃也可能警惕。', kind: 'uncertain',
  } });
  assert.equal(output.structuredContent.stage, 'raw_untrusted');
  assert.equal(output.structuredContent.validation, 'not_cleaned');
  const files = await readdir(fixture_.feedbackDir);
  const record = JSON.parse(await readFile(join(fixture_.feedbackDir, files[0]), 'utf8'));
  assert.equal(record.sourceMode, 'restricted');
  assert.equal(record.stage, 'raw_untrusted');
  assert.deepEqual(await readFile(fixture_.knowledgePath), before);
});

test('tool failures are sanitized and never return exception details', async (t) => {
  const fixture_ = await fixture(t);
  const client = await localClient(t, { ...fixture_, mode: 'restricted', replyFn: async () => { throw new Error('secret-token; /private/full-knowledge; raw provider payload'); } });
  const output = await client.callTool({ name: 'coach_reply', arguments: { context } });
  assert.deepEqual(JSON.parse(output.content[0].text), { error: 'OPERATION_FAILED' });
  assert.ok(!JSON.stringify(output).includes('secret-token'));
});

test('known provider HTTP errors expose only the safe category and integer status', async (t) => {
  const fixture_ = await fixture(t);
  const client = await localClient(t, { ...fixture_, mode: 'restricted', replyFn: async () => {
    const error = new Error('private upstream payload and API key');
    error.code = 'provider_http_error';
    error.status = 401;
    throw error;
  } });
  const output = await client.callTool({ name: 'coach_reply', arguments: { context } });
  assert.deepEqual(JSON.parse(output.content[0].text), { error: 'provider_http_error', status: 401 });
  assert.ok(!JSON.stringify(output).includes('private upstream'));
});

test('native submission errors retain their safe category through MCP', async (t) => {
  const fixture_ = await fixture(t);
  let code;
  const client = await localClient(t, { ...fixture_, mode: 'restricted', replyFn: async () => {
    const error = new Error('private provider payload');
    error.code = code;
    error.diagnostics = [{ code: 'private value must not pass through', path: [] }];
    throw error;
  } });
  for (code of ['missing_model_tool_call', 'multiple_model_tool_calls', 'invalid_model_tool_call', 'unexpected_model_tool_call']) {
    const output = await client.callTool({ name: 'coach_reply', arguments: { context } });
    assert.equal(output.isError, true);
    assert.deepEqual(JSON.parse(output.content[0].text), { error: code });
    assert.ok(!JSON.stringify(output).includes('private'));
  }
});

test('HTTP refuses unauthenticated requests before protocol metadata or model execution', async (t) => {
  let calls = 0;
  const fixture_ = await httpFixture(t, { mcpOptions: { classifyFn: async () => { calls++; return {}; } } });
  for (const endpoint of [fixture_.endpoint, fixture_.endpoint + '/metadata']) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
  }
  const wrong = await fetch(fixture_.endpoint, { headers: { authorization: 'Bearer wrong-token' } });
  assert.equal(wrong.status, 401);
  assert.equal(calls, 0);
});

test('HTTP SDK client sees restricted tools and server-side full knowledge', async (t) => {
  const fixture_ = await fixture(t);
  let received;
  const server = createServer(createHttpHandler({ token: TOKEN, mcpOptions: { ...fixture_, classifyFn: async (_input, options) => { received = options.knowledgeText; return { suggestion: 'up' }; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'http-test-client', version: '1.0.0' });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), ['coach_classify', 'coach_reply', 'feedback_submit']);
  const result = await client.callTool({ name: 'coach_classify', arguments: context });
  assert.equal(result.structuredContent.suggestion, 'up');
  assert.equal(received, fixture_.knowledge);
});

test('HTTP validates origins, limits authenticated requests, and bounds request bodies', async (t) => {
  const fixture_ = await httpFixture(t, { rateLimitPerMinute: 1, maxRequestBytes: 500 });
  const hostile = await fetch(fixture_.endpoint, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://example.invalid' } });
  assert.equal(hostile.status, 403);
  const large = await fetch(fixture_.endpoint, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ large: 'x'.repeat(600) }) });
  assert.equal(large.status, 413);
  const limited = await fetch(fixture_.endpoint, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
});

test('public bind requires explicit non-wildcard host and exact origin allowlists', () => {
  assert.throws(() => createHttpHandler({ token: TOKEN, host: '0.0.0.0' }), /PUBLIC_BIND_ALLOWLIST_REQUIRED/);
  assert.throws(() => createHttpHandler({ token: TOKEN, host: '0.0.0.0', allowedHosts: ['*'], allowedOrigins: ['https://example.com'] }), /PUBLIC_BIND_ALLOWLIST_REQUIRED/);
  assert.throws(() => createHttpHandler({ token: 'short' }), /REMOTE_TOKEN_INVALID/);
  assert.doesNotThrow(() => createHttpHandler({ token: TOKEN, host: '0.0.0.0', allowedHosts: ['mcp.example.com'], allowedOrigins: ['https://app.example.com'] }));
});
