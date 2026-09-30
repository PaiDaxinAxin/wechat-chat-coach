import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
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
