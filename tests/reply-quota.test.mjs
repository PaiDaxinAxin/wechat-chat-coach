import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBetaStore } from '../src/beta-store.mjs';

const PASSWORD = 'SyntheticReplyQuota2026';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'coach-reply-quota-'));
  let clock = Date.parse('2026-01-03T15:59:59.000Z');
  const settings = { dataDir: directory, now: () => clock, freeProviderDailyLimit: 100, paidProviderDailyLimit: 100, globalProviderDailyLimit: 10_000 };
  const store = createBetaStore(settings), peer = createBetaStore(settings);
  t.after(async () => { store.close(); peer.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = await store.seedOwner({ username: 'quotaowner', password: PASSWORD });
  async function account(plan = 'free') {
    return store.register({ invite: store.createInvite({ ownerId: owner.id, plan }).invite, username: `u_${randomUUID().slice(0, 8)}`, password: PASSWORD });
  }
  const object = (user) => store.putCounterpart(user.id, { alias: '虚构对象', channel: 'app', appProfile: '喜欢电影。', background: '机械测试。', offlineScene: '', rounds: 1 }).id;
  const reserve = (database, user, counterpartId, operation = 'reply', extra = {}) => database.reserveJob({ userId: user.id, counterpartId, operation, requestId: randomUUID(), contextHash: randomUUID(), knowledgeHash: 'synthetic-kb', workerId: 'fixture', providerModel: 'fixture-model', ...extra });
  const complete = (database, reserved, action = 'reply') => {
    database.markJobRunning(reserved.job.id);
    const suggestion = { id: randomUUID(), reply: ['wait', 'pause'].includes(action) ? '' : '聊一聊电影吧。', action };
    database.completeJob(reserved.job.id, { suggestion }, suggestion);
    return suggestion;
  };
  return { store, peer, owner, account, object, reserve, complete, advance: (ms) => { clock += ms; }, directory, settings };
}

test('free reply reservations are account-wide and success/cache/failure are counted exactly once', async (t) => {
  const f = await fixture(t), user = await f.account();
  const ids = Array.from({ length: 4 }, () => f.object(user));
  const results = await Promise.allSettled(ids.map(async (id, index) => f.reserve(index % 2 ? f.peer : f.store, user, id)));
  const accepted = results.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
  assert.equal(accepted.length, 3);
  assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'DAILY_REPLY_QUOTA_EXHAUSTED');
  assert.equal(f.peer.quota(user.id).dailyReplyRemaining, 0);
  f.complete(f.store, accepted[0]); f.complete(f.peer, accepted[1]);
  f.store.markJobRunning(accepted[2].job.id); f.peer.failJob(accepted[2].job.id, 'SYNTHETIC_FAILED');
  f.peer.failJob(accepted[2].job.id, 'SYNTHETIC_FAILED');
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, 1);
  const replacement = f.reserve(f.store, user, ids[2]);
  f.complete(f.store, replacement);
  assert.equal(f.peer.quota(user.id).dailyReplyRemaining, 0);
  const replay = f.reserve(f.peer, user, ids[0], 'reply', { contextHash: accepted[0].job.contextHash });
  assert.equal(replay.fresh, false); assert.equal(replay.cached, true);
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, 0);
  const other = await f.account(); assert.equal(f.store.quota(other.id).dailyReplyRemaining, 3);
});

test('Shanghai midnight resets new reservations while completion retains the request day', async (t) => {
  const f = await fixture(t), user = await f.account(), id = f.object(user);
  const before = f.reserve(f.store, user, id);
  assert.equal(f.store.quota(user.id).replyDay, '2026-01-03');
  assert.equal(f.store.quota(user.id).replyTimeZone, 'Asia/Shanghai');
  f.advance(2_000);
  assert.equal(f.peer.quota(user.id).replyDay, '2026-01-04');
  assert.equal(f.peer.quota(user.id).dailyReplyRemaining, 3);
  f.complete(f.store, before);
  assert.equal(f.peer.quota(user.id).dailyReplyRemaining, 3);
  const newDay = Array.from({ length: 3 }, () => f.reserve(f.peer, user, id));
  assert.throws(() => f.reserve(f.store, user, id), { code: 'DAILY_REPLY_QUOTA_EXHAUSTED' });
  for (const job of newDay) f.peer.failJob(job.job.id, 'SYNTHETIC_FAILED');
  f.advance(-2_000);
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, 2, 'prior-day success is durable and not moved to its completion day');
  f.advance(2_000); assert.equal(f.store.quota(user.id).dailyReplyRemaining, 3);
});

test('wait/pause and other operations retain independent bounded budgets, and plan changes do not reinterpret reservations', async (t) => {
  const f = await fixture(t), user = await f.account(), id = f.object(user);
  for (const action of ['wait', 'pause']) f.complete(f.store, f.reserve(f.store, user, id), action);
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, 3);
  assert.equal(f.store.quota(user.id).providerRemaining, 98);
  for (const operation of ['classify', 'coach_plan', 'image_read']) {
    const job = f.reserve(f.store, user, id, operation); f.store.markJobRunning(job.job.id); f.store.completeJob(job.job.id, {});
  }
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, 3); assert.equal(f.store.quota(user.id).classificationRemaining, 2);
  const startedFree = f.reserve(f.store, user, id);
  f.store.updatePlan({ ownerId: f.owner.id, userId: user.id, plan: 'paid' });
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, null);
  f.complete(f.store, startedFree);
  const startedPaid = f.reserve(f.store, user, id);
  f.store.updatePlan({ ownerId: f.owner.id, userId: user.id, plan: 'free' });
  f.complete(f.store, startedPaid);
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, 2);
  assert.equal(f.store.quota(f.owner.id).dailyReplyRemaining, null);
});

test('restart and object deletion release pending daily reservations without refunding a completed reply', async (t) => {
  const f = await fixture(t), user = await f.account(), id = f.object(user);
  f.complete(f.store, f.reserve(f.store, user, id));
  const pending = f.reserve(f.store, user, id); f.store.markJobRunning(pending.job.id);
  assert.equal(f.store.quota(user.id).dailyReplyRemaining, 1);
  const restarted = createBetaStore(f.settings);
  try {
    assert.equal(restarted.quota(user.id).dailyReplyRemaining, 1, 'merely opening a CLI/store does not recover active jobs');
    assert.equal(restarted.recoverAbandonedJobs(), 1);
    assert.equal(restarted.recoverAbandonedJobs(), 0);
    assert.equal(restarted.quota(user.id).dailyReplyRemaining, 2);
    f.reserve(f.store, user, id); restarted.deleteCounterpart(user.id, id);
    assert.equal(restarted.quota(user.id).dailyReplyRemaining, 2);
  } finally { restarted.close(); }
});
