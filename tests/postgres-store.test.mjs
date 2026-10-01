import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createPostgresStore } from '../src/postgres-store.mjs';
import { initializePostgresSchema, grantPostgresRuntimeAccess } from '../src/postgres-schema.mjs';

const connectionString = process.env.CHAT_COACH_TEST_DATABASE_URL;
const PASSWORD = 'SyntheticPostgres2026';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const profile = (style = 'Keep replies natural.') => ({ background: 'Fictional designer.', style, growthGoals: 'Express interest clearly.', relationshipGoal: 'A mutually agreed meeting.', questionnaire: { kind: 'short', answers: {} } });
const counterpart = () => ({ alias: 'Fictional peer', channel: 'app', appProfile: 'Enjoys films.', offlineScene: '', background: 'A fictional test.', rounds: 2 });
const rule = (text = 'Prefer one short question.') => ({ target: 'current_preference', text, conditions: '', limits: '' });

test('Postgres relational store preserves contracts across independent instances', { skip: !connectionString }, async (t) => {
  // A test must never initialize or mutate an existing personal/cloud database.
  const target = new URL(connectionString);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/coach_[a-z0-9_]+$/);
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 8 });
  const peerPool = new Pool({ connectionString, max: 8 });
  t.after(async () => { await pool.end(); await peerPool.end(); });
  await initializePostgresSchema(pool);
  // Re-running an explicit deployment migration is safe and retains data.
  await initializePostgresSchema(pool);
  // Keep budget assertions separate from HTTP fixtures using the real clock.
  let clock = Date.parse('2026-01-03T10:00:00Z');
  const settings = { now: () => clock, leaseMs: 60_000, freeProviderDailyLimit: 100, paidProviderDailyLimit: 100, globalProviderDailyLimit: 10_000 };
  const store = await createPostgresStore({ pool, ...settings });
  const peer = await createPostgresStore({ pool: peerPool, ...settings });
  const advance = (ms = 1_000) => { clock += ms; };
  const context = async (account) => {
    await store.putProfile(account.id, profile());
    const object = await store.putCounterpart(account.id, counterpart());
    await store.putMessage(account.id, object.id, { speaker: 'other', text: 'Hello, how was your day?' });
    return object.id;
  };
  const owner = await store.seedOwner({ username: `pg_${randomUUID().slice(0, 8)}`, password: PASSWORD });
  const account = async (plan = 'free') => {
    const { invite } = await store.createInvite({ ownerId: owner.id, plan });
    return store.register({ invite, username: `p_${randomUUID().slice(0, 8)}`, password: PASSWORD });
  };
  const reservation = async (user, counterpartId, operation = 'reply', overrides = {}) => {
    const messages = await store.listMessages(user.id, counterpartId);
    return store.reserveJob({ userId: user.id, counterpartId, operation, requestId: randomUUID(), contextHash: randomUUID(), knowledgeHash: 'private-knowledge-hash', workerId: 'test-worker', providerModel: 'fixture-model', contextSnapshot: { baseContextHash: 'base-context', modelInput: { messages }, request: { plan: 'Fictional plan.' }, knowledge: { hash: 'private-knowledge-hash' } }, ...overrides });
  };
  const suggested = async (user, counterpartId) => {
    const reserved = await reservation(user, counterpartId);
    await store.markJobRunning(reserved.job.id);
    const suggestion = { id: randomUUID(), reply: 'What film would you recommend?', reason: 'Follow the current topic.', action: 'reply', styleNote: 'A natural question.', knowledgeHash: reserved.job.knowledgeHash, contextHash: reserved.job.contextHash };
    await store.completeJob(reserved.job.id, { suggestion }, suggestion);
    return { ...await store.getSuggestion(user.id, counterpartId, suggestion.id), jobId: reserved.job.id };
  };

  await t.test('accounts, one-use invites, sessions and MCP tokens remain scoped and persistent', async () => {
    assert.equal((await store.authenticate({ username: owner.username, password: PASSWORD })).id, owner.id);
    await assert.rejects(store.authenticate({ username: owner.username, password: 'wrong' }), { code: 'LOGIN_FAILED' });
    assert.equal((await peer.getUserByUsername(owner.username.toUpperCase())).id, owner.id);
    const { invite } = await store.createInvite({ ownerId: owner.id, plan: 'free' });
    const registrations = await Promise.allSettled([store.register({ invite, username: `a_${randomUUID().slice(0, 8)}`, password: PASSWORD }), peer.register({ invite, username: `b_${randomUUID().slice(0, 8)}`, password: PASSWORD })]);
    assert.equal(registrations.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(registrations.find(({ status }) => status === 'rejected').reason.code, 'INVITE_INVALID');
    const user = registrations.find(({ status }) => status === 'fulfilled').value;
    const session = await store.createSession(user.id);
    assert.equal((await peer.lookupSession(session.token)).user.id, user.id);
    await peer.removeSession(session.token);
    assert.equal(await store.lookupSession(session.token), null);
    const first = await store.createMcpToken({ ownerId: owner.id, userId: user.id });
    assert.equal((await peer.lookupMcpToken(first.token)).id, user.id);
    const second = await peer.createMcpToken({ ownerId: owner.id, userId: user.id });
    assert.equal(await store.lookupMcpToken(first.token), null);
    assert.equal((await store.lookupMcpToken(second.token)).id, user.id);
    assert.equal((await store.updatePlan({ ownerId: owner.id, userId: user.id, plan: 'paid' })).plan, 'paid');
    assert.ok((await store.listUsers(owner.id)).some(({ id }) => id === user.id));
    await assert.rejects(peer.listUsers(user.id), { code: 'OWNER_REQUIRED' });
  });

  await t.test('context reads, message corrections, meeting state and ownership are consistent', async () => {
    const user = await account(), other = await account();
    const id = await context(user), otherId = await context(other);
    assert.equal((await peer.getProfile(user.id)).style, profile().style);
    assert.equal((await peer.listCounterparts(user.id)).length, 1);
    await store.putCounterpart(user.id, { ...counterpart(), alias: 'Updated fictional peer' }, id);
    assert.equal((await peer.getCounterpart(user.id, id)).revision, 3);
    const msg = await store.putMessage(user.id, id, { speaker: 'self', text: 'A draft.' });
    await peer.putMessage(user.id, id, { speaker: 'self', text: 'Edited draft.' }, msg.id);
    assert.equal((await store.listMessages(user.id, id)).at(-1).text, 'Edited draft.');
    await store.putMeeting(user.id, id, { status: 'proposed', time: '', place: 'Coffee', note: '' });
    assert.equal((await peer.getMeeting(user.id, id)).status, 'proposed');
    await assert.rejects(store.getCounterpart(user.id, otherId), { code: 'COUNTERPART_NOT_FOUND' });
    await assert.rejects(store.putMessage(user.id, id, { speaker: 'self', text: 'No.' }, 'missing'), { code: 'MESSAGE_NOT_FOUND' });
    await store.deleteMessage(user.id, id, msg.id);
    assert.equal((await peer.listMessages(user.id, id)).length, 1);
  });

  await t.test('composed reads keep one database snapshot while completion locks out concurrent context writes', async () => {
    const user = await account(), id = await context(user);
    await store.withSnapshot(async () => {
      assert.equal((await store.getProfile(user.id)).style, profile().style);
      await peer.putProfile(user.id, profile('A concurrent update.'));
      assert.equal((await store.getProfile(user.id)).style, profile().style, 'later reads reuse the captured snapshot');
    });
    assert.equal((await store.getProfile(user.id)).style, 'A concurrent update.');
    const pending = await reservation(user, id);
    await store.markJobRunning(pending.job.id);
    let mutation;
    await store.withTransaction(async () => {
      const before = await store.getCounterpart(user.id, id);
      mutation = peer.putMessage(user.id, id, { speaker: 'other', text: 'Concurrent context change.' });
      for (let count = 0; count < 100; count++) {
        const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND classid=1784961896 AND objid=1 AND NOT granted");
        if (waiting.rows[0].count) break;
        assert.ok(count < 99, 'the other instance must wait for the completion transaction');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal((await store.getCounterpart(user.id, id)).revision, before.revision);
      await store.completeJob(pending.job.id, { sample: 'Completed against the checked context.' });
      assert.equal((await store.getCounterpart(user.id, id)).revision, before.revision);
    });
    assert.equal((await mutation).text, 'Concurrent context change.');
    assert.equal((await store.listJobs(user.id, id)).find(({ id: jobId }) => jobId === pending.job.id).state, 'succeeded');
  });

  await t.test('cross-instance reservations share one task and charge only one call', async () => {
    const user = await account(), id = await context(user);
    const contextHash = randomUUID(), input = { userId: user.id, counterpartId: id, operation: 'classify', requestId: randomUUID(), contextHash, knowledgeHash: 'knowledge', workerId: 'one', providerModel: 'fixture' };
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? peer : store).reserveJob({ ...input, requestId: index < 4 ? input.requestId : randomUUID(), workerId: `worker-${index}` })));
    assert.equal(attempts.filter(({ fresh }) => fresh).length, 1);
    assert.equal(new Set(attempts.map(({ job }) => job.id)).size, 1);
    const jobId = attempts[0].job.id;
    assert.equal((await peer.quota(user.id)).classificationRemaining, 2);
    const runAttempts = await Promise.allSettled([store.markJobRunning(jobId), peer.markJobRunning(jobId)]);
    assert.equal(runAttempts.filter(({ status }) => status === 'fulfilled').length, 1);
    await store.completeJob(jobId, { classification: { sample: true }, heat: { sample: true } });
    assert.equal((await peer.quota(user.id)).providerRemaining, 99);
    const cached = await peer.reserveJob({ ...input, requestId: randomUUID() });
    assert.equal(cached.cached, true); assert.equal(cached.fresh, false);
    assert.equal((await store.quota(user.id)).classificationRemaining, 2);
    assert.ok(await peer.hasModelAttempt(user.id, id, 'classify', contextHash));
    assert.deepEqual((await peer.latestSuccessful(user.id, id, 'classify', contextHash)).result, cached.job.result);
    assert.equal((await peer.previousClassification(user.id, id)).id, jobId);
    await assert.rejects(peer.reserveJob({ ...input, contextHash: 'changed' }), { code: 'REQUEST_ID_CONTEXT_CONFLICT' });
  });

  await t.test('concurrent free quota and global budget reservations cannot overrun', async () => {
    const user = await account(), id = await context(user);
    const classified = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? peer : store).reserveJob({ userId: user.id, counterpartId: id, operation: 'classify', requestId: randomUUID(), contextHash: randomUUID(), knowledgeHash: 'knowledge', workerId: 'quota', providerModel: 'fixture' })));
    assert.equal(classified.filter(({ status }) => status === 'fulfilled').length, 3);
    assert.ok(classified.filter(({ status }) => status === 'rejected').every(({ reason }) => reason.code === 'CLASSIFICATION_QUOTA_EXHAUSTED'));
    for (const item of classified.filter(({ status }) => status === 'fulfilled')) await store.failJob(item.value.job.id, 'PROVIDER_TIMEOUT');
    assert.equal((await peer.quota(user.id)).classificationRemaining, 3);
    const globalBefore = Number((await pool.query("SELECT used+reserved AS used FROM chat_coach.provider_budget WHERE subject='global' AND day=$1", [new Date(clock).toISOString().slice(0, 10)])).rows[0].used);
    const limitedSettings = { ...settings, globalProviderDailyLimit: globalBefore + 2 };
    const limited = await createPostgresStore({ pool, ...limitedSettings });
    const limitedPeer = await createPostgresStore({ pool: peerPool, ...limitedSettings });
    const jobs = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => (index % 2 ? limitedPeer : limited).reserveJob({ userId: user.id, counterpartId: id, operation: 'reply', requestId: randomUUID(), contextHash: randomUUID(), knowledgeHash: 'knowledge', workerId: 'global-quota', providerModel: 'fixture' })));
    assert.equal(jobs.filter(({ status }) => status === 'fulfilled').length, 2);
    assert.ok(jobs.filter(({ status }) => status === 'rejected').every(({ reason }) => reason.code === 'PROVIDER_BUDGET_EXHAUSTED'));
    for (const item of jobs.filter(({ status }) => status === 'fulfilled')) await limited.failJob(item.value.job.id, 'CANCELLED');
  });

  await t.test('cold start preserves active jobs; lease expiry releases reservations without refunding started calls or retrying', async () => {
    const user = await account(), id = await context(user);
    const reserved = await reservation(user, id, 'classify');
    const running = await reservation(user, id, 'classify');
    await store.markJobRunning(running.job.id);
    const restarted = await createPostgresStore({ pool: peerPool, ...settings });
    assert.equal(await restarted.recoverExpiredJobs(), 0);
    assert.equal((await restarted.listJobs(user.id, id)).filter(({ state }) => ['reserved', 'running'].includes(state)).length, 2);
    advance(60_001);
    assert.equal(await restarted.recoverAbandonedJobs(), 2);
    assert.equal((await restarted.quota(user.id)).classificationRemaining, 3);
    assert.equal((await restarted.quota(user.id)).providerRemaining, 99);
    assert.ok((await restarted.listJobs(user.id, id)).every(({ state, errorCode }) => state === 'failed' && errorCode === 'JOB_INTERRUPTED'));
    await assert.rejects(store.completeJob(running.job.id, { invalidLateResult: true }), { code: 'JOB_NOT_AVAILABLE' });
    const replay = await peer.reserveJob({ userId: user.id, counterpartId: id, operation: 'classify', requestId: reserved.job.requestId, contextHash: reserved.job.contextHash, knowledgeHash: reserved.job.knowledgeHash, workerId: 'restart', providerModel: 'fixture' });
    assert.equal(replay.fresh, false); assert.equal(replay.job.state, 'failed');
    assert.equal((await restarted.listJobs(user.id, id)).length, 2);
  });

  await t.test('followup, copy receipts and immutable evidence retain atomic replay and clock provenance', async () => {
    const user = await account(), id = await context(user), other = await account(), otherId = await context(other);
    const suggestion = await suggested(user, id);
    const source = await peer.getSuggestionCase(user.id, id, suggestion.id);
    assert.equal(source.status, 'complete');
    advance(30_000);
    const copyInput = { copiedText: 'My edited draft.', requestId: randomUUID() };
    const copies = await Promise.all([store.recordReplyCopy(user.id, id, suggestion.id, copyInput), peer.recordReplyCopy(user.id, id, suggestion.id, copyInput)]);
    assert.equal(copies.filter(({ cached }) => !cached).length, 1);
    assert.equal(copies[0].copyReceipt.id, copies[1].copyReceipt.id);
    await assert.rejects(peer.recordReplyCopy(user.id, id, suggestion.id, { ...copyInput, copiedText: 'Changed' }), { code: 'COPY_REQUEST_CONFLICT' });
    advance(3_600_000);
    const input = { text: 'A fictional followup.', requestId: randomUUID(), previousSuggestionId: suggestion.id, previousReplyText: copyInput.copiedText, previousCopyReceiptId: copies[0].copyReceipt.id };
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 ? peer : store).recordFollowup(user.id, id, input)));
    assert.equal(results.filter(({ cached }) => !cached).length, 1);
    const result = results[0];
    assert.equal(result.previousMessage.provenance, 'inferred_from_followup');
    assert.equal(result.timing.elapsedMs, 3_600_000); assert.equal(result.timing.reliability, 'app_interval_estimate');
    assert.equal((await peer.listMessages(user.id, id)).length, 3);
    const raw = await peer.getFeedback(owner.id, result.feedback.id);
    assert.equal(raw.stage, 'raw_untrusted'); assert.equal(raw.raw.consent, false); assert.equal(raw.raw.outcome, 'unknown');
    assert.deepEqual(raw.caseEvidence.snapshot, source.snapshot);
    assert.equal(raw.caseEvidence.snapshotHash, digest(JSON.stringify(source.snapshot)));
    assert.equal((await peer.recordFollowup(user.id, id, { ...input, requestId: randomUUID() })).cached, true);
    await assert.rejects(peer.recordFollowup(user.id, id, { ...input, text: 'Different.' }), { code: 'FOLLOWUP_REQUEST_CONFLICT' });
    await assert.rejects(peer.recordFollowup(user.id, id, { ...input, requestId: randomUUID(), text: 'Different.' }), { code: 'FOLLOWUP_SOURCE_ALREADY_LINKED' });
    await assert.rejects(peer.recordFollowup(other.id, otherId, input), { code: 'SUGGESTION_NOT_FOUND' });
    assert.equal((await peer.listMessages(other.id, otherId)).length, 1);
    const originalAt = result.message.recordedAt;
    await store.putMessageTime(user.id, id, result.previousMessage.id, new Date(clock - 2_000_000).toISOString());
    const reported = await peer.putMessageTime(user.id, id, result.message.id, new Date(clock - 1_000_000).toISOString());
    assert.equal(reported.recordedAt, originalAt); assert.equal(reported.replyInterval.elapsedMs, 1_000_000); assert.equal(reported.replyInterval.reliability, 'user_reported_interval');
    assert.equal((await peer.getFeedback(owner.id, result.feedback.id)).raw.caseEvidence.counterpartMessage.wechatTime, null);
    await assert.rejects(store.putMessageTime(user.id, id, result.message.id, new Date(clock + 1).toISOString()), { code: 'MESSAGE_TIME_INVALID' });
    await store.putMessage(user.id, id, { speaker: 'other', text: 'Corrected speaker.' }, result.previousMessage.id);
    assert.equal((await peer.listMessages(user.id, id)).at(-1).replyInterval, null);
    await assert.rejects(pool.query('UPDATE chat_coach.model_jobs SET context_snapshot_json=$1 WHERE id=$2', ['{}', source.originJobId]), /IMMUTABLE_CASE_SNAPSHOT/);
  });

  await t.test('failed followup rolls back messages, feedback, touches and receipts together', async () => {
    const user = await account(), id = await context(user), suggestion = await suggested(user, id);
    const before = await store.getCounterpart(user.id, id);
    await pool.query("CREATE OR REPLACE FUNCTION chat_coach.reject_test_followup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = 'postgres_atomic_failure' THEN RAISE EXCEPTION 'SYNTHETIC_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_followup_failure BEFORE INSERT ON chat_coach.followup_receipts FOR EACH ROW EXECUTE FUNCTION chat_coach.reject_test_followup()");
    try {
      await assert.rejects(store.recordFollowup(user.id, id, { requestId: 'postgres_atomic_failure', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply, text: 'A fictional followup.' }), /SYNTHETIC_RECEIPT_FAILURE/);
      assert.equal((await peer.listMessages(user.id, id)).length, 1);
      assert.equal((await peer.getCounterpart(user.id, id)).revision, before.revision);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM chat_coach.feedback WHERE user_id=$1', [user.id])).rows[0].count, 0);
    } finally {
      await pool.query('DROP TRIGGER test_followup_failure ON chat_coach.followup_receipts; DROP FUNCTION chat_coach.reject_test_followup()');
    }
  });

  await t.test('profile/style saves are atomic CAS receipts; only adopted abstract rules apply', async () => {
    const user = await account(), id = await context(user), suggestion = await suggested(user, id);
    const current = await peer.getStyleLearning(user.id);
    const request = { requestId: randomUUID(), expectedRevision: current.revision, review: { counterpartId: id, suggestionId: suggestion.id, ownVersion: 'A private alternative.', reasonKind: 'style', styleFit: 'unlike', willingness: 'try' }, ruleChange: { type: 'propose', rule: rule() } };
    const saves = await Promise.all([store.saveProfileAndStyle(user.id, profile(), request), peer.saveProfileAndStyle(user.id, profile(), request)]);
    assert.equal(saves.filter(({ styleLearning }) => !styleLearning.cached).length, 1);
    const candidate = saves[0].styleLearning.rules[0], review = saves[0].styleLearning.reviews[0];
    assert.equal(candidate.status, 'candidate'); assert.equal(review.originalSuggestion.reply, suggestion.reply);
    assert.deepEqual(review.replyObservation, { status: 'unknown', assessment: 'unassessed', messageIds: [] });
    assert.equal(await peer.getAppliedPersonalStyle(user.id), undefined);
    await assert.rejects(peer.saveProfileAndStyle(user.id, profile('Changed'), request), { code: 'STYLE_REQUEST_CONFLICT' });
    await assert.rejects(peer.saveProfileAndStyle(user.id, profile(), { requestId: randomUUID(), expectedRevision: current.revision }), { code: 'STYLE_REVISION_CONFLICT' });
    let state = await peer.getStyleLearning(user.id);
    await assert.rejects(peer.saveProfileAndStyle(user.id, profile('Must roll back.'), { requestId: randomUUID(), expectedRevision: state.revision, ruleChange: { type: 'adopt', candidateId: 'missing' } }), { code: 'STYLE_RULE_NOT_FOUND' });
    assert.equal((await store.getProfile(user.id)).style, profile().style);
    assert.equal((await store.getStyleLearning(user.id)).revision, state.revision);
    await peer.saveProfileAndStyle(user.id, profile(), { requestId: randomUUID(), expectedRevision: state.revision, ruleChange: { type: 'adopt', candidateId: candidate.id } });
    assert.deepEqual((await store.getAppliedPersonalStyle(user.id)).rules, [rule()]);
    state = await store.getStyleLearning(user.id);
    const changed = await store.saveProfileAndStyle(user.id, profile(), { requestId: randomUUID(), expectedRevision: state.revision, ruleChange: { type: 'adopt_new', supersedesId: candidate.id, rule: rule('A new preference.') } });
    assert.equal(changed.styleLearning.rules.find(({ id: ruleId }) => ruleId === candidate.id).status, 'revoked');
    const replacement = changed.styleLearning.rules.find(({ status }) => status === 'adopted');
    await peer.saveProfileAndStyle(user.id, profile(), { requestId: randomUUID(), expectedRevision: changed.styleLearning.revision, ruleChange: { type: 'revoke', ruleId: replacement.id } });
    assert.equal(await store.getAppliedPersonalStyle(user.id), undefined);
    await assert.rejects(pool.query('UPDATE chat_coach.style_reviews SET value_json=$1 WHERE id=$2', ['{}', review.id]), /IMMUTABLE_STYLE_REVIEW/);
    await assert.rejects(pool.query('UPDATE chat_coach.style_rules SET value_json=$1 WHERE id=$2', ['{}', candidate.id]), /IMMUTABLE_STYLE_RULE/);
  });

  await t.test('free daily reply reservations stay atomic across objects and instances, release once and preserve request-day accounting', async () => {
    const user = await account(), ids = await Promise.all(Array.from({ length: 4 }, () => context(user)));
    const attempts = await Promise.allSettled(ids.map((id, index) => (index % 2 ? peer : store).reserveJob({ userId: user.id, counterpartId: id, operation: 'reply', requestId: randomUUID(), contextHash: randomUUID(), knowledgeHash: 'synthetic', workerId: 'fixture', providerModel: 'fixture-model' })));
    const accepted = attempts.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
    assert.equal(accepted.length, 3);
    assert.equal(attempts.find(({ status }) => status === 'rejected').reason.code, 'DAILY_REPLY_QUOTA_EXHAUSTED');
    assert.equal((await peer.quota(user.id)).dailyReplyRemaining, 0);
    for (const reserved of accepted.slice(0, 2)) {
      await store.markJobRunning(reserved.job.id);
      const suggestion = { id: randomUUID(), action: 'reply', reply: 'Synthetic sendable reply.' };
      await peer.completeJob(reserved.job.id, { suggestion }, suggestion);
    }
    await store.markJobRunning(accepted[2].job.id);
    await peer.failJob(accepted[2].job.id, 'SYNTHETIC_FAILED'); await store.failJob(accepted[2].job.id, 'SYNTHETIC_FAILED');
    assert.equal((await peer.quota(user.id)).dailyReplyRemaining, 1);
    const cached = await reservation(user, ids.find((id) => id === accepted[0].job.counterpartId), 'reply', { contextHash: accepted[0].job.contextHash });
    assert.equal(cached.fresh, false); assert.equal((await peer.quota(user.id)).dailyReplyRemaining, 1);
    const requestDayUser = await account(), requestDayId = await context(requestDayUser), originalClock = clock;
    clock = Date.parse('2026-01-03T15:59:59Z');
    try {
      const reserved = await reservation(requestDayUser, requestDayId);
      assert.equal((await peer.quota(requestDayUser.id)).replyDay, '2026-01-03');
      advance(2_000);
      assert.equal((await peer.quota(requestDayUser.id)).replyDay, '2026-01-04');
      assert.equal((await peer.quota(requestDayUser.id)).dailyReplyRemaining, 3);
      await store.markJobRunning(reserved.job.id);
      const suggestion = { id: randomUUID(), action: 'reply', reply: 'A reply crossing midnight.' };
      await peer.completeJob(reserved.job.id, { suggestion }, suggestion);
      assert.equal((await peer.quota(requestDayUser.id)).dailyReplyRemaining, 3);
      advance(-2_000); assert.equal((await store.quota(requestDayUser.id)).dailyReplyRemaining, 2);
      advance(2_000);
      const expires = await reservation(requestDayUser, requestDayId); await store.markJobRunning(expires.job.id);
      advance(60_001); assert.equal(await peer.recoverExpiredJobs(), 1);
      assert.equal((await store.quota(requestDayUser.id)).dailyReplyRemaining, 3);
      assert.equal((await store.quota(requestDayUser.id)).replyTimeZone, 'Asia/Shanghai');
    } finally { clock = originalClock; }
  });

  await t.test('message annotations retain original facts and immutable source, including same-clock clear and deliberate copy recovery', async () => {
    const user = await account('paid'), stranger = await account(), id = await context(user), message = (await store.listMessages(user.id, id))[0];
    const suggestion = await suggested(user, id), immutable = (await peer.getSuggestionCase(user.id, id, suggestion.id)).snapshot;
    await store.recordReplyCopy(user.id, id, suggestion.id, { requestId: randomUUID() });
    const annotated = await peer.putMessageAnnotation(user.id, id, message.id, '这是本人提供的线下背景。🙂');
    const { annotation, annotationRevision, annotationUpdatedAt, ...facts } = annotated;
    assert.deepEqual(facts, message); assert.equal(annotation.source, 'user_annotation'); assert.equal(annotationRevision, 1);
    await assert.rejects(peer.putMessageAnnotation(stranger.id, id, message.id, '越权'), { code: 'COUNTERPART_NOT_FOUND' });
    assert.equal((await store.getSuggestion(user.id, id, suggestion.id)).pendingEligible, false);
    const cleared = await store.putMessageAnnotation(user.id, id, message.id, '');
    assert.equal(cleared.annotation, undefined); assert.equal(cleared.annotationRevision, 2); assert.equal(cleared.annotationUpdatedAt, annotationUpdatedAt);
    assert.equal((await peer.getSuggestion(user.id, id, suggestion.id)).pendingEligible, false);
    const newSuggestion = await suggested(user, id);
    assert.equal(newSuggestion.pendingEligible, true, 'a new snapshot captures the cleared receipt even at the same timestamp');
    assert.deepEqual((await peer.getSuggestionCase(user.id, id, suggestion.id)).snapshot, immutable);
    const stale = await peer.recordFollowup(user.id, id, { requestId: randomUUID(), text: 'New recorded other message.', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply });
    assert.equal(stale.previousMessage, null); assert.equal(stale.feedback, null);
    advance(1); await store.recordReplyCopy(user.id, id, suggestion.id, { requestId: randomUUID() });
    assert.equal((await peer.getSuggestion(user.id, id, suggestion.id)).pendingEligible, true);
    const row = (await pool.query('SELECT annotation_json,annotation_revision FROM chat_coach.messages WHERE id=$1', [message.id])).rows[0];
    assert.equal(row.annotation_json, null); assert.equal(row.annotation_revision, 2);
  });

  await t.test('copy receipts capture annotation versions across clock regressions, replay and legacy recovery', async () => {
    const originalClock = clock;
    try {
      const user = await account('paid'), id = await context(user), message = (await store.listMessages(user.id, id))[0];
      const suggestion = await suggested(user, id);
      advance(1_000);
      const oldInput = { requestId: randomUUID() };
      const old = await store.recordReplyCopy(user.id, id, suggestion.id, oldInput);
      advance(-5_000);
      await peer.putMessageAnnotation(user.id, id, message.id, 'First user annotation.');
      assert.equal((await store.getSuggestion(user.id, id, suggestion.id)).pendingEligible, false);
      assert.equal((await peer.recordReplyCopy(user.id, id, suggestion.id, oldInput)).cached, true);
      assert.equal((await store.getSuggestion(user.id, id, suggestion.id)).pendingEligible, false);
      await store.putMessageAnnotation(user.id, id, message.id, '');
      const afterClear = { requestId: randomUUID() };
      const copied = await peer.recordReplyCopy(user.id, id, suggestion.id, afterClear);
      assert.ok(copied.copyReceipt.copiedAt < old.copyReceipt.copiedAt);
      assert.equal((await store.getSuggestion(user.id, id, suggestion.id)).pendingCopyReceiptId, copied.copyReceipt.id);
      advance(-5_000);
      await store.putMessageAnnotation(user.id, id, message.id, 'A subsequent annotation.');
      assert.equal((await peer.getSuggestion(user.id, id, suggestion.id)).pendingEligible, false);
      assert.equal((await peer.recordReplyCopy(user.id, id, suggestion.id, afterClear)).cached, true);
      assert.equal((await peer.getSuggestion(user.id, id, suggestion.id)).pendingEligible, false);
      const stale = await store.recordFollowup(user.id, id, { requestId: randomUUID(), text: 'A new other record.', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply, previousCopyReceiptId: copied.copyReceipt.id });
      assert.equal(stale.previousMessage, null); assert.equal(stale.feedback, null);
      const fresh = await peer.recordReplyCopy(user.id, id, suggestion.id, { requestId: randomUUID() });
      assert.equal((await store.getSuggestion(user.id, id, suggestion.id)).pendingCopyReceiptId, fresh.copyReceipt.id);
      const captured = (await pool.query('SELECT annotation_revisions_json FROM chat_coach.reply_copy_receipts WHERE id=$1', [fresh.copyReceipt.id])).rows[0];
      assert.deepEqual(JSON.parse(captured.annotation_revisions_json), { [message.id]: 3 });
      await pool.query('UPDATE chat_coach.reply_copy_receipts SET annotation_revisions_json=NULL WHERE id=$1', [fresh.copyReceipt.id]);
      assert.equal((await peer.getSuggestion(user.id, id, suggestion.id)).pendingEligible, false);
      const restored = await store.recordReplyCopy(user.id, id, suggestion.id, { requestId: randomUUID() });
      const followup = { requestId: randomUUID(), text: 'Another recorded reply.', previousSuggestionId: suggestion.id, previousReplyText: suggestion.reply, previousCopyReceiptId: restored.copyReceipt.id };
      const accepted = await peer.recordFollowup(user.id, id, followup);
      assert.equal(accepted.previousMessage.provenance, 'inferred_from_followup');
      assert.equal((await store.recordFollowup(user.id, id, followup)).previousMessage.id, accepted.previousMessage.id);
      assert.equal((await pool.query('SELECT annotation_revisions_json FROM chat_coach.reply_copy_receipts WHERE id=$1', [old.copyReceipt.id])).rows[0].annotation_revisions_json, '{}');
    } finally { clock = originalClock; }
  });

  await t.test('current job selection across topic request modes uses durable order for ties and clock regressions', async () => {
    const user = await account('paid'), id = await context(user), hashes = [randomUUID(), randomUUID()];
    for (let index = 0; index < 2; index++) {
      if (index) advance(-1);
      const reserved = await reservation(user, id, 'classify', { contextHash: hashes[index] });
      await store.markJobRunning(reserved.job.id); await peer.completeJob(reserved.job.id, { ordinal: index, heat: { status: index ? 'pause' : 'potential' } });
    }
    assert.equal((await peer.latestSuccessfulForContexts(user.id, id, 'classify', hashes)).result.ordinal, 1);
    const previous = await peer.previousClassification(user.id, id);
    assert.equal(previous.result.heat.status, 'pause');
    assert.equal(previous.contextSnapshot.knowledge.hash, 'private-knowledge-hash');
    assert.ok(!(await peer.listJobs(user.id, id)).some((job) => 'contextSnapshot' in job));
    const tied = await reservation(user, id, 'classify');
    await store.markJobRunning(tied.job.id); await peer.completeJob(tied.job.id, { ordinal: 2, heat: { status: 'pause' } });
    assert.equal((await store.previousClassification(user.id, id)).id, tied.job.id, 'The later durable observation wins a same-clock tie');
    await assert.rejects(peer.latestSuccessfulForContexts(owner.id, id, 'classify', hashes), { code: 'COUNTERPART_NOT_FOUND' });
  });

  await t.test('feedback cleaning, deduplication and owner approval remain traceable and isolated', async () => {
    const user = await account(), id = await context(user), suggestion = await suggested(user, id);
    await store.putMessage(user.id, id, { speaker: 'self', text: suggestion.reply, suggestionId: suggestion.id });
    assert.equal((await store.findSentMessage(user.id, id, suggestion.id, suggestion.reply)).provenance, 'user_confirmed_record');
    const raw = { suggestionId: suggestion.id, actualSentText: suggestion.reply, counterpartReply: 'A response.', observation: 'Synthetic evidence.', kind: 'uncertain', consent: true };
    const added = await store.addFeedback(user.id, id, raw);
    await assert.rejects(peer.getFeedback(user.id, added.id), { code: 'OWNER_REQUIRED' });
    assert.ok((await peer.listFeedback(owner.id)).some(({ id: feedbackId }) => feedbackId === added.id));
    const cleaning = { stage: 'cleaned', dedupKey: randomUUID(), transformations: [], allowedPurposes: ['knowledge'] };
    await store.saveCleaning(owner.id, added.id, cleaning);
    const duplicate = await peer.addFeedback(user.id, id, raw);
    assert.equal((await peer.saveCleaning(owner.id, duplicate.id, cleaning)).cleaning.stage, 'quarantined');
    const receipt = { stage: 'approved_candidate', purpose: 'knowledge' };
    const approval = await store.beginKnowledgeApproval(owner.id, added.id, 'review-hash', receipt, 'A reviewed synthetic supplement.');
    assert.equal(approval.state, 'pending');
    assert.equal((await peer.getKnowledgeApproval(owner.id, added.id)).review_hash, 'review-hash');
    await assert.rejects(peer.beginKnowledgeApproval(owner.id, added.id, 'other-hash', receipt, 'Other'), { code: 'REVIEW_CONFLICT' });
    await assert.rejects(peer.saveCleaning(owner.id, added.id, cleaning), { code: 'FEEDBACK_ALREADY_REVIEWED' });
    assert.equal((await peer.finishKnowledgeApproval(owner.id, added.id, 'final-knowledge-hash')).review.knowledgeHash, 'final-knowledge-hash');
    assert.equal((await store.finishKnowledgeApproval(owner.id, added.id, 'final-knowledge-hash')).review.knowledgeHash, 'final-knowledge-hash');
    const rejected = await store.saveReview(owner.id, duplicate.id, { stage: 'rejected', purpose: 'evaluation' });
    assert.equal(rejected.review.reviewerId, owner.id);
  });

  await t.test('plan results, rate limits and cascading deletion retain their distinct contracts', async () => {
    const user = await account(), id = await context(user), suggestion = await suggested(user, id);
    const plan = await reservation(user, id, 'coach_plan');
    await store.markJobRunning(plan.job.id);
    await store.completeJob(plan.job.id, { planAssessment: { verdict: 'wait' } });
    assert.deepEqual(await peer.latestCoachPlan(user.id, id, 'base-context'), { plan: 'Fictional plan.', planAssessment: { verdict: 'wait' } });
    const limitKey = randomUUID();
    const limited = await Promise.all(Array.from({ length: 9 }, (_, index) => (index % 2 ? peer : store).takeRateLimit({ key: limitKey, limit: 3 })));
    assert.equal(limited.filter(({ allowed }) => allowed).length, 3);
    advance(60_001);
    assert.equal((await peer.takeRateLimit({ key: limitKey, limit: 3 })).allowed, true);
    await store.recordReplyCopy(user.id, id, suggestion.id, { requestId: randomUUID() });
    const pending = await reservation(user, id, 'classify');
    assert.equal((await peer.quota(user.id)).classificationRemaining, 2);
    await peer.deleteCounterpart(user.id, id);
    assert.equal((await store.quota(user.id)).classificationRemaining, 3);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM chat_coach.model_jobs WHERE id=$1', [pending.job.id])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM chat_coach.reply_copy_receipts WHERE counterpart_id=$1', [id])).rows[0].count, 0);
    await assert.rejects(store.getCounterpart(user.id, id), { code: 'COUNTERPART_NOT_FOUND' });
  });

  await t.test('wait and pause reject copies and preserve incoming text without inferring legacy or guided drafts', async () => {
    for (const action of ['wait', 'pause']) for (const legacy of [false, true]) {
      const user = await account(), id = await context(user), reserved = await reservation(user, id);
      await store.markJobRunning(reserved.job.id);
      const suggestion = { id: randomUUID(), reply: legacy ? 'Legacy closing text.' : '', action, reason: 'Do not send.', styleNote: 'Wait.', ...(!legacy ? { guidance: { topicMove: null, relationMove: action, ownWordsGuide: 'Do not send.', reentryWhen: 'When new evidence warrants it.' } } : {}) };
      await store.completeJob(reserved.job.id, { suggestion }, suggestion);
      await assert.rejects(peer.recordReplyCopy(user.id, id, suggestion.id, { requestId: randomUUID(), copiedText: 'Stale client text.' }), { code: 'SUGGESTION_NOT_SENDABLE' });
      const copyId = randomUUID();
      // A receipt created by an older server must not revive a pacing suggestion.
      await pool.query('INSERT INTO chat_coach.reply_copy_receipts(id,user_id,counterpart_id,suggestion_id,request_id,payload_hash,copied_text,copied_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [copyId, user.id, id, suggestion.id, randomUUID(), 'legacy-copy', 'Stale client text.', new Date(clock).toISOString()]);
      const read = await peer.getSuggestion(user.id, id, suggestion.id);
      assert.equal(read.pendingEligible, false); assert.equal(read.pendingCopyReceiptId, null); assert.equal(read.pendingReplyText, null);
      const input = { requestId: randomUUID(), text: 'The actual next message.', previousSuggestionId: suggestion.id, previousReplyText: 'Stale client text.', previousCopyReceiptId: copyId };
      const results = await Promise.all([store.recordFollowup(user.id, id, input), peer.recordFollowup(user.id, id, input)]);
      assert.equal(results.filter(({ cached }) => !cached).length, 1);
      for (const result of results) {
        assert.equal(result.message.text, input.text); assert.equal(result.previousMessage, null); assert.equal(result.feedback, null);
        assert.equal(result.timing.fromAt, null); assert.equal(result.timing.reliability, 'unknown');
      }
      assert.deepEqual((await peer.listMessages(user.id, id)).map(({ speaker }) => speaker), ['other', 'other']);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_coach.feedback WHERE counterpart_id=$1', [id])).rows[0].n, 0);
      await store.putMessage(user.id, id, { speaker: 'self', text: 'An independently recorded actual self message.' });
      const next = await peer.recordFollowup(user.id, id, { ...input, requestId: randomUUID(), text: 'Another actual message.' });
      assert.equal(next.previousMessage, null);
      assert.deepEqual((await peer.listMessages(user.id, id)).map(({ speaker }) => speaker), ['other', 'other', 'self', 'other']);
    }
  });

  await t.test('suggestion history retains insertion order for equal timestamps and a backward clock', async () => {
    const user = await account(), id = await context(user), suffix = randomUUID();
    async function complete(suggestionId, action) {
      const reserved = await reservation(user, id);
      await store.markJobRunning(reserved.job.id);
      const suggestion = { id: suggestionId, reply: action === 'reply' ? 'A synthetic reply.' : '', action, reason: 'Fictional pacing.', styleNote: 'Test only.' };
      await store.completeJob(reserved.job.id, { suggestion }, suggestion);
    }
    const ids = [`z-first-${suffix}`, `a-second-${suffix}`, `0-last-${suffix}`];
    await complete(ids[0], 'reply'); await complete(ids[1], 'wait');
    const tied = await peer.listSuggestions(user.id, id);
    assert.equal(tied[0].createdAt, tied[1].createdAt);
    assert.deepEqual(tied.map(({ id }) => id), ids.slice(0, 2));
    advance(-1);
    try {
      await complete(ids[2], 'pause');
      const history = await peer.listSuggestions(user.id, id);
      assert.ok(history[2].createdAt < history[0].createdAt);
      assert.deepEqual(history.map(({ id }) => id), ids);
      await initializePostgresSchema(pool);
      assert.deepEqual((await store.listSuggestions(user.id, id)).map(({ id }) => id), ids, 'An idempotent migration retains the established order');
    } finally { advance(1); }
  });

  await t.test('runtime role can use the store but cannot create tables or expose records to an untrusted role', async () => {
    await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='chat_coach_app') THEN CREATE ROLE chat_coach_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='chat_coach_test_untrusted') THEN CREATE ROLE chat_coach_test_untrusted NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$");
    await grantPostgresRuntimeAccess(pool);
    const appPool = new Pool({ connectionString, options: '-c role=chat_coach_app', max: 2 });
    const untrusted = new Pool({ connectionString, options: '-c role=chat_coach_test_untrusted', max: 1 });
    try {
      const app = await createPostgresStore({ pool: appPool, ...settings });
      const user = await account(), id = await context(user);
      assert.equal((await app.getProfile(user.id)).style, profile().style);
      const message = await app.putMessage(user.id, id, { speaker: 'self', text: 'Runtime role fixture.' });
      assert.equal((await app.listMessages(user.id, id)).at(-1).id, message.id);
      const job = await app.reserveJob({ userId: user.id, counterpartId: id, operation: 'reply', requestId: randomUUID(), contextHash: randomUUID(), knowledgeHash: 'fixture', workerId: 'least-privilege', providerModel: 'fixture' });
      await app.markJobRunning(job.job.id);
      const suggestion = { id: randomUUID(), reply: 'Runtime fixture.', action: 'reply', reason: 'Test only.', styleNote: 'Synthetic.' };
      await app.completeJob(job.job.id, { suggestion }, suggestion);
      assert.equal((await app.listSuggestions(user.id, id)).at(-1).id, suggestion.id, 'The runtime grant covers the new suggestion identity sequence');
      await assert.rejects(appPool.query('CREATE TABLE chat_coach.forbidden_test(id INTEGER)'), { code: '42501' });
      await assert.rejects(untrusted.query('SELECT * FROM chat_coach.users'), { code: '42501' });
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='chat_coach' AND NOT rowsecurity")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) acl WHERE n.nspname='chat_coach' AND acl.grantee=0 AND acl.privilege_type='USAGE'")).rows[0].count, 0);
    } finally { await appPool.end(); await untrusted.end(); }
  });

  await store.close();
  assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1, 'the caller retains ownership of its pool');
});
