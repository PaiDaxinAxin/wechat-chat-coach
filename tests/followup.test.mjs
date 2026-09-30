import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createBetaServer } from '../src/beta-api.mjs';
import { createBetaStore, seedOwner } from '../src/beta-store.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';
import { QUESTIONNAIRES } from '../src/domain.mjs';
import { ChatInputSchema } from '../src/coach.mjs';
import { createHash } from 'node:crypto';
import { COACH_CONTEXT_VERSION, COACH_PROTOCOL_VERSION } from '../src/chat-record.mjs';

const PASSWORD = 'SyntheticPassword2026';
const profile = () => ({ background: '【虚构】做设计，喜欢徒步。', style: '原始简短风格。', growthGoals: '练习自然表达兴趣。', relationshipGoal: '双方愿意时见面。', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) } });
const counterpart = () => ({ alias: '虚构对象', channel: 'app', appProfile: '虚构：喜欢电影。', offlineScene: '', background: '两轮互动，未见面。', rounds: 2 });
const reply = () => ({ reply: '忙完我们聊点轻松的，你最近喜欢看什么？', reason: '给出容易接住的延伸。', action: 'reply', styleNote: '保持自然简短。' });
function classification(context) {
  const evidenceIds = [context.messages.findLast(({ speaker }) => speaker === 'other').id];
  return { status: 'ready', confidence: 'moderate', phase: 'ordinary', obstacle: { type: 'none', evidenceIds: [], reason: '没有明确阻力。' }, heat: Object.fromEntries(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'].map((name) => [name, { level: 'positive', evidenceIds }])), options: ['up', 'down', 'sideways'].map((topicMove, index) => ({ topicMove, relationAction: 'continue', weight: index ? 0.2 : 0.6, reason: '自然延伸。', evidenceIds })), uncertainties: [], recommendationKind: 'uncalibrated' };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'coach-followup-'));
  const dataDir = join(directory, 'data'), knowledgePath = join(directory, 'knowledge.md');
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  await writeFile(knowledgePath, knowledgeText);
  let clock = Date.parse('2026-10-01T10:00:00Z'), calls = 0, captured;
  const bootstrap = createBetaStore({ dataDir, now: () => clock });
  const owner = await seedOwner(bootstrap, { username: 'owner', password: PASSWORD }); bootstrap.close();
  const settings = { dataDir, knowledgePath, webDir: null, now: () => clock,
    classifyFn: async (context) => { calls++; captured = context; return classification(context); },
    replyFn: async (input, config) => { calls++; captured = input.context; assert.equal(config.knowledgeText, await readFile(knowledgePath, 'utf8')); return reply(); }, ...options };
  let server;
  async function start() { server = await createBetaServer(settings); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); }
  await start();
  async function stop() { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  async function call(method, path, input, session) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + path, { method, headers: { origin, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, ...await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const logged = await call('POST', '/api/login', { username: 'owner', password: PASSWORD });
  const session = { user: logged.data.user, cookie: logged.cookie, csrf: logged.data.csrfToken };
  async function account(username) {
    const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'free' }).invite;
    const registered = await call('POST', '/api/register', { invite, username, password: PASSWORD });
    return { user: registered.data.user, cookie: registered.cookie, csrf: registered.data.csrfToken };
  }
  async function addContext(who = session) {
    assert.equal((await call('PUT', '/api/profile', profile(), who)).status, 200);
    const added = await call('POST', '/api/counterparts', counterpart(), who);
    const id = added.data.counterpart.id;
    assert.equal((await call('POST', `/api/counterparts/${id}/followup`, { text: '最近一直忙工作，你呢？', requestId: `initial_${id}` }, who)).status, 200);
    return id;
  }
  return { directory, dataDir, knowledgePath, knowledgeText, owner, session, call, account, addContext, get server() { return server; }, get calls() { return calls; }, get captured() { return captured; }, get clock() { return clock; }, advance(ms) { clock += ms; }, async restart() { await stop(); await start(); } };
}

test('followup is atomic, account scoped and durable idempotent, with unknown nonconsenting inferred feedback', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'generate_one' }, f.session);
  const suggestionId = generated.data.suggestion.id;
  const body = { text: '我最近在看纪录片。', requestId: 'followup_one', previousSuggestionId: suggestionId, previousReplyText: '编辑后的上一轮草稿。' };
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.call('POST', `/api/counterparts/${id}/followup`, body, f.session)));
  assert.equal(responses.filter((response) => !response.data.cached).length, 1);
  const result = responses[0].data;
  assert.equal(result.previousMessage.provenance, 'inferred_from_followup'); assert.equal(result.message.speaker, 'other');
  assert.equal(f.server.betaStore.listMessages(f.owner.id, id).length, 3);
  const feedback = f.server.betaStore.getFeedback(f.owner.id, result.feedback.id);
  assert.equal(feedback.raw.outcome, 'unknown'); assert.equal(feedback.raw.payload.consent, false); assert.equal(feedback.raw.caseEvidence.actualSend, 'inferred_from_followup');
  assert.equal(feedback.caseEvidence.contextStatus, 'complete');
  const cleaned = await f.call('POST', `/api/admin/feedback/${result.feedback.id}/clean`, {}, f.session);
  assert.equal(cleaned.data.feedback.cleaning.stage, 'quarantined'); assert.deepEqual(cleaned.data.feedback.cleaning.allowedPurposes, []);
  assert.ok(cleaned.data.feedback.cleaning.flags.includes('inferred_followup'));
  assert.equal((await f.call('POST', `/api/admin/feedback/${result.feedback.id}/review`, { decision: 'approve', purpose: 'knowledge', conditions: '虚构条件。', limits: '只是一条记录。' }, f.session)).status, 400);
  assert.equal(await readFile(f.knowledgePath, 'utf8'), f.knowledgeText);
  await f.restart();
  const replay = await f.call('POST', `/api/counterparts/${id}/followup`, body, f.session);
  assert.equal(replay.data.cached, true); assert.equal(replay.data.message.id, result.message.id); assert.equal(f.server.betaStore.listMessages(f.owner.id, id).length, 3);
  assert.equal((await f.call('POST', `/api/counterparts/${id}/followup`, { ...body, text: '不同内容。' }, f.session)).error.code, 'FOLLOWUP_REQUEST_CONFLICT');
  f.advance(3_600_000);
  const sameQuote = await f.call('POST', `/api/counterparts/${id}/followup`, { ...body, requestId: 'same_quote_new_id' }, f.session);
  assert.equal(sameQuote.data.cached, true); assert.deepEqual(sameQuote.data.timing, result.timing);
  assert.equal((await f.call('POST', `/api/counterparts/${id}/followup`, { ...body, text: '又一段内容。', requestId: 'consumed_source' }, f.session)).error.code, 'FOLLOWUP_SOURCE_ALREADY_LINKED');
  const bob = await f.account('otherUser'), bobId = await f.addContext(bob);
  assert.equal((await f.call('POST', `/api/counterparts/${bobId}/followup`, { ...body, requestId: 'cross_account' }, bob)).status, 404);
  assert.equal(f.server.betaStore.listMessages(bob.user.id, bobId).length, 1);
  assert.equal(f.calls, 1);
});

test('copy timing is a server-recorded proxy, edits fall back to preparation and paired reported times stay separate', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'timing_generate' }, f.session);
  const suggestionId = generated.data.suggestion.id, text = generated.data.suggestion.reply;
  f.advance(30_000);
  const copied = await f.call('POST', `/api/counterparts/${id}/suggestions/${suggestionId}/copied`, { copiedText: text, requestId: 'clipboard_one' }, f.session);
  f.advance(3_600_000);
  const recopyReplay = await f.call('POST', `/api/counterparts/${id}/suggestions/${suggestionId}/copied`, { copiedText: text, requestId: 'clipboard_one' }, f.session);
  assert.deepEqual(recopyReplay.data.copyReceipt, copied.data.copyReceipt); assert.equal(recopyReplay.data.cached, true);
  const next = await f.call('POST', `/api/counterparts/${id}/followup`, { text: '刚忙完，喜欢看电影。', requestId: 'timing_followup', previousSuggestionId: suggestionId, previousReplyText: text, previousCopyReceiptId: copied.data.copyReceipt.id }, f.session);
  assert.equal(next.data.timing.elapsedMs, 3_600_000); assert.equal(next.data.timing.reliability, 'app_interval_estimate'); assert.equal(next.data.timing.interpretation, 'not_verified_wechat_latency');
  const originalRecordedAt = next.data.message.recordedAt;
  const reportedSelf = new Date(f.clock - 2_000_000).toISOString(), reportedOther = new Date(f.clock - 1_000_000).toISOString();
  await f.call('PATCH', `/api/counterparts/${id}/messages/${next.data.previousMessage.id}/timing`, { actualWechatAt: reportedSelf }, f.session);
  const annotated = await f.call('PATCH', `/api/counterparts/${id}/messages/${next.data.message.id}/timing`, { actualWechatAt: reportedOther }, f.session);
  assert.equal(annotated.data.message.recordedAt, originalRecordedAt); assert.equal(annotated.data.message.wechatTime.at, reportedOther); assert.equal(annotated.data.message.wechatTime.source, 'user_reported');
  assert.equal(annotated.data.message.replyInterval.elapsedMs, 1_000_000); assert.equal(annotated.data.message.replyInterval.reliability, 'user_reported_interval');
  assert.equal((await f.call('PATCH', `/api/counterparts/${id}/messages/${next.data.message.id}/timing`, { actualWechatAt: new Date(f.clock + 1).toISOString() }, f.session)).error.code, 'MESSAGE_TIME_INVALID');
  assert.equal((await f.call('PATCH', `/api/counterparts/${id}/messages/${next.data.message.id}/timing`, { actualWechatAt: reportedOther, recordedAt: reportedOther }, f.session)).status, 400);
  const receipt = f.server.betaStore.getFeedback(f.owner.id, next.data.feedback.id).raw.caseEvidence;
  assert.deepEqual(receipt.timing, next.data.timing); assert.equal(receipt.counterpartMessage.wechatTime, null);
  await f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'timing_analyze' }, f.session);
  const analyzed = f.captured.messages.find((message) => message.id === next.data.message.id);
  assert.equal(analyzed.wechatTime.at, reportedOther); assert.equal(analyzed.replyInterval.reliability, 'user_reported_interval'); assert.equal(ChatInputSchema.safeParse(f.captured).success, true);
  assert.equal(f.captured.messages.find((message) => message.id === next.data.previousMessage.id).provenance, 'inferred_from_followup');
  assert.ok(!JSON.stringify(f.captured).includes('raw_untrusted'));
  const otherId = await f.addContext();
  assert.equal((await f.call('POST', `/api/counterparts/${otherId}/followup`, { text: '无关。', requestId: 'copy_cross_object', previousSuggestionId: suggestionId, previousReplyText: text, previousCopyReceiptId: copied.data.copyReceipt.id }, f.session)).status, 404);
});

test('preparation fallback and clock reversal are explicitly weaker or unknown, never invented platform times', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'fallback_generate' }, f.session);
  const suggestionId = generated.data.suggestion.id;
  const copied = await f.call('POST', `/api/counterparts/${id}/suggestions/${suggestionId}/copied`, { copiedText: '之前复制的内容。', requestId: 'fallback_copy' }, f.session);
  f.advance(600_000);
  const edited = await f.call('POST', `/api/counterparts/${id}/followup`, { text: '你好。', requestId: 'fallback_followup', previousSuggestionId: suggestionId, previousReplyText: '复制后编辑的草稿。', previousCopyReceiptId: copied.data.copyReceipt.id }, f.session);
  assert.equal(edited.data.timing.fromSource, 'suggestion_prepared'); assert.equal(edited.data.timing.reliability, 'weak_preparation_estimate'); assert.equal(edited.data.timing.elapsedMs, 600_000);
  const second = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'clock_generate' }, f.session);
  f.advance(-1);
  const reversed = await f.call('POST', `/api/counterparts/${id}/followup`, { text: '第二句。', requestId: 'clock_reversal', previousSuggestionId: second.data.suggestion.id, previousReplyText: second.data.suggestion.reply }, f.session);
  assert.equal(reversed.data.timing.elapsedMs, null); assert.equal(reversed.data.timing.reliability, 'unknown');
  const initial = await f.call('POST', `/api/counterparts/${id}/followup`, { text: '手动录入的一句。', requestId: 'no_source_time' }, f.session);
  assert.equal(initial.data.timing.fromAt, null); assert.equal(initial.data.timing.elapsedMs, null); assert.equal(initial.data.previousMessage, null); assert.equal(initial.data.feedback, null);
});

test('private immutable cases preserve original input, direction weights and complete knowledge versions, including legacy gaps', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  await f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'case_classify' }, f.session);
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'case_reply', direction: 'down', intent: '了解具体工作。' }, f.session);
  const suggestion = generated.data.suggestion;
  const source = f.server.betaStore.getSuggestionCase(f.owner.id, id, suggestion.id);
  assert.equal(source.status, 'complete'); assert.equal(source.snapshot.choice.requestedDirection, 'down'); assert.equal(source.snapshot.choice.classificationResult.classification.options[0].weight, 0.6);
  assert.match(source.snapshot.modelInput.userProfile, /原始简短风格/); assert.equal(JSON.parse(source.snapshot.modelInput.counterpartProfile).meeting.status, 'none');
  assert.equal(source.snapshot.modelInput.intent, '了解具体工作。'); assert.equal(source.snapshot.knowledge.hash, suggestion.knowledgeHash);
  const archive = join(f.dataDir, 'knowledge-versions', `${suggestion.knowledgeHash}.md`);
  assert.equal(await readFile(archive, 'utf8'), f.knowledgeText); assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(source.snapshot).includes(f.knowledgeText));
  await f.call('PUT', '/api/profile', { ...profile(), style: '修改后的风格。' }, f.session);
  await f.call('PUT', `/api/counterparts/${id}/meeting`, { status: 'confirmed', time: '周六', place: '咖啡馆', note: '虚构。' }, f.session);
  await writeFile(f.knowledgePath, `${f.knowledgeText}\nNew private supplement.\n`);
  const feedback = await f.call('POST', `/api/counterparts/${id}/followup`, { text: '周末聊。', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply, requestId: 'case_followup' }, f.session);
  const restored = f.server.betaStore.getFeedback(f.owner.id, feedback.data.feedback.id).caseEvidence;
  assert.deepEqual(restored.snapshot, source.snapshot); assert.equal(restored.snapshotHash, source.snapshotHash);
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try { assert.throws(() => db.prepare('UPDATE model_jobs SET context_snapshot_json=? WHERE id=?').run('{}', source.originJobId), /IMMUTABLE_CASE_SNAPSHOT/); }
  finally { db.close(); }
  const detail = await f.call('GET', `/api/counterparts/${id}`, undefined, f.session);
  assert.equal(detail.data.snapshot, undefined); assert.ok(!JSON.stringify(detail.data).includes(f.knowledgeText));
  assert.equal((await f.call('GET', `/knowledge-versions/${suggestion.knowledgeHash}.md`, undefined, f.session)).status, 404);
  await assert.rejects(f.server.invokeForAccount({ accountId: f.owner.id, method: 'GET', path: '/api/admin/feedback' }), { code: 'MCP_OPERATION_FORBIDDEN' });
  // Legacy records are shown as missing context, never filled from today's profile.
  const old = f.server.betaStore.reserveJob({ userId: f.owner.id, counterpartId: id, operation: 'reply', requestId: 'legacy_fixture', contextHash: 'old', knowledgeHash: 'old', workerId: 'fixture', providerModel: 'fixture' });
  f.server.betaStore.markJobRunning(old.job.id);
  const legacySuggestion = { ...reply(), id: 'legacy-suggestion', contextHash: 'old', knowledgeHash: 'old' };
  f.server.betaStore.completeJob(old.job.id, { suggestion: legacySuggestion }, legacySuggestion);
  assert.equal(f.server.betaStore.getSuggestionCase(f.owner.id, id, legacySuggestion.id).status, 'legacy_incomplete');
  assert.equal(f.server.betaStore.getSuggestionCase(f.owner.id, id, legacySuggestion.id).snapshot, null);
  await f.call('DELETE', `/api/counterparts/${id}`, {}, f.session);
  const afterDelete = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try { for (const table of ['model_jobs', 'suggestions', 'feedback', 'followup_receipts', 'reply_copy_receipts', 'messages']) assert.equal(afterDelete.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE counterpart_id=?`).get(id).count, 0); }
  finally { afterDelete.close(); }
});

test('durable current-context attempts stop automatic retries after model failures while direct reply replay avoids costs', async (t) => {
  let failed = false;
  const f = await fixture(t, { classifyFn: async () => { failed = true; const error = new Error(); error.code = 'provider_timeout'; throw error; } }); const id = await f.addContext();
  let detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, f.session)).data;
  assert.deepEqual(detail.modelContext, { classificationAttempted: false, directReplyAttempted: false }); assert.equal(detail.directReply, null);
  assert.equal((await f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'failure_attempt' }, f.session)).status, 502); assert.equal(failed, true);
  await f.restart();
  detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, f.session)).data;
  assert.equal(detail.modelContext.classificationAttempted, true); assert.equal(detail.classification, null);
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'direct_reply_one' }, f.session);
  detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, f.session)).data;
  assert.equal(detail.directReply.id, generated.data.suggestion.id); assert.equal(detail.modelContext.directReplyAttempted, true);
  const replay = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'direct_reply_replay' }, f.session);
  assert.equal(replay.data.cached, true); assert.equal(f.calls, 1);
  await f.call('POST', `/api/counterparts/${id}/followup`, { text: '新的一句。', requestId: 'new_context_after_failure' }, f.session);
  detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, f.session)).data;
  assert.deepEqual(detail.modelContext, { classificationAttempted: false, directReplyAttempted: false }); assert.equal(detail.directReply, null);
});

test('a feedback write failure rolls back both messages, receipts and conversation changes', async (t) => {
  const f = await fixture(t); const id = await f.addContext();
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'rollback_reply' }, f.session);
  const before = f.server.betaStore.getCounterpart(f.owner.id, id);
  const request = { requestId: 'rollback_followup', text: '虚构新回应。', previousSuggestionId: generated.data.suggestion.id, previousReplyText: generated.data.suggestion.reply };
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    db.exec("CREATE TRIGGER fixture_feedback_failure BEFORE INSERT ON feedback BEGIN SELECT RAISE(ABORT,'private-trigger-detail'); END");
    const failed = await f.call('POST', `/api/counterparts/${id}/followup`, request, f.session);
    assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(failed), /private-trigger-detail/);
    assert.equal(f.server.betaStore.listMessages(f.owner.id, id).length, 1);
    assert.deepEqual(f.server.betaStore.getCounterpart(f.owner.id, id), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE counterpart_id=?').get(id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM followup_receipts WHERE request_id=?').get(request.requestId).n, 0);
    db.exec('DROP TRIGGER fixture_feedback_failure');
    const retried = await f.call('POST', `/api/counterparts/${id}/followup`, request, f.session);
    assert.equal(retried.status, 200); assert.equal(retried.data.cached, false);
    assert.equal(f.server.betaStore.listMessages(f.owner.id, id).length, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE counterpart_id=?').get(id).n, 1);
  } finally { db.close(); }
});

test('followup during a classification preserves the original case, fails stale output and returns its free trial', async (t) => {
  let release, began;
  const started = new Promise((resolve) => { began = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { classifyFn: async (context) => { began(); await pending; return classification(context); } });
  const account = await f.account('pendingAccount'), id = await f.addContext(account);
  const response = f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'pending_classify' }, account);
  await started;
  assert.equal(f.server.betaStore.quota(account.user.id).classificationRemaining, 2);
  await f.call('POST', `/api/counterparts/${id}/followup`, { text: '补充另一句。', requestId: 'pending_changed' }, account);
  release();
  const failed = await response;
  assert.equal(failed.error.code, 'CONTEXT_CHANGED'); assert.equal(failed.status, 409);
  assert.equal(f.server.betaStore.quota(account.user.id).classificationRemaining, 3);
  assert.equal(f.server.betaStore.quota(account.user.id).providerRemaining, 9);
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    const row = db.prepare('SELECT * FROM model_jobs WHERE request_id=?').get('pending_classify');
    assert.equal(row.state, 'failed'); assert.equal(row.error_code, 'CONTEXT_CHANGED');
    assert.equal(JSON.parse(row.context_snapshot_json).modelInput.messages.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suggestions WHERE counterpart_id=?').get(id).n, 0);
  } finally { db.close(); }
});

test('manual coach plans persist and replay without chat suggestions or free trial charges, bounded by shared daily budget', async (t) => {
  let planCalls = 0;
  const f = await fixture(t, { freeProviderDailyLimit: 2, planFn: async ({ context, plan }, options) => {
    planCalls++;
    assert.equal(options.knowledgeText, await readFile(f.knowledgePath, 'utf8'));
    assert.equal(ChatInputSchema.safeParse(context).success, true);
    if (plan === '失败计划') { const error = new Error('private-provider-body'); error.code = 'provider_timeout'; throw error; }
    return { verdict: 'suitable', reason: '轻度尝试，再根据对方反应调整。', timingSuggestion: { status: 'now', guidance: '当前话题可以自然提出。', evidenceIds: [context.messages[0].id] }, nextAction: '观察回应后再发展。' };
  } });
  const user = await f.account('planAccount'), id = await f.addContext(user);
  const input = { requestId: 'manual_plan_one', plan: '我想轻度夸她认真，接着聊电影。' };
  const results = await Promise.all(Array.from({ length: 5 }, () => f.call('POST', `/api/counterparts/${id}/coach-plan`, input, user)));
  assert.equal(results.filter((result) => !result.data.cached).length, 1); assert.equal(planCalls, 1);
  const first = results[0].data;
  assert.equal(first.quota.classificationRemaining, 3); assert.equal(first.quota.providerRemaining, 1);
  assert.equal(first.suggestion, undefined); assert.equal(f.server.betaStore.listSuggestions(user.user.id, id).length, 0);
  assert.equal(f.server.betaStore.listMessages(user.user.id, id).length, 1);
  const replay = await f.call('POST', `/api/counterparts/${id}/coach-plan`, { ...input, requestId: 'manual_plan_replay' }, user);
  assert.equal(replay.data.cached, true); assert.equal(planCalls, 1);
  assert.equal((await f.call('POST', `/api/counterparts/${id}/coach-plan`, { ...input, plan: '不同计划。' }, user)).error.code, 'REQUEST_ID_CONTEXT_CONFLICT');
  await f.restart();
  const detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, user)).data;
  assert.deepEqual(detail.latestCoachPlan, { plan: input.plan, planAssessment: first.planAssessment });
  assert.equal(detail.jobs.find(({ operation }) => operation === 'coach_plan').state, 'succeeded');
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    const snapshot = JSON.parse(db.prepare('SELECT context_snapshot_json FROM model_jobs WHERE request_id=?').get(input.requestId).context_snapshot_json);
    assert.equal(snapshot.request.plan, input.plan); assert.equal(snapshot.choice.source, 'user_plan');
    assert.equal(snapshot.model.protocolVersion, COACH_PROTOCOL_VERSION);
  } finally { db.close(); }
  const failed = await f.call('POST', `/api/counterparts/${id}/coach-plan`, { requestId: 'manual_plan_failed', plan: '失败计划' }, user);
  assert.equal(failed.error.code, 'PROVIDER_TIMEOUT'); assert.doesNotMatch(JSON.stringify(failed), /private-provider-body/);
  assert.equal(f.server.betaStore.quota(user.user.id).classificationRemaining, 3); assert.equal(f.server.betaStore.quota(user.user.id).providerRemaining, 0);
  assert.equal((await f.call('POST', `/api/counterparts/${id}/coach-plan`, { requestId: 'manual_plan_limit', plan: '新计划。' }, user)).error.code, 'PROVIDER_BUDGET_EXHAUSTED');
  assert.equal(planCalls, 2);
  const stranger = await f.account('planStranger');
  assert.equal((await f.call('POST', `/api/counterparts/${id}/coach-plan`, input, stranger)).status, 404);
  await f.call('POST', `/api/counterparts/${id}/followup`, { requestId: 'plan_context_changed', text: '新一句。' }, user);
  assert.equal((await f.call('GET', `/api/counterparts/${id}`, undefined, user)).data.latestCoachPlan, null);
});

test('legacy protocol and changed provider model never reuse current results despite identical chat and knowledge', async (t) => {
  const env = { AGNES_MODEL: 'synthetic-model-a' };
  const f = await fixture(t, { providerEnv: env }); const id = await f.addContext();
  const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: 'identity_input' }, f.session);
  const snapshot = f.server.betaStore.getSuggestionCase(f.owner.id, id, generated.data.suggestion.id).snapshot;
  const context = snapshot.modelInput, knowledgeHash = snapshot.knowledge.hash;
  const legacyHash = createHash('sha256').update(JSON.stringify({ context, knowledgeHash, operation: 'classify', direction: null })).digest('hex');
  const old = f.server.betaStore.reserveJob({ userId: f.owner.id, counterpartId: id, operation: 'classify', requestId: 'legacy_protocol', contextHash: legacyHash, knowledgeHash, workerId: 'fixture', providerModel: env.AGNES_MODEL });
  f.server.betaStore.markJobRunning(old.job.id);
  f.server.betaStore.completeJob(old.job.id, { classification: classification(context), heat: null });
  let detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, f.session)).data;
  assert.equal(detail.classification, null); assert.equal(detail.modelContext.classificationAttempted, false);
  const current = await f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'current_protocol' }, f.session);
  assert.equal(current.data.cached, false); assert.notEqual(current.data.classification.contextHash, legacyHash);
  assert.equal(snapshot.model.contextVersion, COACH_CONTEXT_VERSION); assert.equal(snapshot.model.protocolVersion, COACH_PROTOCOL_VERSION);
  env.AGNES_MODEL = 'synthetic-model-b';
  detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, f.session)).data;
  assert.equal(detail.classification, null); assert.equal(detail.directReply, null); assert.equal(detail.modelContext.classificationAttempted, false);
  const changed = await f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'changed_model' }, f.session);
  assert.equal(changed.data.cached, false); assert.notEqual(changed.data.classification.contextHash, current.data.classification.contextHash);
  assert.equal(f.server.betaStore.getSuggestionCase(f.owner.id, id, generated.data.suggestion.id).snapshot.model.name, 'synthetic-model-a');
});

test('changing either speaker or deleting a paired message invalidates derived intervals without rewriting the original case', async (t) => {
  const f = await fixture(t);
  for (const edit of ['previous_speaker', 'next_speaker', 'delete_previous']) {
    const id = await f.addContext();
    const generated = await f.call('POST', `/api/counterparts/${id}/reply`, { requestId: `roles_reply_${edit}` }, f.session);
    const next = (await f.call('POST', `/api/counterparts/${id}/followup`, { requestId: `roles_followup_${edit}`, text: '对方新一句。', previousSuggestionId: generated.data.suggestion.id, previousReplyText: generated.data.suggestion.reply }, f.session)).data;
    await f.call('PATCH', `/api/counterparts/${id}/messages/${next.previousMessage.id}/timing`, { actualWechatAt: new Date(f.clock - 3_600_000).toISOString() }, f.session);
    await f.call('PATCH', `/api/counterparts/${id}/messages/${next.message.id}/timing`, { actualWechatAt: new Date(f.clock).toISOString() }, f.session);
    assert.equal(f.server.betaStore.listMessages(f.owner.id, id).find(({ id: mid }) => mid === next.message.id).replyInterval.reliability, 'user_reported_interval');
    if (edit === 'previous_speaker') await f.call('PUT', `/api/counterparts/${id}/messages/${next.previousMessage.id}`, { speaker: 'other', text: next.previousMessage.text }, f.session);
    else if (edit === 'next_speaker') await f.call('PUT', `/api/counterparts/${id}/messages/${next.message.id}`, { speaker: 'self', text: next.message.text }, f.session);
    else await f.call('DELETE', `/api/counterparts/${id}/messages/${next.previousMessage.id}`, {}, f.session);
    assert.equal(f.server.betaStore.listMessages(f.owner.id, id).find(({ id: mid }) => mid === next.message.id).replyInterval, null);
    assert.deepEqual(f.server.betaStore.getFeedback(f.owner.id, next.feedback.id).raw.caseEvidence.timing, next.timing);
  }
});

test('model failure diagnostics preserve only allowlisted fixed categories and schema paths in private audit, with no retry', async (t) => {
  let calls = 0;
  const secret = 'private-model-or-input-string-never-persist';
  const f = await fixture(t, { classifyFn: async () => {
    calls++;
    const error = new Error(secret); error.code = 'invalid_model_output';
    error.diagnostics = [
      { code: 'invalid_value', path: ['options', 0, 'relationAction'], message: secret, value: secret },
      { code: 'unsupported_private_warming', path: [], input: secret },
      { code: secret, path: [] },
      { code: 'invalid_type', path: [secret] },
      { code: 'invalid_type', path: ['options', -1] },
      { code: 'invalid_type', path: ['options', 1_001] },
      { code: 'invalid_type', path: Array(9).fill('options') },
      { code: 'invalid_type', path: null },
    ];
    throw error;
  } });
  const id = await f.addContext();
  const failed = await f.call('POST', `/api/counterparts/${id}/classify`, { requestId: 'safe_diagnostic_failure' }, f.session);
  assert.equal(calls, 1); assert.equal(failed.error.code, 'INVALID_MODEL_OUTPUT');
  assert.equal(failed.error.message, '模型结果未通过格式或证据校验，请手动重试。');
  assert.doesNotMatch(JSON.stringify(failed), /private-model-or-input|diagnostics|relationAction/);
  const db = new DatabaseSync(join(f.dataDir, 'beta.sqlite'));
  try {
    const row = db.prepare('SELECT * FROM model_jobs WHERE request_id=?').get('safe_diagnostic_failure');
    const audit = db.prepare("SELECT details_json FROM audit_log WHERE action='model_job_failed' AND entity_id=?").get(row.id);
    const evidence = JSON.parse(audit.details_json);
    assert.deepEqual(evidence, { code: 'INVALID_MODEL_OUTPUT', diagnostics: [ { code: 'invalid_value', path: ['options', 0, 'relationAction'] }, { code: 'unsupported_private_warming', path: [] } ] });
    assert.doesNotMatch(audit.details_json, /private-model-or-input|"(?:message|value|input)"\s*:/);
    assert.equal(row.state, 'failed'); assert.equal(row.error_code, 'INVALID_MODEL_OUTPUT');
  } finally { db.close(); }
  await f.restart();
  const detail = (await f.call('GET', `/api/counterparts/${id}`, undefined, f.session)).data;
  assert.equal(detail.modelContext.classificationAttempted, true); assert.doesNotMatch(JSON.stringify(detail), /diagnostics|private-model-or-input/);
  assert.equal(calls, 1);
});
