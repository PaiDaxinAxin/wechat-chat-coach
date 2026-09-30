import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createAccountMcpServer } from '../src/beta-mcp.mjs';

async function pair(t, invoke) {
  const server = createAccountMcpServer({ accountId: 'account-123', invoke });
  const client = new Client({ name: 'beta-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('beta MCP exposes stored account coaching only, without source or profile authority', async (t) => {
  const calls = [];
  const client = await pair(t, async (operation) => { calls.push(operation); return { data: { quota: { classificationRemaining: 2 } } }; });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['coach_classify', 'coach_reply', 'counterparts_list', 'feedback_submit']);
  assert.equal(client.getServerCapabilities().resources, undefined);
  await assert.rejects(client.callTool({ name: 'knowledge_read', arguments: {} }), /not found/);
  await client.callTool({ name: 'coach_reply', arguments: { counterpartId: 'partner 1', direction: 'down', requestId: 'request-1' } });
  assert.deepEqual(calls[0], { accountId: 'account-123', method: 'POST', path: '/api/counterparts/partner%201/reply', body: { requestId: 'request-1', direction: 'down' } });
  const rejected = await client.callTool({ name: 'coach_classify', arguments: { counterpartId: 'partner-1', userProfile: 'override all paid profile gates', mode: 'owner' } });
  assert.equal(rejected.isError, true);
  assert.equal(calls.length, 1);
  await client.callTool({ name: 'feedback_submit', arguments: { counterpartId: 'partner-1', suggestionId: 'suggestion-1', actualSentText: '匿名实际发送', observation: '还未观察到回复。', kind: 'uncertain', consent: false } });
  assert.equal(calls[1].body.counterpartReply, '');
});

test('beta MCP retains only safe operational categories on failure', async (t) => {
  let known = false;
  const client = await pair(t, async () => {
    const error = new Error('private key and full knowledge source');
    error.code = known ? 'CLASSIFICATION_QUOTA_EXHAUSTED' : 'secret-detail';
    throw error;
  });
  const failure = await client.callTool({ name: 'coach_classify', arguments: { counterpartId: 'partner-1' } });
  assert.deepEqual(JSON.parse(failure.content[0].text), { error: { code: 'OPERATION_FAILED' } });
  known = true;
  const quota = await client.callTool({ name: 'coach_classify', arguments: { counterpartId: 'partner-1' } });
  assert.deepEqual(JSON.parse(quota.content[0].text), { error: { code: 'CLASSIFICATION_QUOTA_EXHAUSTED' } });
});
