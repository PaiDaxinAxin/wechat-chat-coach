import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer, seedOwner } from '../src/beta-api.mjs';
import { QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Synthetic provider functions, isolated accounts/database and a full KB copy.
// The browser never reads credentials or reaches the operator's running demo.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-topic-workflow-'));
const evidenceDir = join(process.cwd(), 'runs/topic-workflow');
let server, browser;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
try {
  await mkdir(evidenceDir, { recursive: true });
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md'); await writeFile(knowledgePath, knowledgeText);
  const contexts = [], calls = { classify: 0, reply: 0 };
  let clock = Date.parse('2026-10-01T08:00:00.000Z');
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, providerEnv: {}, now: () => clock,
    freeProviderDailyLimit: 20,
    classifyFn: async (context, options) => {
      calls.classify++; contexts.push(context); assert.equal(options.knowledgeText, knowledgeText);
      const ids = context.messages.filter(({ speaker }) => speaker === 'other').map(({ id }) => id);
      const last = ids.at(-1), observed = { level: 'positive', evidenceIds: ids }, unknown = { level: 'unknown', evidenceIds: [] };
      const change = context.topicChangeRequested === true || context.messages.at(-1).text.includes('换题');
      return { status: 'ready', confidence: 'moderate', phase: 'ordinary',
        obstacle: { type: 'none', reason: '虚构对话没有明确拒绝。', evidenceIds: [] },
        heat: { activeInteraction: observed, responseEngagement: observed, personalInterest: observed, reciprocalFlirting: unknown, actionFollowThrough: unknown },
        topicDecision: { mode: change ? 'change' : 'stay', reason: change ? '虚构话题已收住，可以换个话题。' : '她还在展开项目，接着当前话题聊。' },
        workingFocus: { stage: 'security', reason: '她想知道我的真实安排；不由热度分数推断阶段。', evidenceIds: [last] },
        options: change ? [['up', .5], ['down', .3], ['sideways', .2]].map(([topicMove, weight]) => ({ topicMove, weight, relationAction: 'continue', reason: '合成换题路径。', evidenceIds: [last] })) : [],
        uncertainties: ['只验证交互，不证明真实效果。'], recommendationKind: 'uncalibrated',
        fieldCoach: { currentTopic: '工作项目', topicStatus: 'developing', topicMessageIds: [last], initiative: '结合她的话分享一段真实经历。', nextAction: '回应当前问题。', warmingLayer: 'none', reason: '仍在展开。' } };
    },
    replyFn: async ({ context, direction }, options) => {
      calls.reply++; contexts.push(context); assert.equal(options.knowledgeText, knowledgeText);
      const last = context.messages.findLast(({ speaker }) => speaker === 'other').id;
      return { reply: `虚构建议 ${calls.reply}，我也喜欢把事情做好。`, action: 'reply', reason: '用真实经历接话。', styleNote: '可按自己的说法修改。',
        workingFocus: { stage: 'emotion', reason: '当前先接住她的感受。', evidenceIds: [last] },
        guidance: { topicMove: direction || null, relationMove: direction ? 'push_pull' : 'deepen', ownWordsGuide: '先接住她的感受，再分享自己的真实经历。', reentryWhen: '她有新内容时接着聊。' } };
    },
  });
  const password = 'SyntheticPassword2026';
  const owner = await seedOwner(server.betaStore, { username: 'topic-owner', password });
  const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'free' }).invite;
  const user = await server.betaStore.register({ invite, username: 'topic-free', password });
  const profile = validateProfile({ background: '虚构设计师，喜欢散步。', style: '说真实经历，简短自然。', growthGoals: '练习接住对方感受。', relationshipGoal: '双方愿意再见面。', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 4])) } }, 'free');
  server.betaStore.putProfile(user.id, profile);
  const person = server.betaStore.putCounterpart(user.id, { alias: '虚构一', channel: 'offline', offlineScene: '活动中聊过设计。', appProfile: '', background: '彼此介绍过工作。', rounds: 1 });
  const second = server.betaStore.putCounterpart(user.id, { alias: '虚构二', channel: 'other', offlineScene: '', appProfile: '', background: '读书活动认识。', rounds: 0 });
  const original = server.betaStore.putMessage(user.id, person.id, { speaker: 'other', text: '最近在做一个新项目。' });
  server.betaStore.putMessage(user.id, person.id, { speaker: 'other', text: '还挺有意思的，你最近呢？' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true }));
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  async function perform(suffix, method, action) {
    const waiting = page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === method);
    await action(); const response = await waiting, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); return body.data;
  }
  const note = () => page.locator(`[data-message-id="${original.id}"] .message-annotation`);
  async function ready() { await page.locator('#counterpart-workspace').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.getElementById('coach-panel').getAttribute('aria-busy') || document.getElementById('coach-panel').getAttribute('aria-busy') === 'false'); }
  async function detail() { return (await (await context.request.get(`${origin}/api/counterparts/${person.id}`)).json()).data; }
  await page.goto(origin); await page.locator('#username').fill(user.username); await page.locator('#password').fill(password);
  await perform('/api/login', 'POST', () => page.locator('#auth-submit').click());
  await ready();
  if (await page.locator('#counterpart-select').inputValue() !== person.id) { await page.locator('#counterpart-select').selectOption(person.id); await ready(); }
  assert.equal(calls.classify, 0, 'Login and object selection read context without model calls');
  await page.locator('#classify').evaluate((node) => { node.closest('details').open = true; });
  await perform('/classify', 'POST', () => page.locator('#classify').click()); await ready();
  await page.waitForFunction(() => document.getElementById('classification-summary').textContent.includes('接着当前话题'));
  assert.equal(calls.reply, 0); assert.equal(await page.locator('#direction-options').isVisible(), false);
  assert.equal(await page.locator('#field-coach-focus').textContent(), '本轮重点：安全需求');
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '约65°', 'High heat does not substitute for working focus');
  assert.ok((await page.locator('#daily-reply-quota').textContent()).includes('3 / 3'));
  await page.screenshot({ path: join(evidenceDir, '1280-ordinary-continuation.png'), fullPage: true });
  const first = (await perform('/reply', 'POST', () => page.locator('#direct-reply').click())).suggestion;
  await page.locator('#suggestion-editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reply-relation').textContent(), '情绪拉升 · 深入聊');
  assert.equal(await page.locator('#field-coach-focus').textContent(), '本轮重点：情绪拉升');
  assert.equal(await page.locator('#suggestion-direction').isVisible(), false);
  assert.equal(contexts.at(-1).topicChangeRequested, undefined);
  assert.ok((await page.locator('#daily-reply-quota').textContent()).includes('2 / 3'));
  await page.waitForFunction(() => {
    const copy = document.getElementById('copy-reply').getBoundingClientRect(), thread = document.getElementById('chat-thread').getBoundingClientRect();
    return copy.top >= thread.top && copy.bottom <= thread.bottom;
  });
  await page.screenshot({ path: join(evidenceDir, '1280-context-advice.png'), fullPage: true });
  await page.locator('#suggestion-text').fill('本人改写的虚构回复。');
  await perform('/copied', 'POST', () => page.locator('#copy-reply').click());
  await page.waitForFunction(() => !document.getElementById('copy-reply').disabled);
  await page.locator('#message-text').fill('尚未提交的新消息草稿。');
  await note().locator('summary').click(); await note().locator('textarea').fill('线下聊过，这是我补充的背景。');
  const held = deferred(), started = deferred();
  const annotationUrl = `${origin}/api/counterparts/${person.id}/messages/${original.id}/annotation`;
  await page.route(annotationUrl, async (route) => { if (route.request().method() === 'PATCH') { started.resolve(); await held.promise; } await route.continue(); });
  clock += 10;
  const annotationResponse = page.waitForResponse((r) => r.url() === annotationUrl && r.request().method() === 'PATCH');
  await note().locator('button[type=submit]').click(); await started.promise;
  assert.equal(await note().locator('button[type=submit]').isDisabled(), true);
  await note().locator('textarea').fill('保存期间新写的背景，不应被覆盖。');
  held.resolve(); assert.equal((await annotationResponse).status(), 200);
  await page.waitForFunction(() => [...document.querySelectorAll('.message-annotation textarea')].some((input) => input.value === '保存期间新写的背景，不应被覆盖。') && [...document.querySelectorAll('.message-annotation button[type=submit]')].every((button) => !button.disabled));
  await page.unroute(annotationUrl);
  assert.equal(await page.locator('#message-text').inputValue(), '尚未提交的新消息草稿。');
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false, 'Annotation makes previously copied advice stale');
  const saved = (await detail()).messages.find(({ id }) => id === original.id);
  assert.equal(saved.annotation.source, 'user_annotation'); assert.equal(saved.annotation.text, '线下聊过，这是我补充的背景。');
  for (const key of ['text', 'speaker', 'createdAt', 'updatedAt', 'provenance']) assert.equal(saved[key], original[key], `Annotation preserves ${key}`);
  assert.equal(calls.reply, 1); assert.equal(calls.classify, 1, 'Annotation save never triggers a model');
  await page.reload(); await ready(); assert.equal(calls.reply, 1); assert.equal(calls.classify, 1, 'Reloading newly annotated context remains read-only');
  await page.locator('#classify').evaluate((node) => { node.closest('details').open = true; });
  await perform('/classify', 'POST', () => page.locator('#classify').click()); await ready();
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false);
  await note().locator('summary').click();
  await note().locator('textarea').fill('失败时仍保留的背景草稿。');
  await page.route(annotationUrl, (route) => route.fulfill({ status: 503, contentType: 'application/json', json: { error: { code: 'SYNTHETIC_FAILURE', message: '合成保存失败。' } } }));
  await note().locator('button[type=submit]').click(); await note().locator('.form-error').waitFor({ state: 'visible' });
  assert.equal(await note().locator('textarea').inputValue(), '失败时仍保留的背景草稿。');
  await page.unroute(annotationUrl);
  await page.locator('#counterpart-select').selectOption(second.id); await ready();
  await page.locator('#counterpart-select').selectOption(person.id); await ready();
  assert.equal(await note().locator('textarea').inputValue(), '失败时仍保留的背景草稿。');
  assert.equal(await note().locator('.form-error').isVisible(), true);
  await note().locator('textarea').fill(''); clock += 10;
  await perform('/annotation', 'PATCH', () => note().locator('button[type=submit]').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.message-annotation button[type=submit]')].every((button) => !button.disabled));
  assert.equal(await note().locator('.form-error').count(), 0); assert.equal((await detail()).messages.find(({ id }) => id === original.id).annotation, undefined);
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false, 'Clearing annotation cannot resurrect pre-annotation copied advice');
  await perform('/classify', 'POST', () => page.locator('#change-topic').click()); await ready();
  assert.equal(contexts.at(-1).topicChangeRequested, true);
  assert.equal(await page.locator('#direction-options button').count(), 3); assert.equal(await page.locator('#direction-options').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.direction), 'up', 'Explicit topic change focuses the revealed choices');
  const directionRequest = page.waitForRequest((r) => r.url().endsWith('/reply') && r.method() === 'POST');
  await perform('/reply', 'POST', () => page.locator('[data-direction=sideways]').click());
  assert.equal((await directionRequest).postDataJSON().topicChangeRequested, true);
  await page.locator('#suggestion-editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#suggestion-direction').textContent(), '平移'); assert.equal(await page.locator('#reply-relation').textContent(), '情绪拉升 · 轻松推拉');
  assert.ok((await page.locator('#daily-reply-quota').textContent()).includes('1 / 3'));
  await page.reload(); await ready(); assert.equal(calls.reply, 2); assert.equal(await page.locator('#suggestion-panel').isVisible(), true);
  await page.locator('#message-text').fill('虚构下一轮换题内容。');
  await perform('/followup', 'POST', () => page.locator('#save-message').click()); await page.locator('.message-bubble').filter({ hasText: '虚构下一轮换题内容。' }).waitFor(); await ready();
  assert.equal(calls.reply, 2); assert.equal(calls.classify, 3, 'Lifetime analysis exhausted without fallback reply');
  assert.equal(await page.locator('#direction-options').isVisible(), false);
  await page.locator('#change-topic').click(); assert.equal(await page.locator('#direction-options button').count(), 3);
  assert.equal(await page.locator('#direction-options .weight').filter({ hasText: '%' }).count(), 0, 'Manual topic choices do not fabricate model weights');
  await perform('/reply', 'POST', () => page.locator('[data-direction=down]').click()); await ready();
  assert.ok((await page.locator('#daily-reply-quota').textContent()).includes('0 / 3')); assert.equal(await page.locator('#direct-reply').isDisabled(), true);
  assert.equal(await page.locator('#copy-reply').isDisabled(), false, 'Existing result remains editable and copyable after daily exhaustion');
  await page.reload(); await ready(); assert.equal(calls.reply, 3);
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const summary = note().locator('summary'); await summary.scrollIntoViewIfNeeded(); await summary.focus();
      if (!await note().evaluate((element) => element.open)) await page.keyboard.press('Enter');
      assert.ok((await summary.boundingBox()).height >= 44);
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.matches('.message-annotation textarea')), true);
      await page.screenshot({ path: join(evidenceDir, `${width}-${theme}.png`), fullPage: true });
    }
  }
  // A durable note acknowledgment arriving after switching contact cannot
  // replace the new contact's composer or move focus back to the old note.
  await page.setViewportSize({ width: 1280, height: 950 });
  const late = deferred(), applied = deferred();
  await page.route(annotationUrl, async (route) => { const response = await route.fetch(); applied.resolve(); await late.promise; await route.fulfill({ response }); });
  if (!await note().evaluate((element) => element.open)) await note().locator('summary').click();
  await note().locator('textarea').fill('迟到保存的独立背景。'); clock += 10;
  const lateResponse = page.waitForResponse((r) => r.url() === annotationUrl && r.request().method() === 'PATCH');
  await note().locator('button[type=submit]').click(); await applied.promise;
  await page.locator('#counterpart-select').selectOption(second.id); await ready();
  await page.locator('#message-text').fill('第二对象的新草稿。'); await page.locator('#message-text').focus();
  late.resolve(); assert.equal((await lateResponse).status(), 200);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#counterpart-select').inputValue(), second.id);
  assert.equal(await page.locator('#message-text').inputValue(), '第二对象的新草稿。');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-text');
  await page.unroute(annotationUrl);
  await page.locator('#counterpart-select').selectOption(person.id); await ready();
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false);
  await note().locator('textarea').fill(''); clock += 10;
  await perform('/annotation', 'PATCH', () => note().locator('button[type=submit]').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.message-annotation button[type=submit]')].every((button) => !button.disabled));
  const cleared = (await detail()).messages.find(({ id }) => id === original.id);
  assert.equal(cleared.annotation, undefined); assert.ok(cleared.annotationRevision > 0);
  await page.reload(); await ready();
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false, 'Save then clear then reload keeps pre-note replies stale');
  assert.equal(calls.reply, 3); assert.equal(calls.classify, 3);
  assert.deepEqual(errors, []); assert.equal(await readFile(knowledgePath, 'utf8'), knowledgeText);
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ passed: true, actualProviderCalls: 0, calls, browser: browser.version(), checks: ['ordinary continuation hides directions', 'AI focus independent from heat', 'reply focus preferred', 'user topic-change flag reaches both calls', 'no automatic reply on load/new context/analysis exhaustion', 'annotated originals and source preserved', 'copy before annotation cannot revive stale draft', 'late annotation save preserves new typing and composer', 'annotation failure survives contact switching', 'late annotation acknowledgment stays scoped to contact', 'save-clear-reload revision preserves stale status', 'empty annotation clears safely', 'daily three quota visible and reload does not spend', 'daily exhausted result remains copyable', '320/1280 day/night keyboard and no overflow'] }, null, 2) + '\n');
  console.log('Topic workflow passed: isolated synthetic models, 0 actual provider calls.');
} finally {
  if (browser) await browser.close();
  if (server?.listening) await new Promise((done) => server.close(done));
  else await server?.betaStore?.close();
  await rm(directory, { recursive: true, force: true });
}
