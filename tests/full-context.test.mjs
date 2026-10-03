import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildChatContext, QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';
import { classifyChat, generateReply } from '../src/coach.mjs';
import { generateFieldCoachPlan } from '../src/field-coach.mjs';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaStore, seedOwner } from '../src/beta-store.mjs';
import { createAccountMcpServer } from '../src/beta-mcp.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { DEFAULT_KNOWLEDGE_PATH, SOURCE_START, SOURCE_END, createKnowledgeStore } from '../src/knowledge.mjs';
import { archiveKnowledgeVersion } from '../src/case-snapshot.mjs';

const env = { AGNES_API_KEY: 'synthetic-no-network', AGNES_BASE_URL: 'http://127.0.0.1:9999/v1' };
const profile = {
  background: '虚构成年用户，29岁，设计师，杭州，刚换了轮班工作。',
  style: '简短直接，偶尔开轻松玩笑。', growthGoals: '学习表达好感并尊重不同节奏。',
  relationshipGoal: '与有共同意愿的成年人发展亲密关系，也愿意了解是否适合恋爱。',
  questionnaire: { kind: 'full', answers: Object.fromEntries(QUESTIONNAIRES.full.map(({ id }, i) => [id, i % 5 + 1])) },
};
const counterpart = {
  alias: '虚构成年对象', channel: 'app', appProfile: '28岁，护士，轮班；资料写喜欢徒步。',
  offlineScene: '', background: '三周前在交友软件因徒步照片开始聊，还没见面；曾明确拒绝去家里。', rounds: 16,
};
const meeting = { status: 'confirmed', time: '周六下午三点', place: '市中心咖啡馆', note: '双方已确认公共场所见面。' };

function longMessages() {
  const messages = Array.from({ length: 320 }, (_, index) => ({
    id: `long-${index}`, speaker: index % 2 ? 'self' : 'other', text: `第${index}条：继续讨论这周的日常安排。`,
    provenance: 'user_entered', recordedAt: new Date(Date.UTC(2026, 8, 1) + index * 3_600_000).toISOString(),
  }));
  messages[0].text = '先说清楚，我不接受去家里，见面只去公共场所。';
  messages[1].text = '明白，就选方便的公共场所。';
  messages[24].text = '我今天夜班，可能隔半天才看消息，不是一直拿着手机。';
  messages[24].annotation = { text: '线下她也提过会轮夜班，这是我的补充，不是这条消息的原文。', source: 'user_annotation', updatedAt: '2026-09-20T08:00:00.000Z' };
  messages[24].annotationRevision = 1;
  messages[24].annotationUpdatedAt = messages[24].annotation.updatedAt;
  // Clearing a note removes its content but retains causal edit identity.
  messages[25].annotationRevision = 2;
  messages[25].annotationUpdatedAt = '2026-09-20T08:01:00.000Z';
  messages[121].text = '你安排徒步路线很细心，这点挺吸引我。';
  messages[122].text = '谢谢你记得，我也想听听你的旅行经历。';
  messages[240].text = '最近我会主动想起你，但我还没确定自己是否要谈恋爱。';
  messages[300].text = '周六下午三点咖啡馆见，可以呀。';
  messages[318].text = '哈哈';
  messages[319].text = '🙂';
  messages[319].speaker = 'other';
  messages[122].wechatTime = { at: '2026-09-06T01:30:00.000Z', source: 'user_reported', editedAt: messages[122].recordedAt };
  messages[122].replyInterval = {
    fromAt: messages[121].recordedAt, toAt: messages[122].recordedAt, elapsedMs: 3_600_000,
    fromSource: 'clipboard_copied', toSource: 'counterpart_text_recorded',
    reliability: 'app_interval_estimate', interpretation: 'not_verified_wechat_latency',
  };
  return messages;
}

function classification(context) {
  const first = context.messages[0].id, interest = context.messages[240].id, agreed = context.messages[300].id;
  const unknown = { level: 'unknown', evidenceIds: [] };
  return {
    status: 'ready', confidence: 'moderate', phase: 'ordinary', contextUpdates: { facts: [], meeting: null },
    workingFocus: { stage: 'security', reason: '落实已确认安排。', evidenceIds: [agreed] },
    topicDecision: { mode: 'stay', reason: '见面安排已确认，当前可以自然收尾。' },
    obstacle: { type: 'negative', evidenceIds: [first], reason: '此前拒绝私人场所的边界仍然有效。' },
    heat: {
      activeInteraction: { level: 'positive', evidenceIds: [interest] }, responseEngagement: unknown,
      personalInterest: { level: 'positive', evidenceIds: [interest] }, reciprocalFlirting: unknown,
      actionFollowThrough: { level: 'positive', evidenceIds: [agreed] },
    },
    options: [],
    uncertainties: ['有见面意愿不代表已确定恋爱，也不表示同意进一步亲密。'], recommendationKind: 'uncalibrated',
    fieldCoach: { currentTopic: '见面安排后的自然收尾', topicStatus: 'closing', topicMessageIds: [agreed, context.messages.at(-1).id], initiative: '保留已确认的公共场所安排。', nextAction: '暂时留白，临近见面再确认。', warmingLayer: 'none', reason: '完整记录仍包含未撤回的边界。' },
  };
}
const reply = { contextUpdates: { facts: [], meeting: null }, workingFocus: { stage: 'unknown', reason: '以实际安排为准。', evidenceIds: [] }, reply: '', action: 'wait', reason: '安排已确认，可以自然结束这个话题。', styleNote: '保留简洁表达。', guidance: { topicMove: null, relationMove: 'wait', ownWordsGuide: '先不发送，保留自然留白。', reentryWhen: '临近已确认的见面时再确认。' } };
const plan = (context) => ({ verdict: 'suitable', reason: '公共场所见面符合之前的边界。', timingSuggestion: { status: 'wait', guidance: '临近已约好的见面时再确认。', evidenceIds: [context.messages[300].id] }, nextAction: '先按当前安排，留意新的实际变化。' });

function response(value) {
  return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'submit_coaching_result', arguments: JSON.stringify(value) } }] } }] }) };
}

function assertFullContext(actual, expectedMessages, expectedCounterpart = counterpart) {
  assert.deepEqual(actual.messages, expectedMessages);
  const user = JSON.parse(actual.userProfile), other = JSON.parse(actual.counterpartProfile);
  assert.equal(user.background, profile.background);
  assert.equal(user.relationshipGoal, profile.relationshipGoal);
  assert.equal(user.questionnaire.answers.length, 30);
  for (const answer of user.questionnaire.answers) assert.equal(answer.answer, profile.questionnaire.answers[answer.id]);
  for (const key of ['alias', 'channel', 'appProfile', 'offlineScene', 'background']) assert.equal(other[key], expectedCounterpart[key]);
  assert.equal(other.previousRounds, expectedCounterpart.rounds);
  assert.deepEqual(other.meeting, meeting);
  assert.equal(other.recordedContext.messageCount, expectedMessages.length);
  assert.equal(other.recordedContext.firstMessageId, expectedMessages[0].id);
  assert.equal(other.recordedContext.lastMessageId, expectedMessages.at(-1).id);
  assert.equal(other.recordedContext.completeWechatHistoryVerified, false);
}

test('classify, reply and field coach transmit all 320 messages, sourced annotations, background, timing and exact full knowledge', async () => {
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  let calls = 0;
  for (const other of [counterpart, { ...counterpart, channel: 'offline', appProfile: '', offlineScene: '朋友组织徒步时认识，当面聊了四十分钟；此后才开始微信聊天。' }]) {
    const messages = longMessages();
    const context = buildChatContext(validateProfile(profile, 'paid'), other, messages, { meeting });
    const verify = (expectedInput, output) => async (_url, request) => {
      calls++;
      const body = JSON.parse(request.body);
      assert.ok(body.messages[1].content === knowledgeText, 'the exact complete private knowledge is transmitted');
      const sent = JSON.parse(body.messages[2].content.split('本轮输入数据：\n')[1]);
      assert.deepEqual(sent, expectedInput);
      assertFullContext(sent.context ?? sent, messages, other);
      assert.match(body.messages[0].content, /全部已保存聊天/);
      assert.match(body.messages[0].content, /性吸引、信任、恋爱意愿分别看待/);
      return response(output);
    };
    await classifyChat(context, { knowledgeText, env, fetchImpl: verify(context, classification(context)) });
    await generateReply({ context, direction: 'sideways' }, { knowledgeText, env, fetchImpl: verify({ context, direction: 'sideways' }, reply) });
    const input = { context, plan: '先保留公共场所的约定，临近见面再确认。' };
    await generateFieldCoachPlan(input, { knowledgeText, env, fetchImpl: verify(input, plan(context)) });
  }
  assert.equal(calls, 6);
});

test('missing background and unrecorded history remain unknown instead of manufactured zero interest', () => {
  const messages = longMessages();
  const context = buildChatContext(profile, { ...counterpart, background: '' }, messages, { meeting });
  const decoded = JSON.parse(context.counterpartProfile);
  assert.equal(decoded.background, '');
  assert.deepEqual(decoded.recordedContext.missingBackground, ['relationship_background']);
  assert.equal(decoded.recordedContext.completeWechatHistoryVerified, false);
  assert.match(decoded.unknownsRule, /unknown, not zero interest/);
  assert.deepEqual(context.messages, messages);
});

test('saved full history reaches web API and account MCP without drafts, raw feedback or another counterpart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coach-full-context-'));
  const knowledgePath = join(directory, 'knowledge.md');
  const knowledgeText = `# Isolated knowledge\n${SOURCE_START}\n${'独立机械测试原文。'.repeat(500)}\n${SOURCE_END}\nTail preserved.\n`;
  await writeFile(knowledgePath, knowledgeText);
  const store = createBetaStore({ dataDir: join(directory, 'data') });
  let server, client, mcpServer;
  t.after(async () => {
    await client?.close(); await mcpServer?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  const password = 'SyntheticOnlyPassword123';
  const owner = await seedOwner(store, { username: 'contextowner', password });
  store.putProfile(owner.id, validateProfile(profile, 'paid'));
  const saved = store.putCounterpart(owner.id, counterpart);
  for (const message of longMessages()) store.putMessage(owner.id, saved.id, { speaker: message.speaker, text: message.text });
  store.putMeeting(owner.id, saved.id, meeting);
  const unrelated = store.putCounterpart(owner.id, { ...counterpart, alias: '完全不同的人' });
  store.putMessage(owner.id, unrelated.id, { speaker: 'other', text: 'OTHER_COUNTERPART_MUST_NEVER_APPEAR' });
  const fullMessages = store.listMessages(owner.id, saved.id);
  let expectedMessages = fullMessages, calls = 0;
  function capture(context, options) {
    calls++;
    assertFullContext(context, expectedMessages.map(({ id, speaker, text, provenance, recordedAt, wechatTime, replyInterval }) => ({ id, speaker, text, provenance, recordedAt, wechatTime, replyInterval })));
    assert.ok(options.knowledgeText === knowledgeText);
    assert.doesNotMatch(JSON.stringify(context), /RAW_FEEDBACK_MUST_NEVER_APPEAR|OTHER_COUNTERPART_MUST_NEVER_APPEAR|DRAFT_MUST_NEVER_APPEAR/);
  }
  server = await createBetaServer({ store, ownsStore: false, storeKnowledge: createKnowledgeStore({ knowledgePath }), archiveKnowledge: (snapshot) => archiveKnowledgeVersion(join(directory, 'archive'), snapshot), webDir: null,
    classifyFn: async (context, options) => { capture(context, options); return classification(context); },
    replyFn: async ({ context }, options) => { capture(context, options); return { ...reply, reply: 'DRAFT_MUST_NEVER_APPEAR', action: 'reply' }; },
    planFn: async ({ context }, options) => { capture(context, options); return plan(context); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'contextowner', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], { data: { csrfToken } } = await login.json();
  async function post(action, body) {
    const result = await fetch(`${origin}/api/counterparts/${saved.id}/${action}`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const output = await result.json();
    assert.equal(result.status, 200, JSON.stringify(output.error));
    return output.data;
  }
  await post('classify', { requestId: 'full_web_classify' });
  const generated = await post('reply', { requestId: 'full_web_reply' });
  store.addFeedback(owner.id, saved.id, { suggestionId: generated.suggestion.id, actualSentText: '', counterpartReply: '', observation: 'RAW_FEEDBACK_MUST_NEVER_APPEAR', kind: 'positive', consent: true });
  await post('coach-plan', { requestId: 'full_web_plan', plan: '保持约定，临近见面再确认。' });
  store.putMessage(owner.id, saved.id, { speaker: 'other', text: '新增实际记录，原边界仍然有效。' });
  expectedMessages = store.listMessages(owner.id, saved.id);
  mcpServer = createAccountMcpServer({ accountId: owner.id, invoke: (request) => server.invokeForAccount(request) });
  client = new Client({ name: 'full-history-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport); await client.connect(clientTransport);
  for (const name of ['coach_classify', 'coach_reply']) {
    const result = await client.callTool({ name, arguments: { counterpartId: saved.id, requestId: `full_mcp_${name}` } });
    assert.notEqual(result.isError, true);
  }
  assert.equal(calls, 5);
});

test('stateless owner and legacy restricted MCP preserve all supplied context but claim no missing history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coach-full-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const knowledgePath = join(directory, 'knowledge.md');
  await writeFile(knowledgePath, `# Fixture\n${SOURCE_START}\n${'原文'.repeat(100)}\n${SOURCE_END}\n`);
  const messages = longMessages(), context = buildChatContext(profile, counterpart, messages, { meeting });
  for (const mode of ['owner', 'restricted']) {
    let captured;
    const server = createMcpServer({ mode, knowledgePath, classifyFn: async (input) => { captured = input; return classification(input); } });
    const client = new Client({ name: `context-${mode}`, version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const result = await client.callTool({ name: 'coach_classify', arguments: context });
      assert.notEqual(result.isError, true);
      assertFullContext(captured, messages);
    } finally { await client.close(); await server.close(); }
  }
});
