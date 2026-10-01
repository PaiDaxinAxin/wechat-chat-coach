import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createBetaServer, seedOwner } from '../src/beta-api.mjs';
import { QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Isolated first-party style learning. All model functions are synthetic, and no
// provider credentials, real user records or production knowledge are changed.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-style-ui-'));
const evidenceDir = join(process.cwd(), 'runs/browser-style');
let server, browser;
try {
  const knowledge = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md');
  await writeFile(knowledgePath, knowledge); await mkdir(evidenceDir, { recursive: true });
  const contexts = [];
  let classifications = 0, replies = 0;
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, paidProviderDailyLimit: 20,
    classifyFn: async (context, options) => {
      classifications++; assert.equal(options.knowledgeText, knowledge); contexts.push(context);
      const id = context.messages.at(-1).id, observed = { level: 'positive', evidenceIds: [id] };
      return { status: 'ready', confidence: 'moderate', phase: 'ordinary', obstacle: { type: 'none', evidenceIds: [], reason: '合成对话仍在展开。' },
        heat: { activeInteraction: observed, responseEngagement: observed, personalInterest: observed, reciprocalFlirting: { level: 'unknown', evidenceIds: [] }, actionFollowThrough: { level: 'unknown', evidenceIds: [] } },
        topicDecision: { mode: 'change', reason: '合成换题局面，用于三方向与并发回归。' },
        options: [['up', .6], ['down', .1], ['sideways', .3]].map(([topicMove, weight]) => ({ topicMove, weight, relationAction: 'continue', reason: '顺着当前话题了解。', evidenceIds: [id] })),
        uncertainties: ['效果未知。'], recommendationKind: 'uncalibrated' };
    },
    replyFn: async ({ context }, options) => {
      replies++; contexts.push(context); assert.equal(options.knowledgeText, knowledge);
      assert.equal(JSON.parse(context.userProfile).questionnaire.answers.length, 10);
      return { reply: '我也喜欢把事情做好。你最近在忙哪个项目？', reason: '分享一句真实感受后继续了解。', action: 'reply', styleNote: '简短自然的合成建议。' };
    },
  });
  const password = 'SyntheticPassword2026';
  const owner = await seedOwner(server.betaStore, { username: 'style-owner', password });
  const profile = { background: '虚构设计工作，喜欢散步。', style: '简短直接，说真实经历。', growthGoals: '练习自然表达兴趣。', relationshipGoal: '先认识，再协商见面。', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 4])) } };
  server.betaStore.putProfile(owner.id, validateProfile(profile, 'paid'));
  const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' }).invite;
  const otherUser = await server.betaStore.register({ invite, username: 'style-other', password });
  server.betaStore.putProfile(otherUser.id, validateProfile(profile, 'paid'));
  const primary = server.betaStore.putCounterpart(owner.id, { alias: '虚构对象一', channel: 'other', background: '朋友活动认识，聊过工作。', appProfile: '', offlineScene: '', rounds: 2 });
  const secondary = server.betaStore.putCounterpart(owner.id, { alias: '虚构对象二', channel: 'other', background: '读书活动认识。', appProfile: '', offlineScene: '', rounds: 1 });
  for (const counterpart of [primary, secondary]) server.betaStore.putMessage(owner.id, counterpart.id, { speaker: 'other', text: '最近一直在忙工作。' });
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, colorScheme: 'light' });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const counts = () => [classifications, replies];
  async function get(path) { const response = await context.request.get(origin + path); assert.equal(response.status(), 200); return (await response.json()).data; }
  async function mutation(path, method, body) { const me = await get('/api/me'); return context.request.fetch(origin + path, { method, headers: { origin, 'x-csrf-token': me.csrfToken }, data: body }); }
  async function response(path, method, action, status = 200) {
    const pending = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === method);
    await action(); const received = await pending, payload = await received.json(); assert.equal(received.status(), status, JSON.stringify(payload)); return payload.data || payload.error;
  }
  async function settleProfile() { await page.waitForFunction(() => !document.querySelector('#profile-form > button[type=submit]').disabled); }
  async function login(username) {
    await page.locator('#username').fill(username); await page.locator('#password').fill(password);
    await response('/api/login', 'POST', () => page.locator('#auth-submit').click());
    await page.locator('#workspace').waitFor({ state: 'visible' });
  }
  async function openPreferences() {
    if (!await page.locator('#field-coach').isVisible()) await page.locator('#toggle-field-coach').click();
    const summary = page.locator('.style-entry > summary');
    if (!await page.locator('#open-style-preferences').isVisible()) await summary.click();
    await page.locator('#open-style-preferences').click();
    await page.locator('#style-rule-text').waitFor({ state: 'visible' });
  }
  const save = () => page.locator('#profile-form > button[type=submit]').click();
  await page.goto(origin); await login('style-owner');
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  const id = await page.locator('#counterpart-select').inputValue(), secondId = id === primary.id ? secondary.id : primary.id;
  await response(`/api/counterparts/${id}/reply`, 'POST', () => page.locator('[data-direction=down]').click());
  await page.locator('#suggestion-panel').waitFor({ state: 'visible' });
  const original = await page.locator('#suggestion-text').inputValue(), ownVersion = '我最近也在做设计。你最投入的项目是什么？';
  await page.locator('#suggestion-text').fill(ownVersion);
  await page.locator('.message').first().locator('.message-menu > summary').click(); await page.locator('.message').first().getByRole('button', { name: '编辑对方的消息', exact: true }).click();
  await page.locator('#message-speaker').selectOption('self'); await page.locator('#message-text').fill('尚未提交的本人原话');
  await page.locator('#field-coach-plan').fill('尚未提交的主导计划');
  await openPreferences();
  assert.equal(await page.locator('#style-original').textContent(), original);
  assert.equal(await page.locator('#style-own-version').inputValue(), ownVersion);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'style-own-version');
  assert.ok((await page.locator('#style-case').textContent()).includes('发送未确认'));
  await page.locator('#style-fit').selectOption('unlike'); await page.locator('#style-willingness').selectOption('try');
  await page.locator('#style-reason-kind').selectOption('style'); await page.locator('#style-why').fill('愿意练习分享自己的经历，但不用夸张语气。');
  const candidateText = '先分享一句自己的真实经历，再问一处细节。';
  await page.locator('#style-rule-text').fill(candidateText); await page.locator('#style-rule-conditions').fill('对方正在展开具体话题时');
  assert.equal(await page.locator('#style-apply').isChecked(), false);
  const beforeCandidate = counts(); let lostBody;
  await page.route('**/api/profile', async (route) => { lostBody = route.request().postDataJSON(); const accepted = await route.fetch(); assert.equal(accepted.status(), 200); await route.abort('failed'); });
  await save(); await page.locator('#profile-form .form-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#style-rule-text').inputValue(), candidateText);
  await page.unroute('**/api/profile');
  const replayRequest = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/profile' && r.method() === 'PUT');
  const replay = await response('/api/profile', 'PUT', save); assert.deepEqual((await replayRequest).postDataJSON(), lostBody); assert.equal(replay.styleLearning.cached, true);
  await settleProfile(); assert.deepEqual(counts(), beforeCandidate);
  assert.equal(await page.locator('#message-text').inputValue(), '尚未提交的本人原话'); assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
  assert.equal(await page.locator('#cancel-message-edit').isVisible(), true, 'Saving preferences retains the current message editing state');
  assert.equal(await page.locator('#suggestion-text').inputValue(), ownVersion); assert.equal(await page.locator('#field-coach-plan').inputValue(), '尚未提交的主导计划');
  let learning = await get('/api/style-learning'); assert.equal(learning.rules.length, 1); assert.equal(learning.rules[0].status, 'candidate'); assert.equal(learning.reviews.length, 1);
  assert.equal(learning.reviews[0].originalSuggestion.reply, original); assert.equal(learning.reviews[0].ownVersion, ownVersion); assert.equal(learning.reviews[0].replyObservation.status, 'unknown'); assert.equal(learning.reviews[0].replyObservation.assessment, 'unassessed');
  const candidateId = learning.rules[0].id;
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await openPreferences(); assert.deepEqual(counts(), beforeCandidate, 'Candidate-only save and reload keep valid model context');
  await page.locator('#style-review-history > summary').click(); assert.ok((await page.locator('#style-review-list').textContent()).includes('结果未知')); assert.equal(await page.locator('#style-rule-list [data-rule-id]').count(), 1);
  await page.locator('#profile-style').fill('我保持简短直接，也愿意分享真实经历。');
  await page.locator('#style-rule-text').fill('留在表单中的下一条草稿');
  await response('/api/profile', 'PUT', () => page.locator(`[data-rule-id="${candidateId}"] [data-rule-action=adopt]`).click());
  await page.locator(`[data-rule-id="${candidateId}"][data-rule-status=adopted]`).waitFor();
  await page.locator('#notice').filter({ hasText: '表达规则已采用' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-rule-id]')?.dataset.ruleId), candidateId, 'Adoption restores focus to the current rule');
  assert.equal(await page.locator('#style-rule-text').inputValue(), '留在表单中的下一条草稿'); assert.deepEqual(counts(), beforeCandidate);
  assert.equal((await get('/api/me')).profile.style, '我保持简短直接，也愿意分享真实经历。');
  await page.locator('#style-cancel-draft').click();
  // Adopted rules are account scoped and enter an explicit later call on another object.
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  await response(`/api/counterparts/${secondId}/reply`, 'POST', () => page.locator('#direct-reply').click());
  assert.deepEqual(JSON.parse(contexts.at(-1).userProfile).confirmedPersonalStyle.rules.map(({ text }) => text), [candidateText]);
  await openPreferences();
  const beforeRules = counts();
  await page.locator('#style-rule-text').fill('愿意练习自然地表达欣赏。'); await page.locator('#style-rule-target').selectOption('growth_goal'); await page.locator('#style-apply').check();
  await response('/api/profile', 'PUT', save); await settleProfile(); assert.deepEqual(counts(), beforeRules);
  learning = await get('/api/style-learning'); assert.equal(learning.rules.filter(({ status }) => status === 'adopted').length, 2);
  await page.locator(`[data-rule-id="${candidateId}"] [data-rule-action=edit]`).click();
  assert.equal(await page.locator('#style-apply').isChecked(), false, 'Editing never silently adopts a new version');
  const replacementText = '先分享一句真实经历，再自然承接她的话。'; await page.locator('#style-rule-text').fill(replacementText); await page.locator('#style-apply').check();
  await response('/api/profile', 'PUT', save); await settleProfile(); learning = await get('/api/style-learning');
  assert.equal(learning.rules.find(({ id: ruleId }) => ruleId === candidateId).status, 'revoked');
  const replacement = learning.rules.find(({ text }) => text === replacementText); assert.equal(replacement.supersedesId, candidateId); assert.equal(replacement.status, 'adopted');
  await response('/api/profile', 'PUT', () => page.locator(`[data-rule-id="${replacement.id}"] [data-rule-action=revoke]`).click());
  await page.locator(`[data-rule-id="${replacement.id}"][data-rule-status=revoked]`).waitFor(); assert.deepEqual(counts(), beforeRules);
  await page.locator('#notice').filter({ hasText: '规则已停用' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-rule-id]')?.dataset.ruleId), replacement.id, 'Revocation keeps focus on a visible rule record');
  await response(`/api/counterparts/${secondId}/reply`, 'POST', () => page.locator('#direct-reply').click());
  const afterRevoke = JSON.parse(contexts.at(-1).userProfile).confirmedPersonalStyle.rules;
  assert.deepEqual(afterRevoke.map(({ text }) => text), ['愿意练习自然地表达欣赏。']);
  assert.equal(afterRevoke[0].target, 'growth_goal');
  await openPreferences();
  const beforeRecovery = counts();
  // Natural synthetic review artifacts, captured before recovery sentinel drafts.
  await page.locator('#style-rule-list').scrollIntoViewIfNeeded();
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    await page.screenshot({ path: join(evidenceDir, `${theme}.png`), fullPage: true });
  }
  // A CAS conflict does not overwrite another tab or drop any form/chat drafts.
  const me = await get('/api/me'); const current = await get('/api/style-learning');
  const remote = await mutation('/api/profile', 'PUT', { ...profile, style: me.profile.style, styleLearning: { requestId: randomUUID(), expectedRevision: current.revision, ruleChange: { type: 'propose', rule: { target: 'current_preference', text: '另一个标签页的候选', conditions: '', limits: '' } } } }); assert.equal(remote.status(), 200);
  await page.locator('#style-rule-text').fill('冲突时应保留的偏好草稿'); await page.locator('#profile-background').fill('未保存的真实背景修正');
  await page.locator('#message-text').fill('冲突时应保留的聊天草稿'); await page.locator('#message-speaker').selectOption('self');
  await response('/api/profile', 'PUT', save, 409); await page.locator('#profile-form .form-error').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#profile-form .form-error').textContent()).includes('重新读取规则'));
  assert.equal(await page.locator('#style-rule-text').inputValue(), '冲突时应保留的偏好草稿'); assert.equal(await page.locator('#message-text').inputValue(), '冲突时应保留的聊天草稿');
  await response('/api/style-learning', 'GET', () => page.locator('#style-reload').click()); assert.equal(await page.locator('#profile-background').inputValue(), '未保存的真实背景修正'); assert.deepEqual(counts(), beforeRecovery);
  // The actual server rejects a missing rule in the same transaction as profile save.
  const storedBackground = (await get('/api/me')).profile.background;
  await page.route('**/api/profile', async (route) => { const body = route.request().postDataJSON(); body.styleLearning.ruleChange = { type: 'adopt', candidateId: 'synthetic-missing-rule' }; const rejected = await route.fetch({ postData: JSON.stringify(body) }); await route.fulfill({ response: rejected }); });
  await response('/api/profile', 'PUT', save, 404); await page.unroute('**/api/profile');
  assert.equal((await get('/api/me')).profile.background, storedBackground, 'Rejected style action rolls back the profile'); assert.equal(await page.locator('#profile-background').inputValue(), '未保存的真实背景修正');
  await response('/api/profile', 'PUT', save); await settleProfile(); assert.deepEqual(counts(), beforeRecovery);
  // A response from object A cannot clear a newly entered draft on B.
  await openPreferences(); await page.locator('#style-rule-text').fill('异步保存的候选');
  let release, acceptedResolve; const accepted = new Promise((done) => { acceptedResolve = done; }); const held = new Promise((done) => { release = done; });
  await page.route('**/api/profile', async (route) => { const received = await route.fetch(); acceptedResolve(); await held; await route.fulfill({ response: received }); });
  await save(); await accepted;
  await page.locator('#counterpart-select').selectOption(id); await page.locator('#message-text').fill('对象切换后的新草稿'); await page.locator('#message-speaker').selectOption('self');
  const delivered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/profile' && r.request().method() === 'PUT');
  release(); await delivered; await settleProfile(); await page.unroute('**/api/profile');
  assert.equal(await page.locator('#counterpart-select').inputValue(), id); assert.equal(await page.locator('#message-text').inputValue(), '对象切换后的新草稿'); assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
  await page.waitForFunction(() => !document.querySelector('#coach-loading').offsetParent);
  await openPreferences();
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    for (const theme of ['day', 'night']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${theme} ${width}px overflow`);
      const button = await page.locator('#style-reload').boundingBox(); assert.ok(button.height >= 44);
    }
  }
  const afterSwitch = counts(); await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await openPreferences(); assert.deepEqual(counts(), afterSwitch, 'Reload and both themes do not repeat saved model calls');
  assert.ok((await page.locator('#style-rule-list').textContent()).includes('愿意练习的方向'));
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => key !== 'chat-coach-theme')), false, 'No private style data enters browser storage');
  // External next-message feedback remains untrusted and cannot create a rule.
  const beforeRaw = await get('/api/style-learning');
  const source = (await get(`/api/counterparts/${secondId}`)).suggestions.at(-1);
  const rawResponse = await mutation(`/api/counterparts/${secondId}/followup`, 'POST', { text: '这是虚构的对方下一句，并不证明表达有效。', requestId: randomUUID(), previousSuggestionId: source.id, previousReplyText: source.reply });
  assert.equal(rawResponse.status(), 200); const rawFollowup = (await rawResponse.json()).data; assert.equal(rawFollowup.feedback.stage, 'raw_untrusted');
  const afterRaw = await get('/api/style-learning'); assert.equal(afterRaw.rules.length, beforeRaw.rules.length); assert.equal(afterRaw.reviews.length, beforeRaw.reviews.length); assert.equal(afterRaw.activeRevision, beforeRaw.activeRevision);
  assert.ok(afterRaw.reviews.every(({ replyObservation }) => replyObservation.assessment === 'unassessed'));
  // Logout clears all private DOM/RAM; a delayed old-account save cannot restore it.
  await page.locator('#style-rule-text').fill('旧账户延迟保存的私有候选');
  let releaseAccount, accountAcceptedResolve;
  const accountAccepted = new Promise((done) => { accountAcceptedResolve = done; }); const accountHeld = new Promise((done) => { releaseAccount = done; });
  await page.route('**/api/profile', async (route) => { const received = await route.fetch(); accountAcceptedResolve(); await accountHeld; await route.fulfill({ response: received }); });
  await save(); await accountAccepted;
  await page.locator('#chat-menu > summary').click();
  await response('/api/logout', 'POST', () => page.locator('#logout').click()); await login('style-other');
  const accountDelivered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/profile' && r.request().method() === 'PUT');
  releaseAccount(); await accountDelivered; await settleProfile(); await page.unroute('**/api/profile');
  await openPreferences(); assert.equal(await page.locator('#style-rule-list [data-rule-id]').count(), 0); assert.equal(await page.locator('#style-review-list [data-review-id]').count(), 0); assert.equal(await page.locator('#style-own-version').inputValue(), ''); assert.equal(await page.locator('#style-rule-text').inputValue(), '');
  assert.equal((await get('/api/style-learning')).rules.length, 0);
  assert.deepEqual(errors, []); assert.equal(await readFile(knowledgePath, 'utf8'), knowledge);
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ passed: true, mode: 'isolated_synthetic', actualProviderCalls: 0, mockClassifications: classifications, mockReplies: replies, checks: ['frozen_self_report_case', 'candidate_isolation', 'idempotent_unknown_network_retry', 'explicit_adoption_and_replacement', 'cross_object_active_context', 'revocation', 'CAS_draft_preservation', 'atomic_rejection', 'object_switch_scope', 'account_isolation', 'two_themes_320_1280', 'no_private_browser_storage'] }, null, 2) + '\n');
  console.log('Personal style browser journey passed: self-report → candidate → explicit adoption → replacement/revoke, with private context, atomic recovery and retained drafts. Zero paid model calls.');
} finally {
  await browser?.close();
  if (server?.listening) await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
