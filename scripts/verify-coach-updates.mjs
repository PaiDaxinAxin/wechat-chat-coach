import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer, seedOwner } from '../src/beta-api.mjs';
import { QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';
import { CoachError } from '../src/coach.mjs';

// Synthetic accounts, a temporary database and copied knowledge only. All model
// entry points are injected; browser requests cannot leave this temporary origin.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-updates-'));
const evidenceDir = join(process.cwd(), 'runs/coach-updates');
const report = { passed: false, synthetic: true, actualProviderCalls: 0, cases: [], pageErrors: [], externalRequests: [] };
const contexts = new Set(), controllers = new Map();
let server, browser;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const dimensions = ['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'];

function classification(context, mode = 'neutral') {
  const others = context.messages.filter(({ speaker }) => speaker === 'other');
  const ids = others.map(({ id }) => id), last = ids.at(-1);
  const heat = Object.fromEntries(dimensions.map((name) => [name, { level: 'unknown', evidenceIds: [] }]));
  if (mode === 'low') {
    for (const name of dimensions.slice(0, 4)) heat[name] = { level: ['activeInteraction', 'personalInterest'].includes(name) ? 'negative' : 'passive', evidenceIds: ids };
  } else if (mode === 'high') {
    for (const name of dimensions.slice(0, 4)) heat[name] = { level: 'positive', evidenceIds: ids };
  } else if (mode !== 'unknown') {
    heat.responseEngagement = { level: 'positive', evidenceIds: [last] };
  }
  return {
    status: 'ready', confidence: ['low', 'high'].includes(mode) ? 'moderate' : 'limited', phase: 'ordinary',
    obstacle: { type: mode === 'refusal' ? 'negative' : 'none', evidenceIds: mode === 'refusal' ? [last] : [], reason: mode === 'refusal' ? '合成记录中有明确拒绝。' : '合成记录没有明确拒绝。' },
    heat, topicDecision: { mode: 'stay', reason: '合成话题仍可自然展开。' },
    workingFocus: { stage: 'emotion', reason: '先接住当前表达。', evidenceIds: [last] },
    fieldCoach: { currentTopic: '周末徒步', topicStatus: 'developing', topicMessageIds: [last], initiative: '沿她提到的徒步经历继续了解。', nextAction: '聊她最近走过的路线。', warmingLayer: 'none', reason: '仅依据已记录的虚构对话。' },
    options: [], uncertainties: ['合成测试不证明真实聊天效果。'], recommendationKind: 'uncalibrated',
  };
}

try {
  await mkdir(evidenceDir, { recursive: true });
  let knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md'); await writeFile(knowledgePath, knowledgeText);
  const webDir = join(directory, 'public'); await mkdir(webDir);
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  const controllerFor = (context, options) => {
    assert.equal(options.knowledgeText, knowledgeText, 'Every model path retains complete source knowledge');
    const controller = controllers.get(context.messages[0]?.id); assert.ok(controller, 'Only owned synthetic contexts reach the injected provider'); return controller;
  };
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, webDir, providerEnv: {}, paidProviderDailyLimit: 100, globalProviderDailyLimit: 10_000,
    classifyFn: async (context, options) => { const controller = controllerFor(context, options); controller.classifications++; await controller.classifyGate?.(context); return classification(context, controller.mode); },
    replyFn: async ({ context }, options) => { const controller = controllerFor(context, options); controller.replies++; await controller.replyGate?.(context); return { reply: '你最近走过哪条路线？', reason: '沿已有徒步话题自然展开。', action: 'reply', styleNote: '简短自然。', workingFocus: { stage: 'emotion', reason: '先承接。', evidenceIds: [context.messages.at(-1).id] }, guidance: { topicMove: null, relationMove: 'receive', ownWordsGuide: '沿她提到的徒步经历继续了解。', reentryWhen: '有新内容时自然接话。' } }; },
    planFn: async () => { throw new Error('This fixture does not request plan assessment'); },
    imageFn: async () => { throw new Error('This fixture does not request image interpretation'); },
  });
  const password = 'SyntheticCoachUpdates2026';
  const owner = await seedOwner(server.betaStore, { username: 'coach-updates-owner', password });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  report.browser = browser.version();

  async function journey(name, { mode = 'neutral', width = 1280, reducedMotion = 'no-preference', gate, analyze = true } = {}) {
    const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' }).invite;
    const user = await server.betaStore.register({ invite, username: `synthetic_${randomUUID().slice(0, 8)}`, password });
    server.betaStore.putProfile(user.id, validateProfile({ background: '虚构成年设计师，喜欢散步。', style: '简短自然。', growthGoals: '学会承接话题。', relationshipGoal: '双方自愿了解。', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) } }, 'paid'));
    const person = server.betaStore.putCounterpart(user.id, { alias: '虚构徒步对象', channel: 'offline', offlineScene: '虚构读书活动。', appProfile: '', background: '她提过喜欢周末徒步；所有资料只用于隔离测试。', rounds: 1 });
    const texts = mode === 'low' ? ['还行吧。', '没什么。', '最近一般。'] : mode === 'high' ? ['周末一起徒步吧？', '和你聊天挺开心的。', '你喜欢哪条路线？'] : mode === 'refusal' ? ['请不要再这样约我。'] : ['我周末去徒步了。'];
    const messages = texts.map((text) => server.betaStore.putMessage(user.id, person.id, { speaker: 'other', text }));
    const controller = { mode, classifications: 0, replies: 0, classifyGate: gate }; controllers.set(messages[0].id, controller);
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion }); contexts.add(context);
    const session = server.betaStore.createSession(user.id);
    await context.addCookies([{ name: 'chat_coach_session', value: session.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
    await context.route('**/*', (route) => { if (new URL(route.request().url()).origin === origin) return route.continue(); report.externalRequests.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient'); });
    const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => report.pageErrors.push(error.message));
    const modelPosts = [];
    page.on('request', (request) => { if (request.method() === 'POST' && /\/(classify|reply|coach-plan|image-read)$/.test(new URL(request.url()).pathname)) modelPosts.push(request.url()); });
    await page.goto(origin); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
    const startAnalysis = async () => { await page.locator('#classify').evaluate((node) => { node.closest('details').open = true; }); await page.locator('#classify').click(); };
    assert.equal(modelPosts.length, 0, 'Opening an existing conversation is read-only');
    if (analyze) await startAnalysis();
    const idle = () => page.waitForFunction(() => document.getElementById('coach-panel').getAttribute('aria-busy') === 'false');
    const openCoach = async () => { if (!await page.locator('#field-coach').isVisible()) await page.locator('#toggle-field-coach').click(); };
    const detail = async () => { const response = await context.request.get(`${origin}/api/counterparts/${person.id}`); assert.equal(response.status(), 200); return (await response.json()).data; };
    const finish = async (extra = {}) => { report.cases.push({ name, passed: true, classifications: controller.classifications, replies: controller.replies, ...extra }); await context.close(); contexts.delete(context); };
    return { user, person, messages, controller, context, page, session, idle, openCoach, detail, finish, modelPosts, startAnalysis, url: `${origin}/api/counterparts/${person.id}` };
  }

  const updated = async (f) => { await f.idle(); await f.page.locator('#coach-update-note').waitFor({ state: 'visible' }); assert.equal(await f.page.locator('#coach-update-text').textContent(), '场外教练的指示已更新'); };
  const noUpdated = async (f) => { await f.page.locator('#coach-update-note').waitFor({ state: 'hidden' }); assert.equal(await f.page.locator('#field-coach-update-badge').isVisible(), false); assert.equal(await f.page.locator('#field-coach').evaluate((node) => node.classList.contains('coach-updated')), false); };
  const updating = async (f) => { await f.page.locator('#coach-update-note').waitFor({ state: 'visible' }); assert.equal(await f.page.locator('#coach-update-text').textContent(), '场外教练正在更新…'); assert.equal(await f.page.locator('#field-coach-update-badge').textContent(), '更新中'); };
  const assertRange = async (f) => {
    const temperature = (await f.page.locator('#field-coach-temperature').textContent()).trim();
    assert.match(temperature, /\d+\s*[–—~～\-至]\s*\d+\s*°/u, 'A first recorded message has a clearly provisional range instead of an exact score');
    const detail = await f.detail(); assert.equal(detail.heat.score, null); assert.equal(detail.heat.preliminaryRange.provisional, true);
    const list = await f.context.request.get(`${origin}/api/counterparts`); assert.equal(list.status(), 200);
    assert.equal((await list.json()).data.topThree.includes(f.person.id), false, 'Sparse preliminary estimates cannot qualify for top-three ranking');
  };

  const firstEntered = deferred(), firstRelease = deferred();
  const first = await journey('single-message-initial-range', { gate: async () => { firstEntered.resolve(); await firstRelease.promise; } });
  await firstEntered.promise; await updating(first); await first.openCoach();
  assert.equal(await first.page.locator('#field-coach-temperature').textContent(), '初步分析中');
  assert.equal(await first.page.locator('#field-coach-focus').textContent(), '本轮重点：尝试获得更多信息');
  assert.match(await first.page.locator('#field-coach-initiative').textContent(), /初步方向.*尝试获得更多信息/u, 'One message has a useful general direction before a model result exists');
  assert.match(await first.page.locator('#field-coach-heat-basis').textContent(), /通用初步方向/u);
  assert.equal(await first.page.locator('#field-coach-update-badge').textContent(), '更新中', 'General preliminary guidance does not claim model completion');
  assert.equal((await first.detail()).heat.preliminaryRange, null, 'An unanalysed first message does not manufacture an empirical range');
  assert.equal(await first.page.locator('#field-coach-initiative').textContent() === '本轮主导建议待判断。', false);
  assert.equal(await first.page.locator('#field-coach-pitfall').textContent() === '本轮雷点待判断。', false);
  firstRelease.resolve(); await updated(first); await assertRange(first);
  assert.equal(await first.page.locator('#field-coach-initiative').textContent(), '沿她提到的徒步经历继续了解。', 'A model-provided action replaces the general preliminary direction');
  assert.equal(await first.page.locator('#field-coach-next').textContent(), '聊她最近走过的路线。');
  assert.match(await first.page.locator('#field-coach .coach-action-label').first().textContent(), /后续对话的方向/);
  await first.finish({ preliminaryRange: true, sparseRankingExcluded: true, pendingGeneralDirection: true, completedModelAction: true });

  const unknown = await journey('analysed-with-insufficient-evidence', { mode: 'unknown' }); await updated(unknown); await unknown.openCoach();
  const unknownHeat = await unknown.detail(); assert.equal(unknownHeat.heat.score, null); assert.equal(unknownHeat.heat.preliminaryRange, null);
  assert.equal(await unknown.page.locator('#field-coach-temperature').textContent(), '初步观察', 'Completed analysis with no usable heat evidence is not described as never analysed');
  await unknown.finish({ unknownIsNotInventedScore: true });

  for (const mode of ['low', 'high', 'refusal']) {
    const f = await journey(`${mode}-default-pitfall`, { mode }); await updated(f); await f.openCoach();
    const pitfall = (await f.page.locator('#field-coach-pitfall').textContent()).trim();
    assert.ok(pitfall.length > 0 && !/待判断/.test(pitfall));
    if (mode === 'refusal') {
      assert.match(pitfall, /别继续|拒绝|边界|停止/u);
      assert.equal(await f.page.locator('#field-coach-temperature').textContent(), '先停推进');
      assert.equal(await f.page.locator('#field-coach-focus').textContent(), '本轮重点：停止这类推进');
      assert.equal(await f.page.locator('#field-coach-initiative').textContent(), '停止这类推进，尊重她的边界。', 'An explicit refusal overrides both model action and general information gathering');
    }
    else assert.match(pitfall, /通用/u, 'Fallback advice must identify itself as general guidance');
    await f.finish({ pitfall, refusalDominatesRange: mode === 'refusal' });
  }

  const lifecycle = await journey('recorded-message-update-lifecycle'); await updated(lifecycle);
  const nextEntered = deferred(), nextRelease = deferred();
  lifecycle.controller.classifyGate = async () => { nextEntered.resolve(); await nextRelease.promise; };
  await lifecycle.page.locator('#message-text').fill('下次想走一条沿河的路线。');
  await lifecycle.page.locator('#save-message').click(); await nextEntered.promise; await updating(lifecycle);
  assert.equal(await lifecycle.page.locator('#field-coach').evaluate((node) => node.classList.contains('coach-updated')), false, 'Saving a new message must clear the previous success cue');
  nextRelease.resolve(); await updated(lifecycle);
  const beforeReload = lifecycle.controller.classifications;
  await lifecycle.page.reload(); await lifecycle.page.locator('#counterpart-workspace').waitFor({ state: 'visible' }); await lifecycle.idle(); await noUpdated(lifecycle);
  assert.equal(lifecycle.controller.classifications, beforeReload, 'Reload reads the saved result without a new classification');
  await lifecycle.page.locator('#classify').evaluate((node) => { node.closest('details').open = true; });
  const cached = lifecycle.page.waitForResponse((response) => response.url() === `${lifecycle.url}/classify` && response.request().method() === 'POST');
  await lifecycle.page.locator('#classify').click(); const cachedResponse = await cached; assert.equal((await cachedResponse.json()).data.cached, true);
  await lifecycle.idle(); await noUpdated(lifecycle); assert.equal(lifecycle.controller.classifications, beforeReload);
  await lifecycle.finish({ savedMessageWaitsForResult: true, reloadAndCachedNoCue: true });

  const recovered = await journey('new-result-recovered-after-response-loss'); await updated(recovered);
  const recoveryIds = [];
  await recovered.page.route(`${recovered.url}/reply`, async (route) => {
    recoveryIds.push(route.request().postDataJSON().requestId);
    if (recoveryIds.length !== 1) return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionclosed');
  });
  const recoveredResponse = recovered.page.waitForResponse((response) => response.url() === `${recovered.url}/reply` && response.request().method() === 'POST' && response.status() === 200);
  await recovered.page.locator('#direct-reply').click(); assert.equal((await (await recoveredResponse).json()).data.cached, true);
  await updated(recovered);
  assert.equal(recoveryIds.length, 2); assert.equal(new Set(recoveryIds).size, 1); assert.equal(recovered.controller.replies, 1);
  assert.equal(server.betaStore.listJobs(recovered.user.id, recovered.person.id).filter(({ operation }) => operation === 'reply').length, 1);
  await recovered.finish({ firstDisplayRecoveredResultHasCue: true, sameRequestNoExtraProvider: true });

  const late = await journey('late-result-after-context-change'); await updated(late);
  const lateEntered = deferred(), lateRelease = deferred();
  late.controller.replyGate = async () => { lateEntered.resolve(); await lateRelease.promise; };
  await late.page.locator('#direct-reply').click(); await lateEntered.promise; await updating(late);
  const annotation = late.page.locator(`[data-message-id="${late.messages[0].id}"] .message-annotation`);
  await annotation.locator('..').locator('.message-menu > summary').click();
  await annotation.locator('..').getByRole('button', { name: /^(添加|编辑)批注$/ }).click();
  await annotation.locator('textarea').fill('我补充的新判断，属于个人解释。');
  const annotated = late.page.waitForResponse((response) => response.url().endsWith('/annotation') && response.request().method() === 'PATCH');
  await annotation.locator('button[type=submit]').click(); assert.equal((await annotated).status(), 200);
  await late.page.waitForFunction(() => [...document.querySelectorAll('.message-annotation button[type=submit]')].every((button) => !button.disabled));
  await noUpdated(late);
  const oldResponse = late.page.waitForResponse((response) => response.url() === `${late.url}/reply` && response.request().method() === 'POST');
  lateRelease.resolve(); assert.equal((await oldResponse).status(), 409); await late.idle(); await noUpdated(late);
  assert.equal(late.controller.replies, 1); await late.finish({ obsoleteResultCannotUpdateCoach: true });

  const switched = await journey('late-result-other-object'); await updated(switched);
  const other = server.betaStore.putCounterpart(switched.user.id, { alias: '另一虚构对象', channel: 'offline', offlineScene: '隔离活动。', appProfile: '', background: '仅测试对象隔离。', rounds: 0 });
  const otherMessage = server.betaStore.putMessage(switched.user.id, other.id, { speaker: 'other', text: '今天看了本新书。' });
  controllers.set(otherMessage.id, { mode: 'neutral', classifications: 0, replies: 0 });
  const selectedReady = (id, messageId) => switched.page.waitForFunction(({ id, messageId }) => document.getElementById('counterpart-select').value === id && document.getElementById('counterpart-workspace').checkVisibility() && document.querySelector(`[data-message-id="${messageId}"]`) && document.getElementById('coach-panel').getAttribute('aria-busy') === 'false', { id, messageId });
  // Reload imports the newly created fixture object without treating its saved
  // result as a fresh update. Select and analyze it once before the late-response case.
  await switched.page.reload(); await switched.page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await switched.page.locator('#counterpart-select').selectOption(other.id); await selectedReady(other.id, otherMessage.id);
  await switched.startAnalysis(); await switched.idle();
  await switched.page.locator('#counterpart-select').selectOption(switched.person.id); await selectedReady(switched.person.id, switched.messages[0].id); await noUpdated(switched);
  const switchEntered = deferred(), switchRelease = deferred();
  switched.controller.replyGate = async () => { switchEntered.resolve(); await switchRelease.promise; };
  await switched.page.locator('#direct-reply').click(); await switchEntered.promise; await updating(switched);
  await switched.page.locator('#counterpart-select').selectOption(other.id); await selectedReady(other.id, otherMessage.id); await noUpdated(switched);
  const switchedResponse = switched.page.waitForResponse((response) => response.url() === `${switched.url}/reply` && response.request().method() === 'POST');
  switchRelease.resolve(); assert.equal((await switchedResponse).status(), 200); await noUpdated(switched);
  await switched.page.locator('#counterpart-select').selectOption(switched.person.id); await selectedReady(switched.person.id, switched.messages[0].id); await noUpdated(switched);
  await switched.finish({ otherObjectUnaffected: true, savedLateResultNoFreshCue: true });

  const roundtrip = await journey('late-result-after-object-roundtrip'); await updated(roundtrip);
  const roundtripOther = server.betaStore.putCounterpart(roundtrip.user.id, { alias: '往返对象', channel: 'offline', offlineScene: '虚构活动。', appProfile: '', background: '只验证隔离状态。', rounds: 0 });
  const roundtripMessage = server.betaStore.putMessage(roundtrip.user.id, roundtripOther.id, { speaker: 'other', text: '聊聊周末吧。' });
  controllers.set(roundtripMessage.id, { mode: 'neutral', classifications: 0, replies: 0 });
  await roundtrip.page.reload(); await roundtrip.page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  const roundtripReady = (id, messageId, allowBusy = false) => roundtrip.page.waitForFunction(({ id, messageId, allowBusy }) => document.getElementById('counterpart-select').value === id && document.getElementById('counterpart-workspace').checkVisibility() && document.querySelector(`[data-message-id="${messageId}"]`) && (allowBusy || document.getElementById('coach-panel').getAttribute('aria-busy') === 'false'), { id, messageId, allowBusy });
  await roundtrip.page.locator('#counterpart-select').selectOption(roundtripOther.id); await roundtripReady(roundtripOther.id, roundtripMessage.id);
  await roundtrip.startAnalysis(); await roundtrip.idle();
  await roundtrip.page.locator('#counterpart-select').selectOption(roundtrip.person.id); await roundtripReady(roundtrip.person.id, roundtrip.messages[0].id);
  const roundtripEntered = deferred(), roundtripRelease = deferred();
  roundtrip.controller.replyGate = async () => { roundtripEntered.resolve(); await roundtripRelease.promise; };
  await roundtrip.page.locator('#direct-reply').click(); await roundtripEntered.promise;
  await roundtrip.page.locator('#counterpart-select').selectOption(roundtripOther.id); await roundtripReady(roundtripOther.id, roundtripMessage.id);
  await roundtrip.page.locator('#counterpart-select').selectOption(roundtrip.person.id); await roundtripReady(roundtrip.person.id, roundtrip.messages[0].id, true);
  const roundtripResponse = roundtrip.page.waitForResponse((response) => response.url() === `${roundtrip.url}/reply` && response.request().method() === 'POST');
  roundtripRelease.resolve(); assert.equal((await roundtripResponse).status(), 200); await roundtrip.idle(); await noUpdated(roundtrip);
  assert.equal(await roundtrip.page.locator('#direct-reply').isDisabled(), false, 'A completed old-visit request must release the current busy UI after returning to the object');
  await roundtrip.finish({ oldVisitNoCue: true, busyStateReleased: true });

  const mobile = await journey('mobile-reduced-motion', { width: 390, reducedMotion: 'reduce' }); await updated(mobile);
  assert.equal(await mobile.page.locator('#field-coach').isVisible(), false);
  await mobile.page.locator('#direct-reply').click(); await updated(mobile);
  await mobile.page.waitForFunction(() => {
    const note = document.getElementById('coach-update-note'), thread = document.getElementById('chat-thread');
    const shown = note.getBoundingClientRect(), viewport = thread.getBoundingClientRect();
    return note.checkVisibility() && shown.height > 0 && shown.top >= viewport.top && shown.bottom <= viewport.bottom;
  });
  await mobile.page.screenshot({ path: join(evidenceDir, 'mobile-chat-update.png') });
  await mobile.page.locator('#view-coach-update').click(); await mobile.page.locator('#field-coach').waitFor({ state: 'visible' });
  assert.equal(await mobile.page.locator('#field-coach-update-badge').textContent(), '已更新'); await assertRange(mobile);
  const motion = await mobile.page.locator('#field-coach').evaluate((node) => ({ animationName: getComputedStyle(node).animationName, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, overflow: document.documentElement.scrollWidth > innerWidth }));
  assert.equal(motion.reduced, true); assert.equal(motion.animationName, 'none'); assert.equal(motion.overflow, false);
  await mobile.page.screenshot({ path: join(evidenceDir, 'mobile-reduced-motion.png') });
  await mobile.finish({ replyCueVisibleInChatViewport: true, textCueSurvivesReducedMotion: true, noHorizontalOverflow: true });

  const readOnly = await journey('refresh-read-only-without-cache-and-after-version-change', { analyze: false });
  const assertReadOnly = async (postCount) => {
    await readOnly.idle(); await noUpdated(readOnly);
    assert.equal(readOnly.modelPosts.length, postCount, 'A detail read cannot issue a model POST');
    assert.equal(await readOnly.page.locator('#coach-error').isVisible(), false, 'A read must not manufacture a model failure');
  };
  await assertReadOnly(0);
  await readOnly.page.reload(); await readOnly.page.locator('#counterpart-workspace').waitFor({ state: 'visible' }); await assertReadOnly(0);
  await readOnly.startAnalysis(); await updated(readOnly);
  assert.equal(readOnly.controller.classifications, 1);
  const beforeVersionChange = readOnly.modelPosts.length;
  knowledgeText += '\n\n合成验收增补：只用于临时知识库版本失效测试。\n';
  await writeFile(knowledgePath, knowledgeText);
  await readOnly.page.reload(); await readOnly.page.locator('#counterpart-workspace').waitFor({ state: 'visible' }); await assertReadOnly(beforeVersionChange);
  assert.equal((await readOnly.detail()).classification, null, 'Changed knowledge invalidates the cached result without rerunning it');
  assert.equal(await readOnly.page.locator('#field-coach-temperature').textContent(), '初步方向');
  await readOnly.page.route(readOnly.url, (route) => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成读取失败。' } } }) : route.continue());
  await readOnly.page.reload(); await readOnly.page.locator('#startup-retry').waitFor({ state: 'visible' });
  assert.equal(readOnly.modelPosts.length, beforeVersionChange);
  assert.equal(await readOnly.page.locator('#coach-update-note').isVisible(), false);
  assert.equal(await readOnly.page.locator('#coach-error').isVisible(), false);
  await readOnly.page.unroute(readOnly.url);
  await readOnly.page.locator('#startup-retry').click(); await readOnly.page.locator('#counterpart-workspace').waitFor({ state: 'visible' }); await assertReadOnly(beforeVersionChange);
  readOnly.controller.classifyGate = async () => { throw new CoachError('provider_timeout'); };
  await readOnly.startAnalysis(); await readOnly.page.locator('#retry-coach:not([disabled])').waitFor({ state: 'visible' }); await readOnly.idle();
  assert.equal(await readOnly.page.locator('#coach-error').isVisible(), true, 'An explicitly requested failed model call still shows its retryable error');
  assert.equal(readOnly.modelPosts.length, beforeVersionChange + 2, 'Manual classification keeps its bounded recovery');
  await readOnly.finish({ uncachedRefreshNoModel: true, changedKnowledgeRefreshNoModel: true, failedReadNoModel: true, explicitFailureVisible: true });

  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  assert.ok(report.cases.length > 0, 'At least one complete journey must execute');
  report.passed = true; await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  for (const context of contexts) await context.close();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
