import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaStore, seedOwner } from '../src/beta-store.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';
import { buildChatContext, QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';
import { appliedPersonalStyle, StyleLearningInputSchema, StyleReviewInputSchema, StyleRuleInputSchema } from '../src/style-learning.mjs';

const PASSWORD = 'SyntheticStylePassword2026';
const profile = () => ({ background: '虚构个人背景。', style: '保留原来的简短表达。', growthGoals: '练习真诚表达兴趣。', relationshipGoal: '双方愿意时见面。', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) } });
const counterpart = () => ({ alias: '虚构对象', channel: 'app', appProfile: '喜欢电影。', offlineScene: '', background: '虚构两轮互动。', rounds: 2 });
const reply = () => ({ reply: '忙完你通常怎么放松？', reason: '自然展开日常。', action: 'reply', styleNote: '可以练习一点自然好奇。' });
const rule = (text = '尽量先用一个简短问题。', target = 'current_preference') => ({ target, text, conditions: '', limits: '' });
function classification(context) {
  const evidenceIds = [context.messages.findLast(({ speaker }) => speaker === 'other').id];
  return { status: 'ready', confidence: 'moderate', phase: 'ordinary', obstacle: { type: 'none', evidenceIds: [], reason: '没有明确阻力。' }, heat: Object.fromEntries(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'].map((name) => [name, { level: 'positive', evidenceIds }])), options: ['up', 'down', 'sideways'].map((topicMove, index) => ({ topicMove, relationAction: 'continue', weight: index ? 0.2 : 0.6, reason: '自然延伸。', evidenceIds })), uncertainties: [], recommendationKind: 'uncalibrated' };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'coach-style-'));
  const dataDir = join(directory, 'data'), knowledgePath = join(directory, 'knowledge.md');
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8'); await writeFile(knowledgePath, knowledgeText);
  let clock = Date.parse('2026-10-01T12:00:00Z'), calls = 0;
  const captured = [];
  const bootstrap = createBetaStore({ dataDir, now: () => clock });
  const owner = await seedOwner(bootstrap, { username: 'styleOwner', password: PASSWORD }); bootstrap.close();
  const settings = { dataDir, knowledgePath, webDir: null, now: () => clock,
    classifyFn: async (context, config) => { calls++; captured.push(context); assert.equal(config.knowledgeText, knowledgeText); return classification(context); },
    replyFn: async ({ context }, config) => { calls++; captured.push(context); assert.equal(config.knowledgeText, knowledgeText); return reply(); }, ...options };
  let server;
  const start = async () => { server = await createBetaServer(settings); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); };
  const stop = async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
  await start(); t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  async function call(method, path, input, session) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + path, { method, headers: { origin, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, ...await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const logged = await call('POST', '/api/login', { username: 'styleOwner', password: PASSWORD });
  const session = { user: logged.data.user, cookie: logged.cookie, csrf: logged.data.csrfToken };
  async function account(username) {
    const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'free' }).invite;
    const registered = await call('POST', '/api/register', { invite, username, password: PASSWORD });
    return { user: registered.data.user, cookie: registered.cookie, csrf: registered.data.csrfToken };
  }
  async function addContext(who = session) {
    if (!server.betaStore.getProfile(who.user.id)) assert.equal((await call('PUT', '/api/profile', profile(), who)).status, 200);
    const id = (await call('POST', '/api/counterparts', counterpart(), who)).data.counterpart.id;
    await call('POST', `/api/counterparts/${id}/followup`, { requestId: `initial_${id}`, text: '最近一直忙工作，你呢？' }, who);
    return id;
  }
  async function learning(who = session) { return (await call('GET', '/api/style-learning', undefined, who)).data; }
  async function save(requestId, change = {}, who = session, businessProfile = profile()) {
    const state = await learning(who);
    return call('PUT', '/api/profile', { ...businessProfile, styleLearning: { requestId, expectedRevision: state.revision, ...change } }, who);
  }
  return { directory, dataDir, knowledgePath, knowledgeText, owner, session, call, account, addContext, learning, save, captured, get server() { return server; }, get calls() { return calls; }, advance(ms) { clock += ms; }, async restart() { await stop(); await start(); } };
}

test('pure inputs separate self reports from outcomes and project only explicit adopted personal rules', () => {
  const review = StyleReviewInputSchema.parse({ counterpartId: 'c', suggestionId: 's', ownVersion: '本人愿意这样表达。' });
  assert.equal(review.reasonKind, 'unknown'); assert.equal(review.styleFit, 'unknown'); assert.equal(review.willingness, 'undecided');
  assert.equal(StyleReviewInputSchema.safeParse({ ...review, outcome: 'positive' }).success, false);
  assert.equal(StyleReviewInputSchema.safeParse({ ...review, rawFeedback: 'private' }).success, false);
  assert.equal(StyleLearningInputSchema.safeParse({ requestId: 'safe_request', expectedRevision: 0, role: 'owner' }).success, false);
  assert.equal(StyleRuleInputSchema.safeParse(rule('长'.repeat(501))).success, false);
  const active = { ...rule(), status: 'adopted', sourceReviewId: 'private-case', privateCase: 'never-in-model', styleFit: 'like' };
  assert.deepEqual(appliedPersonalStyle([{ ...rule('unconfirmed'), status: 'candidate' }, active], 4), { activeRevision: 4, rules: [rule()] });
  assert.equal(appliedPersonalStyle([{ ...rule(), status: 'revoked' }], 5), undefined);
  const p = validateProfile(profile()), c = counterpart(), messages = [{ id: 'other', speaker: 'other', text: '你好。' }];
  assert.deepEqual(buildChatContext(p, c, messages), buildChatContext(p, c, messages, { personalStyle: undefined }));
});

test('case self reports and candidates stay private and out of model context while preserving immutable original A and observed IDs only', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const a = (await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'source_original_a' }, f.session)).data.suggestion;
  const source = f.server.betaStore.getSuggestionCase(f.owner.id, id, a.id);
  const next = (await f.call('POST', `/api/counterparts/${id}/followup`, { requestId: 'source_actual_next', text: '普通保存的对方对话。', previousSuggestionId: a.id, previousReplyText: a.reply }, f.session)).data;
  await f.call('POST', `/api/counterparts/${id}/feedback`, { suggestionId: a.id, actualSentText: a.reply, counterpartReply: 'raw-outcome-sentinel', observation: 'raw-note-sentinel', kind: 'uncertain', consent: false }, f.session);
  const current = (await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'current_before_learning' }, f.session)).data.suggestion;
  const beforeInput = f.captured.at(-1);
  const saved = await f.save('case_candidate_save', { review: { counterpartId: id, suggestionId: a.id, ownVersion: 'private-own-version-sentinel', why: 'private-why-sentinel', reasonKind: 'style', styleFit: 'unlike', willingness: 'try' }, ruleChange: { type: 'propose', rule: rule('private-unconfirmed-rule-sentinel') } });
  assert.equal(saved.status, 200); assert.equal(f.calls, 2);
  const state = saved.data.styleLearning, observed = state.reviews[0];
  assert.equal(state.rules[0].status, 'candidate'); assert.equal(state.activeRevision, 0);
  assert.equal(observed.source, 'user_self_report'); assert.equal(observed.version, 'style-review-1');
  assert.equal(observed.originalSuggestion.reply, a.reply); assert.equal(observed.originalSuggestion.originJobId, source.originJobId); assert.equal(observed.originalSuggestion.snapshotHash, source.snapshotHash);
  assert.deepEqual(observed.replyObservation, { status: 'unknown', assessment: 'unassessed', messageIds: [] });
  assert.equal(observed.actualSend, undefined); assert.equal(observed.outcome, undefined);
  assert.equal(saved.data.profile.style, profile().style); assert.equal(saved.data.profile.growthGoals, profile().growthGoals);
  const replay = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'current_after_candidate' }, f.session);
  assert.equal(replay.data.cached, true); assert.equal(replay.data.suggestion.id, current.id); assert.equal(f.calls, 2);
  assert.deepEqual(f.server.betaStore.getSuggestionCase(f.owner.id, id, current.id).snapshot.modelInput, beforeInput);
  assert.equal(await readFile(f.knowledgePath, 'utf8'), f.knowledgeText);
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    assert.throws(() => db.prepare('UPDATE style_reviews SET value_json=? WHERE id=?').run('{}', observed.id), /IMMUTABLE_STYLE_REVIEW/);
    assert.throws(() => db.prepare('UPDATE style_rules SET value_json=? WHERE id=?').run('{}', state.rules[0].id), /IMMUTABLE_STYLE_RULE/);
  } finally { db.close(); }
});

test('explicit adoption applies only four rule fields across own counterparts and existing MCP inference, with revocation and replacement', async (t) => {
  const f = await fixture(t); const firstId = await f.addContext(), secondId = await f.addContext();
  const a = (await f.call('POST', `/api/counterparts/${firstId}/reply`, { requestId: 'adopt_case_source' }, f.session)).data.suggestion;
  const proposed = await f.save('adopt_propose', { review: { counterpartId: firstId, suggestionId: a.id, ownVersion: 'private-case-b-sentinel', why: 'private-case-why-sentinel', styleFit: 'unlike', willingness: 'try' }, ruleChange: { type: 'propose', rule: rule('偏好先短一点。') } });
  const candidate = proposed.data.styleLearning.rules[0];
  await f.save('adopt_candidate', { ruleChange: { type: 'adopt', candidateId: candidate.id } });
  await f.save('adopt_growth_goal', { ruleChange: { type: 'adopt_new', rule: rule('练习具体真诚评价。', 'growth_goal') } });
  const expected = f.server.betaStore.getAppliedPersonalStyle(f.owner.id);
  assert.equal(expected.rules.length, 2); assert.equal(expected.rules[1].target, 'growth_goal');
  const firstReply = await f.call('POST', `/api/counterparts/${firstId}/reply`, { requestId: 'after_adopt_first' }, f.session);
  assert.equal(firstReply.data.cached, false);
  const parsed = JSON.parse(f.captured.at(-1).userProfile);
  assert.deepEqual(parsed.confirmedPersonalStyle, expected); assert.equal(parsed.currentStyle, profile().style);
  assert.deepEqual(Object.keys(parsed.confirmedPersonalStyle.rules[0]).sort(), ['conditions', 'limits', 'target', 'text']);
  assert.doesNotMatch(JSON.stringify(parsed), /private-case-b-sentinel|private-case-why-sentinel|originalSuggestion|styleFit|willingness|replyObservation/);
  await f.server.invokeForAccount({ accountId: f.owner.id, method: 'POST', path: `/api/counterparts/${secondId}/reply`, body: { requestId: 'mcp_adopt_second' } });
  assert.deepEqual(JSON.parse(f.captured.at(-1).userProfile).confirmedPersonalStyle, expected);
  await assert.rejects(f.server.invokeForAccount({ accountId: f.owner.id, method: 'PUT', path: '/api/profile', body: { ...profile() } }), { code: 'MCP_OPERATION_FORBIDDEN' });
  await assert.rejects(f.server.invokeForAccount({ accountId: f.owner.id, method: 'GET', path: '/api/style-learning' }), { code: 'MCP_OPERATION_FORBIDDEN' });
  const other = await f.account('styleOther'), otherId = await f.addContext(other);
  await f.call('POST', `/api/counterparts/${otherId}/reply`, { requestId: 'other_no_personal_rule' }, other);
  assert.equal(JSON.parse(f.captured.at(-1).userProfile).confirmedPersonalStyle, undefined); assert.deepEqual((await f.learning(other)).rules, []);
  const replaced = await f.save('replace_current_rule', { ruleChange: { type: 'adopt_new', supersedesId: candidate.id, rule: rule('先回应再问一个问题。') } });
  assert.equal(replaced.data.styleLearning.rules.find(({ id }) => id === candidate.id).status, 'revoked');
  const replacement = replaced.data.styleLearning.rules.find(({ supersedesId }) => supersedesId === candidate.id);
  assert.equal(replacement.status, 'adopted'); assert.equal(replacement.text, '先回应再问一个问题。');
  const activeIds = replaced.data.styleLearning.rules.filter(({ status }) => status === 'adopted').map(({ id }) => id);
  for (const ruleId of activeIds) await f.save(`revoke_${ruleId}`, { ruleChange: { type: 'revoke', ruleId } });
  assert.equal(f.server.betaStore.getAppliedPersonalStyle(f.owner.id), undefined);
  // With no active rules the original context shape returns, so its earlier
  // no-rule cache is valid; the rule-conditioned suggestion stays historical.
  const withoutRules = (await f.call('GET', `/api/counterparts/${firstId}`, undefined, f.session)).data.directReply;
  assert.equal(withoutRules.id, a.id); assert.notEqual(withoutRules.id, firstReply.data.suggestion.id);
  assert.equal(f.server.betaStore.getSuggestionCase(f.owner.id, firstId, firstReply.data.suggestion.id).snapshot.modelInput.userProfile, JSON.stringify(parsed));
});

test('whole validated profile/style requests replay across restart, and CAS protects against ordinary profile writes without new context hashes', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const revision = (await f.learning()).revision;
  const body = { ...profile(), styleLearning: { requestId: 'profile_atomic_identity', expectedRevision: revision, ruleChange: { type: 'adopt_new', rule: rule() } } };
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.call('PUT', '/api/profile', body, f.session)));
  assert.equal(responses.filter(({ data }) => !data.styleLearning.cached).length, 1);
  assert.equal((await f.learning()).rules.length, 1); assert.equal((await f.learning()).revision, revision + 1);
  assert.equal((await f.call('PUT', '/api/profile', { ...body, style: 'same-ID-different-profile' }, f.session)).error.code, 'STYLE_REQUEST_CONFLICT');
  assert.equal((await f.call('PUT', '/api/profile', { ...profile(), styleLearning: { requestId: 'old_revision_fail', expectedRevision: revision } }, f.session)).error.code, 'STYLE_REVISION_CONFLICT');
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'unchanged_profile_context' }, f.session);
  const priorState = await f.learning();
  const unchanged = await f.call('PUT', '/api/profile', profile(), f.session);
  assert.equal(unchanged.data.styleLearning.revision, priorState.revision + 1); assert.equal(unchanged.data.styleLearning.activeRevision, priorState.activeRevision);
  const same = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'unchanged_profile_replay' }, f.session);
  assert.equal(same.data.cached, true); assert.equal(same.data.suggestion.id, generated.data.suggestion.id); assert.equal(f.calls, 1);
  assert.equal((await f.call('PUT', '/api/profile', { ...profile(), background: 'stale-background', styleLearning: { requestId: 'ordinary_put_protects', expectedRevision: priorState.revision } }, f.session)).error.code, 'STYLE_REVISION_CONFLICT');
  await f.call('PUT', '/api/profile', { ...profile(), style: '最新画像保持不回滚。' }, f.session);
  await f.restart();
  const replay = await f.call('PUT', '/api/profile', body, f.session);
  assert.equal(replay.data.styleLearning.cached, true); assert.equal(replay.data.styleLearning.rules.length, 1); assert.equal(replay.data.profile.style, '最新画像保持不回滚。');
});

test('invalid sources, cross-account rule references, injected authority and full-questionnaire gates cannot partially update profiles', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const a = (await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'isolation_source' }, f.session)).data.suggestion;
  const own = await f.save('isolation_rule', { ruleChange: { type: 'adopt_new', rule: rule() } });
  const ruleId = own.data.styleLearning.rules[0].id;
  const other = await f.account('styleIsolation'), otherId = await f.addContext(other);
  const before = await f.learning(other), beforeProfile = f.server.betaStore.getProfile(other.user.id);
  for (const change of [{ type: 'adopt', candidateId: ruleId }, { type: 'revoke', ruleId }, { type: 'adopt_new', supersedesId: ruleId, rule: rule('非法跨账号替代。') }]) {
    const invalid = await f.save(`isolation_${change.type}`, { ruleChange: change }, other, { ...profile(), style: '不能部分写入。' });
    assert.equal(invalid.status, 404); assert.equal(invalid.error.code, 'STYLE_RULE_NOT_FOUND');
  }
  for (const review of [{ counterpartId: id, suggestionId: a.id, ownVersion: '不能读取别人原A。' }, { counterpartId: otherId, suggestionId: a.id, ownVersion: '对象与建议不匹配。' }]) {
    assert.equal((await f.save(`isolation_case_${review.counterpartId}`, { review }, other)).status, 404);
  }
  const invalidRaw = await f.save('raw_outcome_rejected', { review: { counterpartId: id, suggestionId: a.id, ownVersion: '自己的表达。', outcome: 'positive', rawFeedback: 'forbidden' } });
  assert.equal(invalidRaw.status, 400);
  assert.equal((await f.call('PUT', '/api/profile', { ...profile(), styleLearning: { requestId: 'authority_rejected', expectedRevision: before.revision, userId: f.owner.id } }, other)).status, 400);
  assert.deepEqual(await f.learning(other), before); assert.deepEqual(f.server.betaStore.getProfile(other.user.id), beforeProfile);
  const full = { ...profile(), questionnaire: { kind: 'full', answers: Object.fromEntries(QUESTIONNAIRES.full.map(({ id }) => [id, 3])) } };
  assert.equal((await f.save('free_full_rule_gate', { ruleChange: { type: 'adopt_new', rule: rule() } }, other, full)).error.code, 'FULL_QUESTIONNAIRE_PAID_ONLY');
  assert.deepEqual(await f.learning(other), before); assert.equal(await readFile(f.knowledgePath, 'utf8'), f.knowledgeText);
});

test('profile, case, rule, revisions, receipt and audit roll back together on an actual SQLite write failure', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const a = (await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'rollback_case_source' }, f.session)).data.suggestion;
  const before = await f.learning(), beforeProfile = f.server.betaStore.getProfile(f.owner.id);
  const input = { ...profile(), style: '不能部分生效的新画像。', styleLearning: { requestId: 'rollback_style_save', expectedRevision: before.revision, review: { counterpartId: id, suggestionId: a.id, ownVersion: '本人的新版本。' }, ruleChange: { type: 'adopt_new', rule: rule() } } };
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    const auditBefore = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    db.exec("CREATE TRIGGER fixture_style_failure BEFORE INSERT ON style_rules BEGIN SELECT RAISE(ABORT,'private-sqlite-failure-detail'); END");
    const failed = await f.call('PUT', '/api/profile', input, f.session);
    assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(failed), /private-sqlite-failure-detail/);
    assert.deepEqual(await f.learning(), before); assert.deepEqual(f.server.betaStore.getProfile(f.owner.id), beforeProfile);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM style_save_receipts WHERE request_id=?').get(input.styleLearning.requestId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, auditBefore);
    db.exec('DROP TRIGGER fixture_style_failure');
    const retried = await f.call('PUT', '/api/profile', input, f.session);
    assert.equal(retried.status, 200); assert.equal(retried.data.styleLearning.cached, false);
    assert.equal(retried.data.styleLearning.rules.length, 1); assert.equal(retried.data.styleLearning.reviews.length, 1);
    assert.equal(retried.data.profile.style, input.style);
  } finally { db.close(); }
});

test('adoption makes in-flight outputs stale and returns free classification trials; candidates preserve the effective context', async (t) => {
  let release, began;
  let started = new Promise((resolve) => { began = resolve; });
  let pending = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { classifyFn: async (context) => { began(); await pending; return classification(context); } });
  const user = await f.account('stylePending'), id = await f.addContext(user);
  let response = f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'style_class_pending' }, user);
  await started;
  assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 2);
  assert.equal((await f.save('pending_rule_adoption', { ruleChange: { type: 'adopt_new', rule: rule() } }, user)).status, 200);
  release();
  assert.equal((await response).error.code, 'CONTEXT_CHANGED'); assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 3);
  started = new Promise((resolve) => { began = resolve; }); pending = new Promise((resolve) => { release = resolve; });
  response = f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'style_class_after_rule' }, user);
  await started; f.advance(1_000);
  const before = f.server.betaStore.getAppliedPersonalStyle(user.user.id);
  await f.save('pending_only_candidate', { ruleChange: { type: 'propose', rule: rule('未采纳表达不会改变上下文。') } }, user);
  assert.deepEqual(f.server.betaStore.getAppliedPersonalStyle(user.user.id), before);
  release();
  assert.equal((await response).status, 200); assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 2);
});

test('deleting a source conversation removes private cases but retains adopted abstract preferences with a cleared source link', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const a = (await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'deletion_style_source' }, f.session)).data.suggestion;
  const before = await f.learning();
  const body = { ...profile(), styleLearning: { requestId: 'deletion_style_adopt', expectedRevision: before.revision, review: { counterpartId: id, suggestionId: a.id, ownVersion: 'delete-private-b-sentinel', why: 'delete-private-why-sentinel' }, ruleChange: { type: 'adopt_new', rule: rule('独立本人表达偏好。') } } };
  const saved = await f.call('PUT', '/api/profile', body, f.session);
  assert.equal(saved.data.styleLearning.rules[0].sourceReviewId, saved.data.styleLearning.reviews[0].id);
  await f.call('DELETE', `/api/counterparts/${id}`, {}, f.session);
  const state = await f.learning();
  assert.deepEqual(state.reviews, []); assert.equal(state.rules[0].status, 'adopted'); assert.equal(state.rules[0].sourceReviewId, null);
  assert.doesNotMatch(JSON.stringify(state), /delete-private-b-sentinel|delete-private-why-sentinel|originalSuggestion/);
  const replay = await f.call('PUT', '/api/profile', body, f.session);
  assert.equal(replay.data.styleLearning.cached, true); assert.equal(replay.data.styleLearning.reviews.length, 0);
  const otherId = await f.addContext();
  await f.call('POST', `/api/counterparts/${otherId}/reply`, { requestId: 'deletion_rule_still_applies' }, f.session);
  assert.equal(JSON.parse(f.captured.at(-1).userProfile).confirmedPersonalStyle.rules[0].text, '独立本人表达偏好。');
});

test('legacy style cases retain a missing-context marker and unknown observation, never backfill today’s profile', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const old = f.server.betaStore.reserveJob({ userId: f.owner.id, counterpartId: id, operation: 'reply', requestId: 'legacy_style_source', contextHash: 'legacy', knowledgeHash: 'legacy', workerId: 'fixture', providerModel: 'fixture' });
  f.server.betaStore.markJobRunning(old.job.id);
  const suggestion = { ...reply(), id: 'legacy-style-suggestion', contextHash: 'legacy', knowledgeHash: 'legacy' };
  f.server.betaStore.completeJob(old.job.id, { suggestion }, suggestion);
  const saved = await f.save('legacy_style_review', { review: { counterpartId: id, suggestionId: suggestion.id, ownVersion: '我的待用版本。' } });
  const record = saved.data.styleLearning.reviews[0];
  assert.equal(record.originalSuggestion.contextStatus, 'legacy_incomplete'); assert.equal(record.originalSuggestion.snapshotHash, null);
  assert.deepEqual(record.replyObservation, { status: 'unknown', assessment: 'unassessed', messageIds: [] });
  assert.equal(record.styleFit, 'unknown'); assert.equal(record.willingness, 'undecided'); assert.equal(f.calls, 0);
});

test('read-only observations follow the exact saved own version without mutating cases or claiming effects', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const a = (await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'dynamic_observation_source' }, f.session)).data.suggestion;
  const ownVersion = '本人待用的表达B。';
  const saved = await f.save('dynamic_review_first', { review: { counterpartId: id, suggestionId: a.id, ownVersion } });
  const reviewId = saved.data.styleLearning.reviews[0].id;
  assert.deepEqual(saved.data.styleLearning.reviews[0].replyObservation, { status: 'unknown', assessment: 'unassessed', messageIds: [] });
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    const original = db.prepare('SELECT value_json FROM style_reviews WHERE id=?').get(reviewId).value_json;
    await f.call('POST', `/api/counterparts/${id}/feedback`, { suggestionId: a.id, actualSentText: ownVersion, counterpartReply: '这段raw不代表聊天记录', observation: '', kind: 'uncertain', consent: false }, f.session);
    assert.equal((await f.learning()).reviews[0].replyObservation.status, 'unknown');
    f.advance(1_000);
    const followup = (await f.call('POST', `/api/counterparts/${id}/followup`, { requestId: 'dynamic_actual_link', previousSuggestionId: a.id, previousReplyText: ownVersion, text: '记录的对方下一句。' }, f.session)).data;
    assert.equal(followup.previousMessage.provenance, 'inferred_from_followup');
    assert.deepEqual((await f.learning()).reviews[0].replyObservation, { status: 'recorded', assessment: 'unassessed', messageIds: [followup.message.id] });
    await f.call('PUT', `/api/counterparts/${id}/messages/${followup.previousMessage.id}`, { speaker: 'self', text: '同一AI建议的另一版本人表达B2。' }, f.session);
    assert.equal((await f.learning()).reviews[0].replyObservation.status, 'unknown');
    await f.call('PUT', `/api/counterparts/${id}/messages/${followup.previousMessage.id}`, { speaker: 'self', text: ownVersion }, f.session);
    assert.equal((await f.learning()).reviews[0].replyObservation.status, 'recorded');
    await f.call('DELETE', `/api/counterparts/${id}/messages/${followup.message.id}`, {}, f.session);
    assert.equal((await f.learning()).reviews[0].replyObservation.status, 'unknown');
    assert.equal(db.prepare('SELECT value_json FROM style_reviews WHERE id=?').get(reviewId).value_json, original);
    assert.equal(f.calls, 1); assert.equal(f.server.betaStore.getAppliedPersonalStyle(f.owner.id), undefined);
  } finally { db.close(); }
});

test('only one competing replacement can activate and stale replacement failures roll back the whole profile save', async (t) => {
  const f = await fixture(t); await f.addContext();
  const initial = await f.save('replacement_original', { ruleChange: { type: 'adopt_new', rule: rule('原表达偏好。') } });
  const parent = initial.data.styleLearning.rules[0].id;
  await f.save('replacement_candidate_one', { ruleChange: { type: 'propose', supersedesId: parent, rule: rule('第一版替代。') } });
  const proposed = await f.save('replacement_candidate_two', { ruleChange: { type: 'propose', supersedesId: parent, rule: rule('第二版替代。') } });
  const candidates = proposed.data.styleLearning.rules.filter(({ status }) => status === 'candidate');
  const revision = proposed.data.styleLearning.revision;
  const firstBody = { ...profile(), styleLearning: { requestId: 'replacement_adopt_one', expectedRevision: revision, ruleChange: { type: 'adopt', candidateId: candidates[0].id } } };
  const adopted = await f.call('PUT', '/api/profile', firstBody, f.session);
  assert.equal(adopted.status, 200);
  const before = await f.learning(), beforeProfile = f.server.betaStore.getProfile(f.owner.id);
  const invalid = await f.save('replacement_adopt_two', { ruleChange: { type: 'adopt', candidateId: candidates[1].id } }, f.session, { ...profile(), style: '不应该部分生效。' });
  assert.equal(invalid.status, 409); assert.equal(invalid.error.code, 'STYLE_RULE_STATE_INVALID');
  assert.deepEqual(await f.learning(), before); assert.deepEqual(f.server.betaStore.getProfile(f.owner.id), beforeProfile);
  assert.equal((await f.save('replacement_adopt_new_stale', { ruleChange: { type: 'adopt_new', supersedesId: parent, rule: rule('已撤销的旧目标不能再次替代。') } })).error.code, 'STYLE_RULE_STATE_INVALID');
  assert.deepEqual((await f.learning()).rules.filter(({ status }) => status === 'adopted').map(({ id }) => id), [candidates[0].id]);
  const replay = await f.call('PUT', '/api/profile', firstBody, f.session);
  assert.equal(replay.status, 200); assert.equal(replay.data.styleLearning.cached, true); assert.equal(f.calls, 0);
});

test('active-rule bounds permit atomic replacement at capacity but reject additional adoption without partial changes', async (t) => {
  const f = await fixture(t); await f.addContext();
  for (let index = 0; index < 20; index++) {
    assert.equal((await f.save(`capacity_adopt_${index}`, { ruleChange: { type: 'adopt_new', rule: rule(`本人偏好${index}。`) } })).status, 200);
  }
  const before = await f.learning();
  const extra = await f.save('capacity_extra_rule', { ruleChange: { type: 'adopt_new', rule: rule('不能默默截断的第21条。') } });
  assert.equal(extra.status, 400); assert.equal(extra.error.code, 'STYLE_ACTIVE_LIMIT'); assert.deepEqual(await f.learning(), before);
  const replaced = await f.save('capacity_replace_rule', { ruleChange: { type: 'adopt_new', supersedesId: before.rules[0].id, rule: rule('容量内明确替代。') } });
  assert.equal(replaced.status, 200); assert.equal(replaced.data.styleLearning.rules.filter(({ status }) => status === 'adopted').length, 20);
  assert.equal(replaced.data.styleLearning.rules.find(({ id }) => id === before.rules[0].id).status, 'revoked'); assert.equal(f.calls, 0);
});

test('competing CAS requests cannot mix profile and rule writes, and CAS-only ordinary saves remain idempotent', async (t) => {
  const f = await fixture(t); await f.addContext();
  const revision = (await f.learning()).revision;
  const inputs = [1, 2].map((index) => ({ ...profile(), style: `并发画像${index}。`, styleLearning: { requestId: `competing_cas_${index}`, expectedRevision: revision, ruleChange: { type: 'adopt_new', rule: rule(`对应规则${index}。`) } } }));
  const results = await Promise.all(inputs.map((body) => f.call('PUT', '/api/profile', body, f.session)));
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  const winner = results.findIndex(({ status }) => status === 200);
  const state = await f.learning();
  assert.equal(state.rules.length, 1); assert.equal(state.rules[0].text, inputs[winner].styleLearning.ruleChange.rule.text);
  assert.equal(f.server.betaStore.getProfile(f.owner.id).style, inputs[winner].style);
  const sameProfile = { ...inputs[winner] }; delete sameProfile.styleLearning;
  const casOnly = { ...sameProfile, styleLearning: { requestId: 'ordinary_cas_only', expectedRevision: state.revision } };
  const saved = await f.call('PUT', '/api/profile', casOnly, f.session);
  assert.equal(saved.status, 200); assert.equal(saved.data.styleLearning.revision, state.revision + 1); assert.equal(saved.data.styleLearning.activeRevision, state.activeRevision);
  assert.equal((await f.call('PUT', '/api/profile', casOnly, f.session)).data.styleLearning.cached, true);
  assert.equal((await f.learning()).rules.length, 1); assert.equal(f.calls, 0);
});
