import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createAccountMcpServer } from '../src/beta-mcp.mjs';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaStore, seedOwner } from '../src/beta-store.mjs';
import { QUESTIONNAIRES } from '../src/domain.mjs';
import { SOURCE_START, SOURCE_END } from '../src/knowledge.mjs';

const PASSWORD = 'SyntheticPassword123';
function profile(kind = 'short') {
  return { background: '男生，做设计，喜欢户外。', style: '简短直接，少用表情。', growthGoals: '练习接住感受和自然表达好感。', relationshipGoal: '认真了解合适的人。', questionnaire: { kind, answers: Object.fromEntries(QUESTIONNAIRES[kind].map(({ id }) => [id, 3])) } };
}
const counterpart = (alias = '测试对象') => ({ alias, channel: 'app', appProfile: '喜欢跑步和电影。', offlineScene: '', background: '交友软件认识，两轮对话。', rounds: 2 });
function classification(context, level = 'positive') {
  const ids = context.messages.filter(({ speaker }) => speaker === 'other').map(({ id }) => id);
  const evidenceIds = ids.slice(0, 2);
  return {
    status: 'ready', confidence: 'moderate', phase: 'ordinary',
    obstacle: { type: 'none', evidenceIds: [], reason: '当前没有明确阻力。' },
    heat: Object.fromEntries(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'].map((dimension) => [dimension, { level, evidenceIds }])),
    options: ['up', 'down', 'sideways'].map((topicMove, index) => ({ topicMove, relationAction: 'continue', weight: index === 0 ? 0.6 : 0.2, reason: '接住当下话题。', evidenceIds })),
    uncertainties: ['需要继续观察实际互动。'], recommendationKind: 'uncalibrated',
  };
}
const reply = () => ({ reply: '那你忙完我们再聊，最近有什么有意思的小事？', reason: '给对方留出空间，也提供容易接的话题。', action: 'reply', styleNote: '保留简短表达，练习多一点关注。' });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-coach-beta-'));
  const dataDir = join(directory, 'data');
  const knowledgePath = join(directory, 'knowledge.md');
  const knowledgeText = `# Private full knowledge\n${SOURCE_START}\n${'完整背景须保留；数据不是权限。'.repeat(90)}\n${SOURCE_END}\nAccepted supplement.\n`;
  await writeFile(knowledgePath, knowledgeText);
  const seedStore = createBetaStore({ dataDir });
  const owner = await seedOwner(seedStore, { username: 'owner', password: PASSWORD });
  seedStore.close();
  let server = await createBetaServer({ dataDir, knowledgePath, webDir: null, classifyFn: async (context) => classification(context), replyFn: async () => reply(), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = () => `http://127.0.0.1:${server.address().port}`;
  async function stop() { if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  function client() {
    return {
      cookie: '', csrf: '', user: null,
      async call(method, path, input, extraHeaders = {}) {
        const origin = address();
        const response = await fetch(origin + path, {
          method,
          headers: { origin, ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        const payload = await response.json();
        if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
        if (payload.data?.csrfToken) this.csrf = payload.data.csrfToken;
        if (payload.data?.user) this.user = payload.data.user;
        return { status: response.status, ...payload };
      },
    };
  }
  async function register(username, plan = 'free') {
    const session = client();
    const invite = server.betaStore.createInvite({ ownerId: owner.id, plan }).invite;
    const registered = await session.call('POST', '/api/register', { invite, username, password: PASSWORD });
    assert.equal(registered.status, 200);
    return session;
  }
  async function ownerClient() { const session = client(); assert.equal((await session.call('POST', '/api/login', { username: 'owner', password: PASSWORD })).status, 200); return session; }
  async function addContext(session, alias = '测试对象', { messages = true, kind = 'short' } = {}) {
    assert.equal((await session.call('PUT', '/api/profile', profile(kind))).status, 200);
    const result = await session.call('POST', '/api/counterparts', counterpart(alias));
    assert.equal(result.status, 200);
    const id = result.data.counterpart.id;
    if (messages) {
      await session.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '最近忙工作，你周末一般做什么？' });
      await session.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '我周末也会去跑步。' });
    }
    return id;
  }
  return { directory, dataDir, knowledgePath, knowledgeText, owner, get server() { return server; }, address, register, ownerClient, client, addContext, stop, async restart() { await stop(); server = await createBetaServer({ dataDir, knowledgePath, webDir: null, classifyFn: async (context) => classification(context), replyFn: async () => reply(), ...options }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); } };
}

test('invite registration, sessions, CSRF and account isolation protect all private objects', async (t) => {
  const f = await fixture(t);
  const alice = await f.register('甲用户'), bob = await f.register('乙用户');
  const aliceId = await f.addContext(alice);
  const other = await bob.call('GET', `/api/counterparts/${aliceId}`);
  assert.equal(other.status, 404);
  assert.equal((await bob.call('DELETE', `/api/counterparts/${aliceId}`, {})).status, 404);
  assert.equal((await bob.call('GET', '/api/admin/feedback')).status, 403);
  const noCsrf = await alice.call('POST', `/api/counterparts/${aliceId}/messages`, { speaker: 'other', text: 'hi' }, { 'x-csrf-token': 'wrong' });
  assert.equal(noCsrf.status, 403);
  const crossOrigin = await alice.call('PUT', '/api/profile', profile(), { origin: 'https://attacker.invalid' });
  assert.equal(crossOrigin.status, 403);
  const invite = f.server.betaStore.createInvite({ ownerId: f.owner.id, plan: 'free' }).invite;
  const unauthorizedRole = await f.client().call('POST', '/api/register', { invite, username: 'RoleUser', password: PASSWORD, role: 'owner', plan: 'paid' });
  assert.equal(unauthorizedRole.status, 400);
  assert.equal((await f.client().call('POST', '/api/register', { invite, username: 'firstUse', password: PASSWORD })).status, 200);
  assert.equal((await f.client().call('POST', '/api/register', { invite, username: 'reuseInvite', password: PASSWORD })).status, 400);
  assert.equal((await alice.call('POST', '/api/logout', {})).status, 200);
  assert.equal((await alice.call('GET', '/api/me')).status, 401);
});

test('successful same-context and request replay persist across restart without additional calls', async (t) => {
  let calls = 0, receivedKnowledge;
  const f = await fixture(t, { classifyFn: async (context, options) => { calls++; receivedKnowledge = options.knowledgeText; return classification(context); } });
  const user = await f.register('replayUser');
  const id = await f.addContext(user);
  const first = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'request_one' });
  assert.equal(first.status, 200); assert.equal(first.data.cached, false); assert.equal(first.data.quota.classificationRemaining, 2);
  assert.equal(receivedKnowledge, f.knowledgeText);
  const replay = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'request_two' });
  assert.equal(replay.status, 200); assert.equal(replay.data.cached, true); assert.equal(calls, 1);
  await f.restart();
  const restored = await user.call('GET', `/api/counterparts/${id}`);
  assert.equal(restored.status, 200); assert.equal(restored.data.classification.knowledgeHash, first.data.classification.knowledgeHash);
  assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'request_one' })).data.cached, true);
  assert.equal(calls, 1);
  await user.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '又有一条新消息。' });
  assert.equal((await user.call('GET', `/api/counterparts/${id}`)).data.classification, null);
  const conflict = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'request_one' });
  assert.equal(conflict.status, 409); assert.equal(conflict.error.code, 'REQUEST_ID_CONTEXT_CONFLICT');
});

test('first-message ranges rehydrate legacy cache consistently across detail, list, replay and account MCP without another model call', async (t) => {
  let calls = 0;
  const f = await fixture(t, { classifyFn: async (context) => {
    calls++;
    const value = classification(context); value.confidence = 'limited';
    value.heat = Object.fromEntries(Object.keys(value.heat).map((name) => [name, { level: 'unknown', evidenceIds: [] }]));
    value.heat.responseEngagement = { level: 'passive', evidenceIds: [context.messages[0].id] };
    return value;
  } });
  const user = await f.register('preliminaryRangeUser');
  const id = await f.addContext(user, '首句虚构对象', { messages: false });
  await user.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '你好' });
  assert.equal((await user.call('GET', `/api/counterparts/${id}`)).data.heat.preliminaryRange, null);
  assert.equal(calls, 0, 'Unanalyzed records are not assigned an invented range');
  const first = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'preliminary_first' });
  const expected = first.data.heat.preliminaryRange;
  assert.deepEqual([expected.lower, expected.upper, expected.label], [10, 45, '偏低投入']);
  assert.equal(first.data.heat.score, null); assert.equal(first.data.quota.classificationRemaining, 2);
  const source = f.server.betaStore.listJobs(user.user.id, id).find(({ operation }) => operation === 'classify');
  const old = structuredClone(source.result); delete old.heat.preliminaryRange;
  old.heat.ruleVersion = 'provisional-five-dimensions-2';
  old.heat.trend = { status: 'rising', comparableDimensions: ['activeInteraction', 'responseEngagement'], delta: 10 };
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try { db.prepare('UPDATE model_jobs SET result_json=? WHERE id=?').run(JSON.stringify(old), source.id); }
  finally { db.close(); }
  const detail = (await user.call('GET', `/api/counterparts/${id}`)).data;
  assert.deepEqual(detail.heat.preliminaryRange, expected); assert.deepEqual(detail.heat.trend, old.heat.trend);
  assert.equal(detail.heat.observedAt, old.heat.observedAt);
  const list = (await user.call('GET', '/api/counterparts')).data;
  assert.deepEqual(list.counterparts[0].heat.preliminaryRange, expected); assert.deepEqual(list.topThree, []);
  const replay = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'preliminary_replay' });
  assert.equal(replay.data.cached, true); assert.deepEqual(replay.data.heat.preliminaryRange, expected);
  assert.deepEqual(f.server.betaStore.listJobs(user.user.id, id).find(({ id: jobId }) => jobId === source.id).result, old, 'Readback decorates output without rewriting the original model observation');
  const mcp = createAccountMcpServer({ accountId: user.user.id, invoke: f.server.invokeForAccount });
  const client = new Client({ name: 'preliminary-range-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await mcp.close(); });
  const mcpResult = await client.callTool({ name: 'coach_classify', arguments: { counterpartId: id, requestId: 'preliminary_mcp' } });
  assert.equal(mcpResult.isError, undefined);
  assert.deepEqual(JSON.parse(mcpResult.content[0].text).heat.preliminaryRange, expected);
  assert.equal(calls, 1); assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 2);
});

test('concurrent free classifications reserve only three trials and exhausted users can generate directly', async (t) => {
  let calls = 0, resolveCalls;
  const gate = new Promise((resolve) => { resolveCalls = resolve; });
  const f = await fixture(t, { classifyFn: async (context) => { calls++; await gate; return classification(context); } });
  const user = await f.register('concurrentUser');
  const ids = [];
  for (let index = 0; index < 4; index++) ids.push(await f.addContext(user, `对象${index}`));
  const requests = ids.map((id, index) => user.call('POST', `/api/counterparts/${id}/classify`, { requestId: `classify_${index}` }));
  for (let index = 0; index < 100 && calls < 3; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 3);
  const during = await user.call('GET', '/api/me');
  assert.equal(during.data.quota.classificationRemaining, 0);
  resolveCalls();
  const results = await Promise.all(requests);
  assert.equal(results.filter(({ status }) => status === 200).length, 3);
  assert.equal(results.filter(({ error }) => error?.code === 'CLASSIFICATION_QUOTA_EXHAUSTED').length, 1);
  assert.equal((await user.call('POST', `/api/counterparts/${ids[3]}/reply`, { requestId: 'direct_reply' })).status, 200);
  assert.equal(calls, 3);
});

test('concurrent identical contexts have one persistent job charge and durable request aliases', async (t) => {
  let calls = 0, unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const f = await fixture(t, { classifyFn: async (context) => { calls++; await gate; return classification(context); } });
  const user = await f.register('sameConcurrent');
  const id = await f.addContext(user);
  const requests = ['alias_request_a', 'alias_request_b'].map((requestId) => user.call('POST', `/api/counterparts/${id}/classify`, { requestId }));
  for (let index = 0; index < 100 && f.server.betaStore.listJobs(user.user.id, id).length < 2; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  unblock();
  const results = await Promise.all(requests);
  assert.equal(results.filter(({ data }) => data.cached).length, 1);
  assert.equal((await user.call('GET', '/api/me')).data.quota.classificationRemaining, 2);
  await f.restart();
  assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'alias_request_b' })).data.cached, true);
  assert.equal(calls, 1);
  await user.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '改变了上下文。' });
  assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'alias_request_b' })).error.code, 'REQUEST_ID_CONTEXT_CONFLICT');
});

test('failures release classification trials but daily attempted-call budgets remain bounded', async (t) => {
  let calls = 0;
  const f = await fixture(t, { freeProviderDailyLimit: 2, classifyFn: async (context) => { calls++; if (calls === 1) { const error = new Error('private raw payload secret'); error.code = 'provider_http_error'; error.status = 401; throw error; } return classification(context); } });
  const user = await f.register('failureUser');
  const id = await f.addContext(user);
  const failed = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'failure_one' });
  assert.equal(failed.status, 502); assert.equal(failed.error.code, 'PROVIDER_HTTP_401'); assert.ok(!JSON.stringify(failed).includes('private raw payload'));
  const afterFailure = await user.call('GET', '/api/me');
  assert.equal(afterFailure.data.quota.classificationRemaining, 3); assert.equal(afterFailure.data.quota.providerRemaining, 1);
  assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'failure_one' })).status, 409);
  assert.equal(calls, 1);
  assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'success_two' })).status, 200);
  const noBudget = await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'reply_blocked' });
  assert.equal(noBudget.error.code, 'PROVIDER_BUDGET_EXHAUSTED'); assert.equal(calls, 2);
  const detail = await user.call('GET', `/api/counterparts/${id}`);
  assert.ok(detail.data.jobs.some(({ errorCode, state }) => state === 'failed' && errorCode === 'PROVIDER_HTTP_401'));
});

test('empty or self-only context and paid downgrade never consume classification calls', async (t) => {
  let calls = 0;
  const f = await fixture(t, { classifyFn: async (context) => { calls++; return classification(context); } });
  const user = await f.register('emptyUser');
  const id = await f.addContext(user, '无对方消息', { messages: false });
  assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'empty_context' })).error.code, 'CONTEXT_REQUIRED');
  await user.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'self', text: '你好。' });
  assert.equal((await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'self_only_context' })).error.code, 'CONTEXT_REQUIRED');
  assert.equal((await user.call('GET', '/api/me')).data.quota.providerRemaining, 10);
  assert.equal((await user.call('PUT', '/api/profile', profile('full'))).status, 403);
  const paid = await f.register('paidUser', 'paid');
  const paidId = await f.addContext(paid, '付费画像', { kind: 'full' });
  const owner = await f.ownerClient();
  await owner.call('PUT', `/api/admin/users/${paid.user.id}/plan`, { plan: 'free' });
  const downgraded = await paid.call('GET', '/api/me');
  assert.equal(downgraded.data.profile.requiresQuestionnaireUpdate, true);
  assert.equal(downgraded.data.profile.questionnaire.kind, 'short');
  assert.deepEqual(downgraded.data.profile.questionnaire.answers, {});
  assert.equal((await paid.call('POST', `/api/counterparts/${paidId}/classify`, { requestId: 'downgraded_attempt' })).error.code, 'FULL_PROFILE_REQUIRES_UPDATE');
  assert.equal(calls, 0);
});

test('manual sent records, feedback cleaning/review and knowledge receipts preserve source and avoid duplicate appends', async (t) => {
  const f = await fixture(t);
  const user = await f.register('feedbackUser');
  const id = await f.addContext(user);
  const generated = await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'feedback_reply' });
  const suggestionId = generated.data.suggestion.id;
  const actualSentText = '我们周末聊跑步吧，我电话13800138000。';
  await user.call('POST', `/api/counterparts/${id}/sent`, { suggestionId, actualSentText });
  const feedback = { suggestionId, actualSentText, counterpartReply: '好呀，我想见你聊聊。', observation: '对方主动回应了见面，仍然只是用户观察。', kind: 'positive', consent: true };
  const submitted = await user.call('POST', `/api/counterparts/${id}/feedback`, feedback);
  assert.equal(submitted.data.stage, 'raw_untrusted');
  assert.equal(await readFile(f.knowledgePath, 'utf8'), f.knowledgeText);
  const owner = await f.ownerClient();
  const cleaning = await owner.call('POST', `/api/admin/feedback/${submitted.data.id}/clean`, {});
  assert.equal(cleaning.status, 200); assert.equal(cleaning.data.feedback.cleaning.stage, 'clean_candidate');
  assert.ok(!cleaning.data.feedback.cleaning.cleaned.actualSentText.includes('13800138000'));
  const review = { decision: 'approve', purpose: 'knowledge', conditions: '已有双向主动回应时。', limits: '只是一条观察，不足以证明因果。', note: '保留实际发送与用户报告的区别。' };
  const approved = await owner.call('POST', `/api/admin/feedback/${submitted.data.id}/review`, review);
  assert.equal(approved.status, 200); assert.equal(approved.data.feedback.review.stage, 'approved_candidate');
  const text = await readFile(f.knowledgePath, 'utf8');
  assert.ok(text.startsWith(f.knowledgeText)); assert.ok(!text.includes('13800138000'));
  assert.equal(text.split(`<!-- FEEDBACK_APPROVAL:${submitted.data.id} -->`).length, 2);
  assert.equal((await owner.call('POST', `/api/admin/feedback/${submitted.data.id}/review`, review)).status, 200);
  assert.equal(await readFile(f.knowledgePath, 'utf8'), text);
  const duplicate = await user.call('POST', `/api/counterparts/${id}/feedback`, { ...feedback, kind: 'uncertain', observation: '改标签也不能重复计观察。' });
  const duplicateClean = await owner.call('POST', `/api/admin/feedback/${duplicate.data.id}/clean`, {});
  assert.equal(duplicateClean.data.feedback.cleaning.stage, 'quarantined');
  assert.ok(duplicateClean.data.feedback.cleaning.flags.includes('duplicate_submission'));
  await user.call('DELETE', `/api/counterparts/${id}`, {});
  assert.equal((await user.call('GET', `/api/counterparts/${id}`)).status, 404);
  assert.equal((await owner.call('GET', '/api/admin/feedback')).data.feedback.length, 0);
});

test('context changes during a call release trials, stale heat invalidates, and later actual observations have trends', async (t) => {
  let calls = 0, unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const f = await fixture(t, { classifyFn: async (context) => { calls++; if (calls === 1) await gate; return classification(context, calls < 3 ? 'passive' : 'repeated_positive'); } });
  const user = await f.register('staleContextUser');
  const id = await f.addContext(user);
  const waiting = user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'stale_context' });
  for (let index = 0; index < 100 && !calls; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  await user.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '补充了背景。' });
  unblock();
  assert.equal((await waiting).error.code, 'CONTEXT_CHANGED');
  assert.equal((await user.call('GET', '/api/me')).data.quota.classificationRemaining, 3);
  const baseline = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'baseline_context' });
  assert.equal(baseline.status, 200);
  for (let index = 0; index < 32; index++) assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: `replay_observation_${index}` })).data.cached, true);
  await user.call('POST', `/api/counterparts/${id}/messages`, { speaker: 'other', text: '我想约个时间见见你。' });
  const warmer = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'warmer_context' });
  assert.equal(warmer.data.heat.trend.status, 'rising');
  await user.call('PUT', '/api/profile', { ...profile(), growthGoals: '更新个人成长目标。' });
  assert.equal((await user.call('GET', `/api/counterparts/${id}`)).data.classification, null);
});

test('edited sent records cannot become confirmed feedback until explicitly confirmed again', async (t) => {
  const f = await fixture(t);
  const user = await f.register('editedSentUser'), owner = await f.ownerClient();
  const id = await f.addContext(user);
  const suggestionId = (await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'editable_reply' })).data.suggestion.id;
  const firstText = '我们聊聊最近跑步的事吧。', editedText = '周末一起走走，怎么样？';
  const sent = await user.call('POST', `/api/counterparts/${id}/sent`, { suggestionId, actualSentText: firstText });
  const baseFeedback = { suggestionId, actualSentText: firstText, counterpartReply: '好呀，我想见你。', observation: '一次用户报告的积极回应。', kind: 'positive', consent: true };
  const first = await user.call('POST', `/api/counterparts/${id}/feedback`, baseFeedback);
  await owner.call('POST', `/api/admin/feedback/${first.data.id}/clean`, {});
  await user.call('PUT', `/api/counterparts/${id}/messages/${sent.data.message.id}`, { speaker: 'self', text: editedText });
  const review = { decision: 'approve', purpose: 'knowledge', conditions: '双向积极回应时。', limits: '仅有一次自述观察。', note: '' };
  const outdated = await owner.call('POST', `/api/admin/feedback/${first.data.id}/review`, review);
  assert.equal(outdated.error.code, 'FEEDBACK_SOURCE_CHANGED');
  const second = await user.call('POST', `/api/counterparts/${id}/feedback`, { ...baseFeedback, actualSentText: editedText });
  const unconfirmed = await owner.call('POST', `/api/admin/feedback/${second.data.id}/clean`, {});
  assert.equal(unconfirmed.data.feedback.cleaning.stage, 'quarantined');
  assert.ok(unconfirmed.data.feedback.cleaning.missing.includes('actual_sent_record'));
  await user.call('POST', `/api/counterparts/${id}/sent`, { suggestionId, actualSentText: editedText });
  assert.equal((await owner.call('POST', `/api/admin/feedback/${second.data.id}/clean`, {})).data.feedback.cleaning.stage, 'clean_candidate');
  assert.equal((await owner.call('POST', `/api/admin/feedback/${second.data.id}/review`, review)).status, 200);
});

test('approval recovery after file append and database interruption commits one receipt without reappending', async (t) => {
  const f = await fixture(t);
  const user = await f.register('approvalRecovery'), owner = await f.ownerClient();
  const id = await f.addContext(user);
  const suggestionId = (await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'approval_recovery' })).data.suggestion.id;
  const actualSentText = '周末一起跑步怎么样？';
  await user.call('POST', `/api/counterparts/${id}/sent`, { suggestionId, actualSentText });
  const submitted = await user.call('POST', `/api/counterparts/${id}/feedback`, { suggestionId, actualSentText, counterpartReply: '好呀，想见你。', observation: '用户自述一次邀请积极回应。', kind: 'positive', consent: true });
  const feedbackId = submitted.data.id;
  await owner.call('POST', `/api/admin/feedback/${feedbackId}/clean`, {});
  const finish = f.server.betaStore.finishKnowledgeApproval.bind(f.server.betaStore);
  f.server.betaStore.finishKnowledgeApproval = () => { throw new Error('Synthetic interruption after atomic file append.'); };
  const review = { decision: 'approve', purpose: 'knowledge', conditions: '有明确双向互动时。', limits: '不证明因果，不推广为通用规则。', note: '' };
  assert.equal((await owner.call('POST', `/api/admin/feedback/${feedbackId}/review`, review)).status, 500);
  const afterAppend = await readFile(f.knowledgePath, 'utf8');
  assert.equal(afterAppend.split(`<!-- FEEDBACK_APPROVAL:${feedbackId} -->`).length, 2);
  f.server.betaStore.finishKnowledgeApproval = finish;
  assert.equal((await owner.call('POST', `/api/admin/feedback/${feedbackId}/review`, review)).status, 200);
  assert.equal(await readFile(f.knowledgePath, 'utf8'), afterAppend);
});

test('daily account and global provider budgets reset by UTC day without resetting lifetime classification trials', async (t) => {
  let time = Date.parse('2026-09-30T12:00:00Z');
  const f = await fixture(t, { now: () => time, globalProviderDailyLimit: 2 });
  const alice = await f.register('dailyAlice'), bob = await f.register('dailyBob');
  const aliceId = await f.addContext(alice), bobId = await f.addContext(bob);
  assert.equal((await alice.call('POST', `/api/counterparts/${aliceId}/classify`, { requestId: 'daily_alice' })).status, 200);
  assert.equal((await bob.call('POST', `/api/counterparts/${bobId}/classify`, { requestId: 'daily_bob' })).status, 200);
  assert.equal((await alice.call('POST', `/api/counterparts/${aliceId}/reply`, { requestId: 'global_exhausted' })).error.code, 'PROVIDER_BUDGET_EXHAUSTED');
  assert.equal((await bob.call('GET', '/api/me')).data.quota.providerRemaining, 0);
  time += 86400_000;
  const reset = await alice.call('GET', '/api/me');
  assert.equal(reset.data.quota.classificationRemaining, 2);
  assert.equal(reset.data.quota.providerRemaining, 2);
});

test('meeting state is validated, enters complete context, and invalidates old judgments; empty DELETE bodies work', async (t) => {
  let received;
  const f = await fixture(t, { classifyFn: async (context) => { received = JSON.parse(context.counterpartProfile); return classification(context); } });
  const user = await f.register('meetingUser');
  const id = await f.addContext(user);
  await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'meeting_before' });
  assert.equal((await user.call('PUT', `/api/counterparts/${id}/meeting`, { status: 'confirmed', time: '', place: '', note: '' })).status, 400);
  await user.call('PUT', `/api/counterparts/${id}/meeting`, { status: 'confirmed', time: '周六下午两点', place: '公园北门', note: '双方确认。' });
  assert.equal((await user.call('GET', `/api/counterparts/${id}`)).data.classification, null);
  await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'meeting_after' });
  assert.equal(received.meeting.status, 'confirmed');
  assert.equal(received.meeting.place, '公园北门');
  const detail = await user.call('GET', `/api/counterparts/${id}`);
  assert.equal((await user.call('DELETE', `/api/counterparts/${id}/messages/${detail.data.messages[0].id}`)).status, 200);
  assert.equal((await user.call('DELETE', `/api/counterparts/${id}`)).status, 200);
});

test('CLI stores do not interrupt active jobs; restart recovers durable abandoned jobs without resending', async (t) => {
  const f = await fixture(t);
  const user = await f.register('restartUser');
  const id = await f.addContext(user);
  const job = f.server.betaStore.reserveJob({ userId: user.user.id, counterpartId: id, operation: 'classify', requestId: 'simulated_interrupted', contextHash: 'context_hash', knowledgeHash: 'knowledge_hash', workerId: 'old_worker', providerModel: 'synthetic' }).job;
  f.server.betaStore.markJobRunning(job.id);
  const cli = createBetaStore({ dataDir: f.dataDir });
  assert.equal(cli.listJobs(user.user.id, id)[0].state, 'running');
  cli.close();
  await f.restart();
  const me = await user.call('GET', '/api/me');
  assert.equal(me.data.quota.classificationRemaining, 3);
  assert.equal(me.data.quota.providerRemaining, 9);
  assert.ok((await user.call('GET', `/api/counterparts/${id}`)).data.jobs.some(({ state, errorCode }) => state === 'failed' && errorCode === 'JOB_INTERRUPTED'));
});

test('deleting an object during a provider call releases reservations and cannot recreate private data', async (t) => {
  let calls = 0, unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const f = await fixture(t, { classifyFn: async (context) => { calls++; await gate; return classification(context); } });
  const user = await f.register('deleteDuringCall');
  const id = await f.addContext(user);
  const request = user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'delete_during_call' });
  for (let index = 0; index < 100 && !calls; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await user.call('DELETE', `/api/counterparts/${id}`)).status, 200);
  assert.equal((await user.call('GET', '/api/me')).data.quota.classificationRemaining, 3);
  unblock();
  assert.equal((await request).error.code, 'COUNTERPART_NOT_FOUND');
  assert.equal((await user.call('GET', '/api/counterparts')).data.counterparts.length, 0);
  assert.equal((await user.call('GET', `/api/counterparts/${id}`)).status, 404);
});

test('model output cannot expose long private excerpts and account MCP token only permits owned scoped actions', async (t) => {
  let knowledge;
  const f = await fixture(t, { replyFn: async (_input, options) => { knowledge = options.knowledgeText; return { ...reply(), reply: options.knowledgeText.slice(60, 260) }; } });
  const user = await f.register('mcpUser'), other = await f.register('otherMcpUser');
  const id = await f.addContext(user);
  const blocked = await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'private_excerpt' });
  assert.equal(blocked.error.code, 'OUTPUT_KNOWLEDGE_EXCERPT_BLOCKED');
  assert.ok(!JSON.stringify(blocked).includes(knowledge.slice(60, 260)));
  const issued = f.server.betaStore.createMcpToken({ ownerId: f.owner.id, userId: user.user.id });
  assert.equal(f.server.betaStore.lookupMcpToken(issued.token).id, user.user.id);
  const fresh = f.server.betaStore.createMcpToken({ ownerId: f.owner.id, userId: user.user.id });
  assert.equal(f.server.betaStore.lookupMcpToken(issued.token), null);
  assert.equal(f.server.betaStore.lookupMcpToken(fresh.token).id, user.user.id);
  await assert.rejects(f.server.invokeForAccount({ accountId: other.user.id, method: 'GET', path: `/api/counterparts/${id}` }), { code: 'COUNTERPART_NOT_FOUND' });
  await assert.rejects(f.server.invokeForAccount({ accountId: user.user.id, method: 'GET', path: '/api/admin/users' }), { code: 'MCP_OPERATION_FORBIDDEN' });
});

test('owner bootstrap is create-only and does not silently change an existing password', async (t) => {
  const f = await fixture(t);
  await assert.rejects(seedOwner(f.server.betaStore, { username: 'owner', password: 'NewPassword456' }), { code: 'OWNER_ALREADY_EXISTS' });
  assert.equal((await f.ownerClient()).user.role, 'owner');
});

test('explicit IPv6 loopback HTTP origin is accepted while remote plaintext origins remain rejected', async (t) => {
  const f = await fixture(t, { publicOrigin: 'http://[::1]:8788' });
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: f.server.address().port, path: '/api/health', headers: { host: '[::1]:8788', origin: 'http://[::1]:8788' } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.once('error', reject); req.end();
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { data: { service: 'wechat-chat-coach', version: '0.2.0' } });
  await assert.rejects(createBetaServer({ webDir: null, publicOrigin: 'http://remote.invalid' }), { code: 'PUBLIC_ORIGIN_INVALID' });
});

test('two processes recovering a dead server receipt cannot both become service owner', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await f.stop();
  await writeFile(join(f.dataDir, 'server.lock'), JSON.stringify({ pid: 2_000_000_000, workerId: 'dead-worker', createdAt: '2000-01-01T00:00:00Z' }));
  const script = `import { createBetaServer } from ${JSON.stringify(new URL('../src/beta-api.mjs', import.meta.url).href)};
const [dataDir, knowledgePath] = process.argv.slice(1);
try { const server = await createBetaServer({dataDir,knowledgePath,webDir:null});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); process.stdout.write('started\\n');
process.stdin.once('data',()=>server.close(()=>process.exit(0))); }
catch(error) { process.stdout.write(error.code + '\\n'); }`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, f.dataDir, f.knowledgePath], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const closed = children.map((child) => new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))));
  t.after(() => children.forEach((child) => { if (!child.killed) child.kill(); }));
  const result = await Promise.all(children.map((child) => new Promise((resolve, reject) => { child.stdout.once('data', (chunk) => resolve(chunk.toString().trim())); child.once('error', reject); })));
  assert.equal(result.filter((value) => value === 'started').length, 1);
  assert.ok(result.some((value) => ['SERVICE_ALREADY_RUNNING', 'SERVICE_LOCK_UNVERIFIED'].includes(value)), JSON.stringify(result));
  // The rejected contender may have exited already. Only the running winner
  // owns a server to stop; observing close up front avoids missing its exit.
  const winner = result.indexOf('started');
  children[winner].stdin.end('stop');
  const exits = await Promise.all(closed);
  assert.deepEqual(exits[winner], { code: 0, signal: null });
});

test('message annotations preserve original facts, enter immutable context, and edit/clear invalidate copied pending replies', async (t) => {
  let clock = Date.parse('2026-10-01T10:00:00Z'), calls = 0, captured;
  const f = await fixture(t, { now: () => clock, replyFn: async ({ context }) => { calls++; captured = context; return reply(); } });
  const user = await f.register('annotationUser', 'paid'), stranger = await f.register('annotationStranger');
  const id = await f.addContext(user), messages = f.server.betaStore.listMessages(user.user.id, id), original = messages[0];
  const path = `/api/counterparts/${id}/messages/${original.id}/annotation`;
  const generated = await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'annotation_initial' });
  assert.equal(generated.status, 200);
  const sourceId = generated.data.suggestion.id;
  const immutable = f.server.betaStore.getSuggestionCase(user.user.id, id, sourceId);
  await user.call('POST', `/api/counterparts/${id}/suggestions/${sourceId}/copied`, { requestId: 'annotation_old_copy' });
  const annotated = await user.call('PATCH', path, { annotationText: '线下她笑着说的；这是我的背景补充，不是微信原话。🙂' });
  assert.equal(annotated.status, 200); assert.equal(calls, 1);
  const { annotation, annotationRevision, annotationUpdatedAt, ...facts } = annotated.data.message;
  assert.deepEqual(facts, original);
  assert.equal(annotation.source, 'user_annotation'); assert.equal(annotationRevision, 1);
  assert.equal(annotation.updatedAt, annotationUpdatedAt);
  assert.equal((await stranger.call('PATCH', path, { annotationText: '越权修改' })).status, 404);
  assert.equal((await user.call('PATCH', path, { annotationText: '字'.repeat(5001) })).status, 400);
  assert.equal((await user.call('PATCH', path, { annotationText: '改原话', text: '伪造发送' })).status, 400);
  const revision = f.server.betaStore.getCounterpart(user.user.id, id).revision;
  assert.equal((await user.call('PATCH', path, { annotationText: annotation.text })).data.message.annotationRevision, 1);
  assert.equal(f.server.betaStore.getCounterpart(user.user.id, id).revision, revision);
  let detail = (await user.call('GET', `/api/counterparts/${id}`)).data;
  assert.equal(detail.suggestions.find(({ id: suggestionId }) => suggestionId === sourceId).pendingEligible, false);
  assert.ok(!detail.currentSuggestionIds.includes(sourceId));
  const withNote = await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'annotation_with_note' });
  assert.equal(withNote.status, 200);
  assert.deepEqual(captured.messages[0].annotation, annotation);
  assert.equal(captured.messages[0].annotationRevision, 1);
  assert.equal(captured.messages[0].annotationUpdatedAt, annotationUpdatedAt);
  assert.equal(withNote.data.suggestion.pendingEligible, true, 'a same-millisecond new case captures the new annotation revision');
  await user.call('POST', `/api/counterparts/${id}/suggestions/${withNote.data.suggestion.id}/copied`, { requestId: 'annotation_new_copy' });
  const cleared = await user.call('PATCH', path, { annotationText: '' });
  assert.equal(cleared.status, 200); assert.equal(cleared.data.message.annotation, undefined);
  assert.equal(cleared.data.message.annotationRevision, 2);
  assert.equal(cleared.data.message.annotationUpdatedAt, annotationUpdatedAt, 'same-clock revisions remain distinct without rewriting original timestamps');
  detail = (await user.call('GET', `/api/counterparts/${id}`)).data;
  for (const suggestion of detail.suggestions) assert.equal(suggestion.pendingEligible, false);
  assert.deepEqual(detail.currentSuggestionIds, []);
  const afterClear = await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'annotation_after_clear' });
  assert.equal(afterClear.status, 200); assert.equal(afterClear.data.cached, false);
  assert.equal(captured.messages[0].annotationRevision, 2); assert.equal(captured.messages[0].annotation, undefined);
  assert.deepEqual(f.server.betaStore.getSuggestionCase(user.user.id, id, sourceId).snapshot, immutable.snapshot);
  const stale = await user.call('POST', `/api/counterparts/${id}/followup`, { requestId: 'annotation_stale_followup', text: '这是下一句。', previousSuggestionId: sourceId, previousReplyText: generated.data.suggestion.reply });
  assert.equal(stale.status, 200); assert.equal(stale.data.previousMessage, null); assert.equal(stale.data.feedback, null);
  clock++;
  const copied = await user.call('POST', `/api/counterparts/${id}/suggestions/${sourceId}/copied`, { requestId: 'annotation_deliberate_reuse' });
  assert.equal(copied.status, 200);
  assert.equal(f.server.betaStore.getSuggestion(user.user.id, id, sourceId).pendingEligible, true);
});

test('annotation copy recovery uses captured revisions despite backward clocks, clearing and old request replay', { timeout: 30_000 }, async (t) => {
  let clock = Date.parse('2026-01-03T10:00:00Z'), calls = 0;
  const f = await fixture(t, { now: () => clock, replyFn: async () => { calls++; return reply(); } });
  const user = await f.register('revisionCopyUser', 'paid'), id = await f.addContext(user);
  const message = f.server.betaStore.listMessages(user.user.id, id)[0];
  const path = `/api/counterparts/${id}`;
  const suggestion = (await user.call('POST', `${path}/reply`, { requestId: 'revision_source' })).data.suggestion;
  const copy = (requestId) => user.call('POST', `${path}/suggestions/${suggestion.id}/copied`, { requestId });
  const read = () => f.server.betaStore.getSuggestion(user.user.id, id, suggestion.id);
  const annotate = (annotationText) => user.call('PATCH', `${path}/messages/${message.id}/annotation`, { annotationText });
  clock += 1_000;
  const oldCopy = await copy('revision_old_copy');
  assert.equal(oldCopy.status, 200);
  clock -= 5_000;
  assert.equal((await annotate('新增线下背景')).status, 200);
  assert.equal(read().pendingEligible, false, 'a pre-edit copy cannot restore even when its clock is later');
  const oldReplay = await copy('revision_old_copy');
  assert.equal(oldReplay.data.cached, true); assert.deepEqual(oldReplay.data.copyReceipt, oldCopy.data.copyReceipt);
  assert.equal(read().pendingEligible, false, 'replay must not recapture the current revision');
  assert.equal((await annotate('')).data.message.annotationRevision, 2);
  assert.equal(read().pendingEligible, false, 'clearing remains a new revision');
  const newCopy = await copy('revision_after_clear');
  assert.equal(read().pendingEligible, true);
  assert.equal(read().pendingCopyReceiptId, newCopy.data.copyReceipt.id);
  assert.ok(newCopy.data.copyReceipt.copiedAt < oldCopy.data.copyReceipt.copiedAt);
  clock -= 5_000;
  assert.equal((await annotate('再补充一次背景')).data.message.annotationRevision, 3);
  assert.equal(read().pendingEligible, false);
  const stale = await user.call('POST', `${path}/followup`, { requestId: 'revision_stale_followup', text: '接着聊的话。', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply, previousCopyReceiptId: newCopy.data.copyReceipt.id });
  assert.equal(stale.status, 200); assert.equal(stale.data.previousMessage, null); assert.equal(stale.data.feedback, null);
  assert.equal((await copy('revision_after_clear')).data.cached, true);
  assert.equal(read().pendingEligible, false);
  const latest = await copy('revision_fresh_copy');
  assert.equal(read().pendingCopyReceiptId, latest.data.copyReceipt.id);
  assert.equal(read().pendingEligible, true, 'new same-clock copy captures revision three');
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    const receipt = db.prepare('SELECT annotation_revisions_json FROM reply_copy_receipts WHERE id=?').get(latest.data.copyReceipt.id);
    assert.deepEqual(JSON.parse(receipt.annotation_revisions_json), { [message.id]: 3 });
    db.prepare('UPDATE reply_copy_receipts SET annotation_revisions_json=NULL WHERE id=?').run(latest.data.copyReceipt.id);
  } finally { db.close(); }
  assert.equal(read().pendingEligible, false, 'legacy receipts without a captured version fail closed after edits');
  const restored = await copy('revision_explicit_recopy');
  const accepted = await user.call('POST', `${path}/followup`, { requestId: 'revision_followup', text: '新的一句。', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply, previousCopyReceiptId: restored.data.copyReceipt.id });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.previousMessage.provenance, 'inferred_from_followup');
  const replay = await user.call('POST', `${path}/followup`, { requestId: 'revision_followup', text: '新的一句。', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply, previousCopyReceiptId: restored.data.copyReceipt.id });
  assert.equal(replay.data.cached, true); assert.equal(replay.data.previousMessage.id, accepted.data.previousMessage.id);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify((await user.call('GET', path)).data).includes('annotation_revisions_json'));
});

test('free daily replies reserve across HTTP objects, release failures, and preserve identical-context cache at zero remaining', async (t) => {
  let calls = 0, release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const f = await fixture(t, { freeProviderDailyLimit: 100, replyFn: async () => { if (++calls === 3) started(); await gate; return reply(); } });
  const user = await f.register('dailyReplyUser');
  const ids = [];
  for (let index = 0; index < 4; index++) ids.push(await f.addContext(user, `不同对象${index}`));
  const pending = ids.map((id, index) => user.call('POST', `/api/counterparts/${id}/reply`, { requestId: `daily_concurrent_${index}` }));
  await ready;
  assert.equal((await user.call('GET', '/api/me')).data.quota.dailyReplyRemaining, 0);
  release();
  const results = await Promise.all(pending);
  assert.equal(results.filter(({ status }) => status === 200).length, 3);
  const failedIndex = results.findIndex(({ status }) => status === 402);
  assert.ok(failedIndex >= 0); assert.equal(results[failedIndex].error.code, 'DAILY_REPLY_QUOTA_EXHAUSTED');
  assert.equal(calls, 3);
  const successfulIndex = results.findIndex(({ status }) => status === 200);
  const replay = await user.call('POST', `/api/counterparts/${ids[successfulIndex]}/reply`, { requestId: 'daily_cache_at_zero' });
  assert.equal(replay.status, 200); assert.equal(replay.data.cached, true); assert.equal(calls, 3);
  assert.equal(replay.data.quota.dailyReplyRemaining, 0);
  assert.equal(replay.data.quota.classificationRemaining, 3);
  assert.equal(replay.data.quota.replyTimeZone, 'Asia/Shanghai');
});

test('annotation during an in-flight reply rejects stale output and refunds its successful-reply reservation', async (t) => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; }), ready = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const f = await fixture(t, { replyFn: async () => { started(); await gate; return reply(); } });
  const user = await f.register('annotationPending'), id = await f.addContext(user);
  const message = f.server.betaStore.listMessages(user.user.id, id)[0];
  const pending = user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'annotation_pending_reply' });
  await ready;
  assert.equal(f.server.betaStore.quota(user.user.id).dailyReplyRemaining, 2);
  assert.equal((await user.call('PATCH', `/api/counterparts/${id}/messages/${message.id}/annotation`, { annotationText: '还有一个线下背景。' })).status, 200);
  release();
  const failed = await pending;
  assert.equal(failed.status, 409); assert.equal(failed.error.code, 'CONTEXT_CHANGED');
  assert.equal(f.server.betaStore.quota(user.user.id).dailyReplyRemaining, 3);
  assert.equal(f.server.betaStore.quota(user.user.id).providerRemaining, 9);
  assert.deepEqual(f.server.betaStore.listSuggestions(user.user.id, id), []);
});

test('explicit topic-change identity is separate, readback uses durable request order, and false remains ordinary context', async (t) => {
  let clock = Date.parse('2026-10-01T10:00:00Z'), calls = 0, replyContext;
  const f = await fixture(t, { now: () => clock, classifyFn: async (context) => { calls++; return { ...classification(context), topicDecision: { mode: context.topicChangeRequested ? 'change' : 'stay', reason: '测试完整上下文选择。' }, options: context.topicChangeRequested ? classification(context).options : [] }; }, replyFn: async ({ context }) => { replyContext = context; return reply(); } });
  const user = await f.register('topicRequestUser', 'paid'), id = await f.addContext(user);
  const change = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'topic_change_true', topicChangeRequested: true });
  assert.equal(change.status, 200); assert.equal(change.data.classification.topicDecision.mode, 'change');
  const ordinary = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'topic_change_false', topicChangeRequested: false });
  assert.equal(ordinary.status, 200); assert.equal(ordinary.data.cached, false);
  let detail = (await user.call('GET', `/api/counterparts/${id}`)).data;
  assert.equal(detail.classification.topicDecision.mode, 'stay', 'same-millisecond newer ordinary request wins over the earlier explicit change');
  assert.equal(detail.modelContext.classificationAttempted, true);
  const replay = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'topic_change_default' });
  assert.equal(replay.status, 200); assert.equal(replay.data.cached, true); assert.equal(calls, 2);
  assert.equal((await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'topic_change_true', topicChangeRequested: false })).status, 409);
  clock--;
  const prior = await user.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'topic_change_replay', topicChangeRequested: true });
  assert.equal(prior.status, 200); assert.equal(prior.data.cached, true);
  detail = (await user.call('GET', `/api/counterparts/${id}`)).data;
  assert.equal(detail.classification.topicDecision.mode, 'change', 'a deliberate request replay is ordered by its durable row rather than a regressed clock');
  const replyResult = await user.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'topic_explicit_reply', topicChangeRequested: true });
  assert.equal(replyResult.status, 200); assert.equal(replyContext.topicChangeRequested, true);
  detail = (await user.call('GET', `/api/counterparts/${id}`)).data;
  assert.ok(detail.currentSuggestionIds.includes(replyResult.data.suggestion.id));
  assert.equal(detail.directReply.id, replyResult.data.suggestion.id);
});

test('historical ranges retain appended context but reject corrected immutable evidence and legacy snapshots', async (t) => {
  let sparse = false, calls = 0, received;
  const f = await fixture(t, { paidProviderDailyLimit: 100, classifyFn: async (context) => {
    received = context; calls++;
    const value = classification(context);
    if (sparse) {
      value.confidence = 'limited';
      value.heat = Object.fromEntries(Object.keys(value.heat).map((name) => [name, { level: 'unknown', evidenceIds: [] }]));
      value.heat.responseEngagement = { level: 'passive', evidenceIds: [context.messages.at(-1).id] };
    }
    return value;
  } });
  const user = await f.register('immutableHeatUser', 'paid');
  const changes = [
    ['append', async () => {}],
    ['speaker', async (path, message) => user.call('PUT', `${path}/messages/${message.id}`, { speaker: 'self', text: message.text })],
    ['text', async (path, message) => user.call('PUT', `${path}/messages/${message.id}`, { speaker: 'other', text: '更正之前记录的原话。' })],
    ['annotation', async (path, message) => user.call('PATCH', `${path}/messages/${message.id}/annotation`, { annotationText: '补充实际的线下背景。' })],
    ['annotation_clear', async (path, message) => {
      assert.equal((await user.call('PATCH', `${path}/messages/${message.id}/annotation`, { annotationText: '后来撤回的解释。' })).status, 200);
      return user.call('PATCH', `${path}/messages/${message.id}/annotation`, { annotationText: '' });
    }],
    ['time', async (path, message) => user.call('PATCH', `${path}/messages/${message.id}/timing`, { actualWechatAt: '2026-01-01T10:00:00Z' })],
    ['profile', async () => user.call('PUT', '/api/profile', { ...profile(), style: '本人更正后的表达方式。' })],
    ['background', async (path) => user.call('PUT', path, { ...counterpart(), background: '更正：线下也见过一次。' })],
    ['meeting', async (path) => user.call('PUT', `${path}/meeting`, { status: 'declined', time: '', place: '', note: '录入明确拒绝邀约的事实。' })],
    ['knowledge', async () => { await writeFile(f.knowledgePath, `${await readFile(f.knowledgePath, 'utf8')}\nA new synthetic owner supplement.\n`); }],
    ['legacy', async (_path, _message, previous, id) => {
      const reserved = f.server.betaStore.reserveJob({ userId: user.user.id, counterpartId: id, operation: 'classify', requestId: 'legacy_heat_job', contextHash: 'legacy-context', knowledgeHash: previous.knowledgeHash, workerId: 'test-worker', providerModel: 'synthetic' });
      f.server.betaStore.markJobRunning(reserved.job.id);
      f.server.betaStore.completeJob(reserved.job.id, previous.result);
      assert.equal(f.server.betaStore.previousClassification(user.user.id, id).contextSnapshot, null);
    }],
  ];
  for (const [name, change] of changes) {
    sparse = false;
    const id = await f.addContext(user, `历史背景-${name}`), path = `/api/counterparts/${id}`;
    const original = (await user.call('POST', `${path}/classify`, { requestId: `heat_original_${name}` })).data;
    assert.equal(original.heat.score, 67);
    const previous = f.server.betaStore.previousClassification(user.user.id, id);
    const immutable = structuredClone(previous.contextSnapshot);
    const firstMessage = f.server.betaStore.listMessages(user.user.id, id)[0];
    const changed = await change(path, firstMessage, previous, id);
    if (changed) assert.equal(changed.status, 200, name);
    assert.equal((await user.call('POST', `${path}/messages`, { speaker: 'other', text: '嗯' })).status, 200);
    sparse = true;
    const result = await user.call('POST', `${path}/classify`, { requestId: `heat_sparse_${name}`, topicChangeRequested: true });
    assert.equal(result.status, 200, name); assert.equal(result.data.cached, false);
    assert.equal(result.data.heat.score, null);
    const range = result.data.heat.preliminaryRange;
    assert.equal(range.basis, name === 'append' ? 'historical_baseline' : 'observed_dimensions', name);
    assert.deepEqual([range.lower, range.upper], name === 'append' ? [52, 82] : [10, 45], name);
    assert.equal(received.messages.at(-1).text, '嗯');
    const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
    try { assert.deepEqual(JSON.parse(db.prepare('SELECT context_snapshot_json FROM model_jobs WHERE id=?').get(previous.id).context_snapshot_json), immutable, name); }
    finally { db.close(); }
    const detail = await user.call('GET', path);
    assert.equal(detail.status, 200);
    assert.ok(!JSON.stringify(detail.data.jobs).includes('contextSnapshot'), 'Private evidence is not projected into job history');
  }
  assert.equal(calls, changes.length * 2, 'No metadata read or compatibility check calls a provider');
});

test('a latest pause cannot resurrect an earlier high range with tied or regressed clocks', async (t) => {
  let clock = Date.parse('2026-10-01T10:00:00Z'), mode = 'mature';
  const f = await fixture(t, { now: () => clock, paidProviderDailyLimit: 100, classifyFn: async (context) => {
    const value = classification(context);
    if (mode === 'pause') value.obstacle = { type: 'negative', evidenceIds: [context.messages.at(-1).id], reason: '停止当前推进。' };
    if (mode === 'sparse') {
      value.confidence = 'limited';
      value.heat = Object.fromEntries(Object.keys(value.heat).map((name) => [name, { level: 'unknown', evidenceIds: [] }]));
      value.heat.responseEngagement = { level: 'passive', evidenceIds: [context.messages.at(-1).id] };
    }
    return value;
  } });
  const user = await f.register('orderedHeatUser', 'paid');
  for (const delta of [0, -1_000]) {
    mode = 'mature';
    const id = await f.addContext(user, `顺序测试-${delta}`), path = `/api/counterparts/${id}`;
    assert.equal((await user.call('POST', `${path}/classify`, { requestId: `ordered_original_${delta}` })).data.heat.score, 67);
    clock += delta; mode = 'pause';
    await user.call('POST', `${path}/messages`, { speaker: 'other', text: '先不要推进这个话题。' });
    const paused = await user.call('POST', `${path}/classify`, { requestId: `ordered_pause_${delta}` });
    assert.equal(paused.data.heat.status, 'pause'); assert.equal(paused.data.heat.preliminaryRange, null);
    assert.equal(f.server.betaStore.previousClassification(user.user.id, id).result.heat.status, 'pause');
    mode = 'sparse';
    await user.call('POST', `${path}/messages`, { speaker: 'other', text: '嗯' });
    const sparse = await user.call('POST', `${path}/classify`, { requestId: `ordered_sparse_${delta}` });
    assert.equal(sparse.status, 200);
    assert.deepEqual([sparse.data.heat.preliminaryRange.lower, sparse.data.heat.preliminaryRange.upper], [10, 45]);
    assert.equal(sparse.data.heat.preliminaryRange.basis, 'observed_dimensions');
  }
});

const contextFact = (message, field, value, subject = message.speaker, source = 'text') => ({ subject, field, value, evidence: [{ messageId: message.id, quote: source === 'annotation' ? message.annotation.text : message.text, source }] });

test('automatic background readback works without manual profiles, replays without extra calls and remains account scoped through MCP', async (t) => {
  let calls = 0, received, receivedKnowledge;
  const updates = (context) => ({ facts: [contextFact(context.messages[0], 'location', '杭州')], meeting: null });
  const f = await fixture(t, { classifyFn: async (context, options) => { calls++; received = context; receivedKnowledge = options.knowledgeText; return { ...classification(context), contextUpdates: updates(context) }; }, replyFn: async ({ context }, options) => { calls++; received = context; receivedKnowledge = options.knowledgeText; return { ...reply(), contextUpdates: updates(context) }; } });
  const user = await f.register('backgroundAutoUser'), outsider = await f.register('backgroundOtherUser');
  const created = await user.call('POST', '/api/counterparts', { alias: '只有姓名的对象' });
  assert.equal(created.status, 200);
  const id = created.data.counterpart.id, path = `/api/counterparts/${id}`;
  await user.call('POST', `${path}/messages`, { speaker: 'other', text: '我在杭州做设计。' });
  await user.call('POST', `${path}/messages`, { speaker: 'other', text: '周末常去跑步。' });
  const first = await user.call('POST', `${path}/classify`, { requestId: 'context_updates_first' });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(received.userProfile).questionnaire, null);
  assert.equal(JSON.parse(received.userProfile).background, '');
  assert.equal(receivedKnowledge, f.knowledgeText);
  assert.equal(first.data.backgroundContext.facts[0].value, '杭州');
  assert.deepEqual(first.data.meeting, first.data.manualMeeting);
  assert.equal(f.server.betaStore.getProfile(user.user.id), null, 'A projection never manufactures a stored profile');
  assert.equal(f.server.betaStore.getCounterpart(user.user.id, id).background, '');
  const replay = await user.call('POST', `${path}/classify`, { requestId: 'context_updates_replay' });
  assert.equal(replay.data.cached, true); assert.equal(calls, 1);
  assert.deepEqual(replay.data.backgroundContext, first.data.backgroundContext);
  assert.equal((await outsider.call('GET', path)).status, 404);
  assert.throws(() => f.server.betaStore.latestContextUpdates(outsider.user.id, id), { code: 'COUNTERPART_NOT_FOUND' });
  const mcp = createAccountMcpServer({ accountId: user.user.id, invoke: f.server.invokeForAccount });
  const client = new Client({ name: 'context-updates-account-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await mcp.close(); });
  const mcpReadback = await client.callTool({ name: 'coach_classify', arguments: { counterpartId: id, requestId: 'context_updates_mcp' } });
  assert.deepEqual(JSON.parse(mcpReadback.content[0].text).backgroundContext, first.data.backgroundContext);
  assert.equal(calls, 1);
  // Exhaust only the separate lifetime classification trials. Free direct reply
  // still uses the same complete raw input and validates the same extraction.
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try { db.prepare('UPDATE users SET classification_used=3 WHERE id=?').run(user.user.id); }
  finally { db.close(); }
  const direct = await user.call('POST', `${path}/reply`, { requestId: 'context_updates_free_reply' });
  assert.equal(direct.status, 200); assert.equal(calls, 2);
  assert.equal(direct.data.quota.classificationRemaining, 0);
  assert.equal(direct.data.quota.dailyReplyRemaining, 2);
  assert.deepEqual(direct.data.backgroundContext, first.data.backgroundContext);
  assert.equal(received.messages.length, 2);
  assert.ok(!JSON.stringify(received).includes('contextUpdates'), 'Derived facts do not feed back into hashes or model input');
  assert.equal(f.server.betaStore.latestContextUpdates(user.user.id, id).operation, 'reply');
  const detail = (await user.call('GET', path)).data;
  assert.deepEqual(detail.backgroundContext, direct.data.backgroundContext);
  assert.ok(!JSON.stringify(detail).includes('manualMeetingReceipt'));
});

test('automatic facts survive appended messages, invalidate on corrected evidence, and rebuild only from new successful analysis', async (t) => {
  let calls = 0;
  const f = await fixture(t, { paidProviderDailyLimit: 100, classifyFn: async (context) => { calls++; return { ...classification(context), contextUpdates: { facts: [contextFact(context.messages[0], 'work', '设计')], meeting: null } }; } });
  const user = await f.register('contextEvidenceUser', 'paid'), id = await f.addContext(user), path = `/api/counterparts/${id}`;
  const message = f.server.betaStore.listMessages(user.user.id, id)[0];
  await user.call('PUT', `${path}/messages/${message.id}`, { speaker: 'other', text: '我做设计。' });
  const analyze = (requestId) => user.call('POST', `${path}/classify`, { requestId });
  assert.equal((await analyze('context_evidence_first')).status, 200);
  const original = structuredClone(f.server.betaStore.latestContextUpdates(user.user.id, id));
  await user.call('POST', `${path}/messages`, { speaker: 'other', text: '今天下班去跑步。' });
  assert.equal((await user.call('GET', path)).data.backgroundContext.facts.length, 1);
  assert.equal(calls, 1);
  for (const [index, update] of [
    () => user.call('PATCH', `${path}/messages/${message.id}/annotation`, { annotationText: '实际只是以前做设计。' }),
    () => user.call('PATCH', `${path}/messages/${message.id}/annotation`, { annotationText: '' }),
    () => user.call('PUT', `${path}/messages/${message.id}`, { speaker: 'other', text: '我做设计，不过工作内容变了。' }),
  ].entries()) {
    assert.equal((await update()).status, 200);
    assert.deepEqual((await user.call('GET', path)).data.backgroundContext.facts, []);
    assert.equal((await analyze(`context_evidence_new_${index}`)).status, 200);
    assert.equal((await user.call('GET', path)).data.backgroundContext.facts.length, 1);
  }
  assert.deepEqual(f.server.betaStore.listJobs(user.user.id, id).find(({ id: jobId }) => jobId === original.id).result, original.result);
  assert.ok(!f.server.betaStore.listJobs(user.user.id, id).some((job) => 'contextSnapshot' in job));
  assert.equal((await user.call('DELETE', `${path}/messages/${message.id}`)).status, 200);
  assert.deepEqual((await user.call('GET', path)).data.backgroundContext.facts, []);
  assert.equal(calls, 4, 'Editing/readback itself performs no extraction request');
});

test('injected extraction output must cite actual records, and inferred drafts never become profile facts', async (t) => {
  let calls = 0, useDraft = false;
  const f = await fixture(t, { classifyFn: async (context) => { calls++; return { ...classification(context), contextUpdates: { facts: useDraft ? [contextFact(context.messages.find(({ provenance }) => provenance === 'inferred_from_followup'), 'work', '医生')] : [{ subject: 'other', field: 'work', value: '医生', evidence: [{ messageId: 'nonexistent-message', quote: '我是医生', source: 'text' }] }], meeting: null } }; } });
  const user = await f.register('invalidExtractionUser'), id = await f.addContext(user), path = `/api/counterparts/${id}`;
  const invalid = await user.call('POST', `${path}/classify`, { requestId: 'invalid_context_quote' });
  assert.equal(invalid.status, 502); assert.equal(invalid.error.code, 'INVALID_MODEL_OUTPUT');
  const auditDb = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    const diagnostics = auditDb.prepare("SELECT details_json FROM audit_log WHERE action='model_job_failed' ORDER BY rowid DESC LIMIT 1").get();
    assert.ok(diagnostics.details_json.includes('invalid_context_evidence_reference'));
    assert.ok(!diagnostics.details_json.includes('nonexistent-message'));
    assert.ok(!diagnostics.details_json.includes('医生'));
  } finally { auditDb.close(); }
  assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 3);
  const invalidReplay = await user.call('POST', `${path}/classify`, { requestId: 'invalid_context_quote' });
  assert.equal(invalidReplay.status, 409); assert.equal(calls, 1);
  const suggestion = (await user.call('POST', `${path}/reply`, { requestId: 'draft_context_source' })).data.suggestion;
  const followup = await user.call('POST', `${path}/followup`, { requestId: 'draft_context_followup', text: '你今天忙吗？', previousSuggestionId: suggestion.id, previousReplyText: '我是医生。' });
  assert.equal(followup.data.previousMessage.provenance, 'inferred_from_followup');
  useDraft = true;
  const inferred = await user.call('POST', `${path}/classify`, { requestId: 'invalid_inferred_fact' });
  assert.equal(inferred.status, 502); assert.equal(inferred.error.code, 'INVALID_MODEL_OUTPUT');
  assert.deepEqual((await user.call('GET', path)).data.backgroundContext.facts, []);
  assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 3);
  assert.equal(f.server.betaStore.latestContextUpdates(user.user.id, id), null);
});

test('manual meeting cancellation wins through same-clock saves and reversals until new chat evidence updates it', async (t) => {
  let clock = Date.parse('2026-10-01T10:00:00Z'), useLatest = false, calls = 0;
  const f = await fixture(t, { now: () => clock, paidProviderDailyLimit: 100, classifyFn: async (context) => {
    calls++; const proposal = useLatest ? context.messages.at(-1) : context.messages[0];
    return { ...classification(context), contextUpdates: { facts: [], meeting: { status: 'proposed', time: '周六下午', place: '公园', note: '', evidence: [{ messageId: proposal.id, quote: proposal.text, source: 'text' }] } } };
  } });
  const user = await f.register('manualMeetingPriority', 'paid'), id = await f.addContext(user), path = `/api/counterparts/${id}`;
  const message = f.server.betaStore.listMessages(user.user.id, id)[0];
  await user.call('PUT', `${path}/messages/${message.id}`, { speaker: 'other', text: '周六下午在公园见面怎么样？' });
  const first = await user.call('POST', `${path}/classify`, { requestId: 'automatic_meeting_first' });
  assert.equal(first.status, 200); assert.equal(first.data.meeting.status, 'proposed');
  assert.equal(first.data.manualMeeting.status, 'none');
  const manualNone = { status: 'none', time: '', place: '', note: '' };
  await user.call('PUT', `${path}/meeting`, manualNone);
  assert.equal((await user.call('GET', path)).data.meeting.status, 'none', 'An explicit same-value save revokes the previous automatic proposal');
  const originalReceipt = f.server.betaStore.getMeetingState(user.user.id, id).receiptId;
  const oldEvidence = await user.call('POST', `${path}/classify`, { requestId: 'manual_boundary_reanalyze' });
  assert.equal(oldEvidence.status, 200); assert.equal(oldEvidence.data.meeting.status, 'none');
  assert.equal(oldEvidence.data.backgroundContext.meetingSource, 'manual');
  clock -= 5_000;
  await user.call('PUT', `${path}/meeting`, manualNone);
  assert.notEqual(f.server.betaStore.getMeetingState(user.user.id, id).receiptId, originalReceipt);
  assert.equal((await user.call('GET', path)).data.meeting.status, 'none');
  const modelInput = f.server.betaStore.latestContextUpdates(user.user.id, id).contextSnapshot.modelInput;
  assert.deepEqual(JSON.parse(modelInput.counterpartProfile).manualMeetingBoundary.messageIdsAtSave, f.server.betaStore.listMessages(user.user.id, id).map(({ id }) => id));
  useLatest = true;
  await user.call('POST', `${path}/messages`, { speaker: 'other', text: '那改成周六下午在公园见面怎么样？' });
  const later = await user.call('POST', `${path}/classify`, { requestId: 'manual_boundary_new_chat' });
  assert.equal(later.status, 200); assert.equal(later.data.meeting.status, 'proposed');
  assert.equal(later.data.manualMeeting.status, 'none');
  assert.equal(later.data.backgroundContext.meetingSource, 'chat_evidence');
  assert.deepEqual(f.server.betaStore.getMeeting(user.user.id, id), manualNone);
  assert.ok(!JSON.stringify((await user.call('GET', path)).data).includes('_saveReceipt'));
  assert.equal(calls, 3);
});

test('full-profile downgrade hides automatic projections while preserving raw readback and blocking paid context generation', async (t) => {
  let calls = 0;
  const f = await fixture(t, { classifyFn: async (context) => { calls++; return { ...classification(context), contextUpdates: { facts: [contextFact(context.messages[0], 'availability', '近期工作忙')], meeting: null } }; } });
  const user = await f.register('contextDowngradeUser', 'paid'), id = await f.addContext(user, '完整版对象', { kind: 'full' }), path = `/api/counterparts/${id}`;
  assert.equal((await user.call('POST', `${path}/classify`, { requestId: 'downgrade_extract_first' })).status, 200);
  f.server.betaStore.updatePlan({ ownerId: f.owner.id, userId: user.user.id, plan: 'free' });
  const detail = await user.call('GET', path);
  assert.equal(detail.status, 200); assert.deepEqual(detail.data.backgroundContext.facts, []);
  assert.equal(detail.data.messages.length, 2); assert.deepEqual(detail.data.meeting, detail.data.manualMeeting);
  const rejected = await user.call('POST', `${path}/reply`, { requestId: 'downgrade_extract_block' });
  assert.equal(rejected.status, 403); assert.equal(rejected.error.code, 'FULL_PROFILE_REQUIRES_UPDATE');
  assert.equal(calls, 1);
});

test('a same-value manual meeting save during a call fences the immutable result despite identical clocks and model input', async (t) => {
  const clock = Date.parse('2026-10-01T10:00:00Z');
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; }), ready = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const f = await fixture(t, { now: () => clock, classifyFn: async (context) => { started(); await gate; return { ...classification(context), contextUpdates: { facts: [contextFact(context.messages[0], 'availability', '近期工作忙')], meeting: null } }; } });
  const user = await f.register('contextMeetingFence'), id = await f.addContext(user), path = `/api/counterparts/${id}`;
  const none = { status: 'none', time: '', place: '', note: '' };
  await user.call('PUT', `${path}/meeting`, none);
  const prior = f.server.betaStore.getMeetingState(user.user.id, id);
  const pending = user.call('POST', `${path}/classify`, { requestId: 'meeting_identical_clock' });
  await ready;
  await user.call('PUT', `${path}/meeting`, none);
  const current = f.server.betaStore.getMeetingState(user.user.id, id);
  assert.deepEqual(prior.meeting, current.meeting); assert.equal(prior.updatedAt, current.updatedAt);
  assert.deepEqual(prior.atSaveMessageIds, current.atSaveMessageIds); assert.notEqual(prior.receiptId, current.receiptId);
  release();
  const failed = await pending;
  assert.equal(failed.status, 409); assert.equal(failed.error.code, 'CONTEXT_CHANGED');
  assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 3);
  assert.equal(f.server.betaStore.quota(user.user.id).providerRemaining, 9);
  assert.equal(f.server.betaStore.latestContextUpdates(user.user.id, id), null);
  assert.deepEqual((await user.call('GET', path)).data.backgroundContext.facts, []);
});

test('old agreement plus an unrelated new quote cannot resurrect a manually cancelled meeting', async (t) => {
  let citeUnrelated = false, calls = 0;
  const f = await fixture(t, { classifyFn: async (context) => {
    calls++;
    const evidence = context.messages.slice(0, 2).map((message) => ({ messageId: message.id, quote: message.text, source: 'text' }));
    if (citeUnrelated) evidence.push({ messageId: context.messages.at(-1).id, quote: context.messages.at(-1).text, source: 'text' });
    return { ...classification(context), contextUpdates: { facts: [], meeting: { status: 'confirmed', time: '周六下午两点', place: '公园北门', note: '', evidence } } };
  } });
  const user = await f.register('meetingBoundaryNoBypass', 'paid');
  const id = (await user.call('POST', '/api/counterparts', { alias: '边界案例对象' })).data.counterpart.id, path = `/api/counterparts/${id}`;
  await user.call('POST', `${path}/messages`, { speaker: 'self', text: '周六下午两点在公园北门见面，怎么样？' });
  await user.call('POST', `${path}/messages`, { speaker: 'other', text: '好，就这么定，周六下午两点在公园北门见面。' });
  const original = await user.call('POST', `${path}/classify`, { requestId: 'boundary_original_agreement' });
  assert.equal(original.status, 200); assert.equal(original.data.meeting.status, 'confirmed');
  const manual = { status: 'none', time: '', place: '', note: '' };
  await user.call('PUT', `${path}/meeting`, manual);
  await user.call('POST', `${path}/messages`, { speaker: 'other', text: '最近忙工作。' });
  citeUnrelated = true;
  const updated = await user.call('POST', `${path}/classify`, { requestId: 'boundary_unrelated_new_quote' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.classification.contextUpdates.meeting, null);
  assert.deepEqual(updated.data.meeting, manual);
  assert.equal(updated.data.backgroundContext.meetingSource, 'manual');
  assert.deepEqual((await user.call('GET', path)).data.meeting, manual);
  assert.equal(calls, 2);
});
