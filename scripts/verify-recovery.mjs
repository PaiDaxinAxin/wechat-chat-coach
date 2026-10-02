import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer, seedOwner } from '../src/beta-api.mjs';
import { QUESTIONNAIRES, validateProfile } from '../src/domain.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// All model execution is injected. Every browser request is restricted to this
// temporary server; the operator's demo, cloud, environment and clipboard are unused.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-recovery-'));
const evidenceDir = join(process.cwd(), 'runs/recovery');
const report = { passed: false, synthetic: true, actualProviderCalls: 0, cases: [], pageErrors: [], externalRequests: [] };
let server, browser;
const controllers = new Map();
const messageControllers = new Map();
const contexts = new Set();
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHj0AAAAASUVORK5CYII=', 'base64');
const modelRoute = /\/(classify|reply|coach-plan|image-read)$/;

function classification(context) {
  const id = context.messages.findLast(({ speaker }) => speaker === 'other').id;
  const unknown = { level: 'unknown', evidenceIds: [] };
  const change = context.topicChangeRequested === true;
  return { status: 'ready', confidence: 'limited', phase: 'ordinary',
    obstacle: { type: 'none', evidenceIds: [], reason: '合成案例中没有明确阻力。' },
    heat: Object.fromEntries(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'].map((name) => [name, unknown])),
    topicDecision: { mode: change ? 'change' : 'stay', reason: change ? '合成换题请求。' : '合成话题可以自然继续。' },
    workingFocus: { stage: 'emotion', reason: '先承接当前表达。', evidenceIds: [id] },
    options: change ? ['up', 'down', 'sideways'].map((topicMove, index) => ({ topicMove, weight: index === 0 ? .6 : .2, relationAction: 'continue', reason: '合成换题方向。', evidenceIds: [id] })) : [], uncertainties: ['仅供隔离测试。'], recommendationKind: 'uncalibrated' };
}
function reply(context, count) {
  return { reply: `合成回复${count}：这个项目哪部分最有意思？`, reason: '接住当前话题。', action: 'reply', styleNote: '保持自然。',
    workingFocus: { stage: 'emotion', reason: '先承接当前表达。', evidenceIds: [context.messages.at(-1).id] },
    guidance: { topicMove: null, relationMove: 'receive', ownWordsGuide: '用真实经历自然接话。', reentryWhen: '有新内容时继续。' } };
}
async function output(context, operation, makeValue) {
  const controller = messageControllers.get(context.messages[0]?.id);
  assert.ok(controller, 'The provider receives only an isolated owned context');
  controller.calls[operation]++;
  if (controller.behavior[operation]) await controller.behavior[operation](controller.calls[operation]);
  return makeValue();
}
function transient(code = 'provider_timeout', status) { const error = new Error('Synthetic transient failure.'); error.code = code; if (status) error.status = status; return error; }

try {
  await mkdir(evidenceDir, { recursive: true });
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md'); await writeFile(knowledgePath, knowledgeText);
  const webDir = join(directory, 'public'); await mkdir(webDir);
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  const checkKnowledge = (options) => assert.equal(options.knowledgeText, knowledgeText);
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, webDir, providerEnv: {},
    freeProviderDailyLimit: 100, paidProviderDailyLimit: 100, globalProviderDailyLimit: 10_000,
    classifyFn: async (context, options) => { checkKnowledge(options); return output(context, 'classify', () => classification(context)); },
    replyFn: async ({ context }, options) => { checkKnowledge(options); return output(context, 'reply', () => reply(context, messageControllers.get(context.messages[0]?.id).calls.reply)); },
    planFn: async ({ context }, options) => { checkKnowledge(options); return output(context, 'coach-plan', () => ({ verdict: 'suitable', reason: '合成计划适合承接当前话题。', timingSuggestion: { status: 'after_response', guidance: '等对方有新内容时再接话。', evidenceIds: [context.messages.at(-1).id] }, nextAction: '自然承接。' })); },
    imageFn: async ({ context }, options) => { checkKnowledge(options); return output(context, 'image-read', () => ({ description: '合成图片中的表情，不能确认说话人。', kind: 'sticker', uncertainty: '语气不能确定。' })); },
  });
  const password = 'SyntheticRecovery2026';
  const owner = await seedOwner(server.betaStore, { username: 'recovery-owner', password });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  report.browser = browser.version();

  async function journey(name) {
    const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' }).invite;
    const user = await server.betaStore.register({ invite, username: `synthetic_${randomUUID().slice(0, 8)}`, password });
    server.betaStore.putProfile(user.id, validateProfile({ background: '虚构设计师，喜欢散步。', style: '简短自然。', growthGoals: '练习承接。', relationshipGoal: '双方自愿了解。', questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 3])) } }, 'paid'));
    const people = ['另一虚构对象', '当前虚构对象'].map((alias) => {
      const person = server.betaStore.putCounterpart(user.id, { alias, channel: 'offline', offlineScene: '虚构读书活动。', appProfile: '', background: '仅为隔离测试。', rounds: 1 });
      const message = server.betaStore.putMessage(user.id, person.id, { speaker: 'other', text: '最近忙一个新项目，你最近呢？' });
      const controller = { calls: { classify: 0, reply: 0, 'coach-plan': 0, 'image-read': 0 }, behavior: {} };
      controllers.set(person.id, controller); messageControllers.set(message.id, controller);
      return person;
    });
    const person = people[1], second = people[0], controller = controllers.get(person.id);
    const context = await browser.newContext({ viewport: { width: 1280, height: 950 } }); contexts.add(context);
    const session = server.betaStore.createSession(user.id);
    await context.addCookies([{ name: 'chat_coach_session', value: session.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      report.externalRequests.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    const requests = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && modelRoute.test(new URL(request.url()).pathname)) requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await page.goto(origin);
    await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
    if (await page.locator('#counterpart-select').inputValue() !== person.id) await page.locator('#counterpart-select').selectOption(person.id);
    assert.equal(requests.length, 0, 'Login and object selection do not spend model calls');
    await page.locator('#classify').evaluate((node) => { node.closest('details').open = true; }); await page.locator('#classify').click();
    await page.waitForFunction((id) => document.getElementById('counterpart-select').value === id && document.getElementById('classification-summary').textContent.includes('合成话题') && document.getElementById('coach-panel').getAttribute('aria-busy') === 'false', person.id);
    assert.equal(await page.locator('#job-history').count(), 0, 'Operation history is absent, including after a persisted job');
    await page.locator('#intent').evaluate((element) => { element.closest('details').open = true; });
    await page.locator('#message-text').fill('未提交的消息草稿。');
    await page.locator('#intent').fill('本轮用户意图。');
    await page.locator('#field-coach-plan').fill('未提交的主导计划。');
    const url = (operation = 'reply') => `${origin}/api/counterparts/${person.id}/${operation}`;
    const modelRequests = (operation = 'reply') => requests.filter(({ path }) => path === new URL(url(operation)).pathname);
    const idle = () => page.waitForFunction(() => document.getElementById('coach-panel').getAttribute('aria-busy') === 'false' && !document.getElementById('direct-reply').disabled);
    const success = () => page.waitForFunction(() => document.getElementById('suggestion-text').value.startsWith('合成回复') && !document.getElementById('copy-reply').disabled && document.getElementById('coach-panel').getAttribute('aria-busy') === 'false');
    const assertDrafts = async () => {
      assert.equal(await page.locator('#message-text').inputValue(), '未提交的消息草稿。');
      assert.equal(await page.locator('#intent').inputValue(), '本轮用户意图。');
      assert.equal(await page.locator('#field-coach-plan').inputValue(), '未提交的主导计划。');
    };
    const finish = async (extra = {}) => {
      assert.equal(await page.locator('#job-history').count(), 0);
      report.cases.push({ name, passed: true, mockCalls: { ...controller.calls }, httpModelRequests: Object.fromEntries(['classify', 'reply', 'coach-plan', 'image-read'].map((operation) => [operation, modelRequests(operation).length])), ...extra });
      await context.close(); contexts.delete(context);
    };
    return { user, person, second, controller, context, page, session, url, modelRequests, idle, success, assertDrafts, finish };
  }

  // Losing the response after the DB commit must recover the existing request,
  // never start another task. Invalid JSON has the same uncertainty boundary.
  for (const failure of ['response-lost', 'invalid-json']) {
    const f = await journey(failure); let intercepted = 0;
    await f.page.route(f.url(), async (route) => {
      if (++intercepted !== 1) return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 200);
      if (failure === 'response-lost') return route.abort('connectionclosed');
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'synthetic invalid JSON' });
    });
    await f.page.locator('#direct-reply').click(); await f.success(); await f.assertDrafts();
    assert.equal(f.controller.calls.reply, 1); assert.equal(f.modelRequests().length, 2);
    assert.equal(new Set(f.modelRequests().map(({ body }) => body.requestId)).size, 1);
    assert.equal(server.betaStore.listJobs(f.user.id, f.person.id).filter(({ operation }) => operation === 'reply').length, 1);
    await f.finish({ sameRequestRecovered: true });
  }

  const transientOnce = await journey('confirmed-transient-once');
  transientOnce.controller.behavior.reply = async (count) => { if (count === 1) throw transient(); };
  await transientOnce.page.locator('#direct-reply').click(); await transientOnce.success(); await transientOnce.assertDrafts();
  assert.equal(transientOnce.controller.calls.reply, 2); assert.equal(transientOnce.modelRequests().length, 2);
  assert.equal(new Set(transientOnce.modelRequests().map(({ body }) => body.requestId)).size, 2);
  assert.deepEqual(server.betaStore.listJobs(transientOnce.user.id, transientOnce.person.id).filter(({ operation }) => operation === 'reply').map(({ state }) => state).sort(), ['failed', 'succeeded']);
  await transientOnce.finish({ newAttempt: 1 });

  const classify = await journey('classification-transient-recovery');
  const initialClassificationCalls = classify.controller.calls.classify;
  const initialClassificationRequests = classify.modelRequests('classify').length;
  classify.controller.behavior.classify = async (count) => { if (count === initialClassificationCalls + 1) throw transient(); };
  const classified = classify.page.waitForResponse((response) => response.url() === classify.url('classify') && response.request().method() === 'POST' && response.status() === 200);
  await classify.page.locator('#change-topic').click(); await classified; await classify.idle();
  assert.equal(classify.controller.calls.classify - initialClassificationCalls, 2);
  const recoveredClassificationRequests = classify.modelRequests('classify').slice(initialClassificationRequests);
  assert.equal(recoveredClassificationRequests.length, 2);
  assert.equal(new Set(recoveredClassificationRequests.map(({ body }) => body.requestId)).size, 2);
  await classify.assertDrafts(); await classify.finish({ sharedClassificationRecovery: true });

  const persistent = await journey('confirmed-persistent-failure');
  persistent.controller.behavior.reply = async () => { throw transient(); };
  await persistent.page.locator('#direct-reply').click(); await persistent.page.locator('#retry-coach').waitFor({ state: 'visible' }); await persistent.idle();
  assert.equal(persistent.controller.calls.reply, 2); assert.equal(persistent.modelRequests().length, 2);
  const message = (await persistent.page.locator('#coach-error p').textContent()).trim();
  assert.ok(message.length > 0 && message.length <= 45); assert.ok(!/PROVIDER_|owner|不会自动|最近操作/.test(message));
  assert.equal(await persistent.page.locator('#retry-coach').textContent(), '重试'); await persistent.assertDrafts();
  persistent.controller.behavior.reply = null;
  await persistent.page.locator('#retry-coach').click(); await persistent.success();
  assert.equal(persistent.controller.calls.reply, 3, 'The final retry is an explicit user request');
  await persistent.finish({ automaticProviderAttempts: 2, shortFinalError: true, explicitRetry: true });

  const unavailable = await journey('ambiguous-503-bounded');
  await unavailable.page.route(unavailable.url(), (route) => route.fulfill({ status: 503, contentType: 'application/json', json: { error: { code: 'MODEL_OPERATION_FAILED', message: '合成暂时失败。' } } }));
  await unavailable.page.locator('#direct-reply').click(); await unavailable.page.locator('#retry-coach').waitFor({ state: 'visible' }); await unavailable.idle();
  assert.equal(unavailable.modelRequests().length, 3); assert.equal(unavailable.controller.calls.reply, 0);
  assert.equal(new Set(unavailable.modelRequests().map(({ body }) => body.requestId)).size, 1);
  await unavailable.assertDrafts(); await unavailable.finish({ sameRequestAttempts: 3 });

  for (const [name, status, code] of [['quota', 402, 'DAILY_REPLY_QUOTA_EXHAUSTED'], ['auth', 401, 'UNAUTHORIZED'], ['validation', 400, 'INPUT_INVALID']]) {
    const f = await journey(`no-retry-${name}`);
    await f.page.route(f.url(), (route) => route.fulfill({ status, contentType: 'application/json', json: { error: { code, message: name === 'quota' ? '今日免费回复已用完。' : '合成请求需要处理。' } } }));
    await f.page.locator('#direct-reply').click();
    if (name === 'auth') await f.page.locator('#auth').waitFor({ state: 'visible' });
    else { await f.page.locator('#coach-error').waitFor({ state: 'visible' }); await f.idle(); }
    assert.equal(f.modelRequests().length, 1); assert.equal(f.controller.calls.reply, 0);
    if (name === 'quota') assert.equal(await f.page.locator('#retry-coach').isVisible(), false);
    if (name !== 'auth') await f.assertDrafts(); await f.finish({ forbiddenAutomaticRetries: true });
  }

  for (const changed of ['object', 'context', 'object-roundtrip']) {
    const f = await journey(`scope-change-${changed}`), entered = deferred(), release = deferred();
    f.controller.behavior.reply = async () => { entered.resolve(); await release.promise; throw transient(); };
    await f.page.locator('#direct-reply').click(); await entered.promise;
    if (changed !== 'context') {
      await f.page.locator('#counterpart-select').selectOption(f.second.id);
      await f.page.waitForFunction((id) => document.getElementById('counterpart-select').value === id && !document.getElementById('message-text').disabled, f.second.id);
      await f.page.locator('#message-text').fill('另一对象的草稿。');
      if (changed === 'object-roundtrip') {
        await f.page.locator('#counterpart-select').selectOption(f.person.id);
        await f.page.waitForFunction((id) => document.getElementById('counterpart-select').value === id && document.getElementById('message-text').value === '未提交的消息草稿。', f.person.id);
      }
    } else {
      const record = server.betaStore.listMessages(f.user.id, f.person.id)[0];
      const note = f.page.locator(`[data-message-id="${record.id}"] .message-annotation`);
      await note.locator('summary').click(); await note.locator('textarea').fill('本轮上下文已变更。');
      const saved = f.page.waitForResponse((response) => response.url().endsWith('/annotation') && response.request().method() === 'PATCH');
      await note.locator('button[type=submit]').click(); assert.equal((await saved).status(), 200);
      await f.page.waitForFunction(() => [...document.querySelectorAll('.message-annotation button[type=submit]')].every((button) => !button.disabled));
    }
    const failed = f.page.waitForResponse((response) => response.url() === f.url() && response.request().method() === 'POST');
    release.resolve(); assert.equal((await failed).status(), 502);
    await f.page.waitForTimeout(2_200); // Exceeds both specified recovery delays, while no scope is eligible.
    assert.equal(f.controller.calls.reply, 1); assert.equal(f.modelRequests().length, 1);
    assert.equal(await f.page.locator('#retry-coach').isVisible(), false);
    if (changed === 'object') assert.equal(await f.page.locator('#message-text').inputValue(), '另一对象的草稿。');
    else await f.assertDrafts();
    await f.finish({ staleScopeStopped: true });
  }

  const obsoleteError = await journey('final-error-context-changed');
  obsoleteError.controller.behavior.reply = async () => { throw transient(); };
  await obsoleteError.page.locator('#direct-reply').click(); await obsoleteError.page.locator('#retry-coach').waitFor({ state: 'visible' }); await obsoleteError.idle();
  assert.equal(obsoleteError.controller.calls.reply, 2);
  const annotatedMessage = server.betaStore.listMessages(obsoleteError.user.id, obsoleteError.person.id)[0];
  const annotation = obsoleteError.page.locator(`[data-message-id="${annotatedMessage.id}"] .message-annotation`);
  await annotation.locator('summary').click(); await annotation.locator('textarea').fill('失败后补充的全新背景。');
  const annotationSaved = obsoleteError.page.waitForResponse((response) => response.url().endsWith('/annotation') && response.request().method() === 'PATCH');
  await annotation.locator('button[type=submit]').click(); assert.equal((await annotationSaved).status(), 200);
  await obsoleteError.page.locator('#coach-error').waitFor({ state: 'hidden' });
  assert.equal(obsoleteError.controller.calls.reply, 2, 'Editing background hides an obsolete retry without automatically invoking a model');
  await obsoleteError.assertDrafts(); await obsoleteError.finish({ obsoleteErrorHidden: true });

  // The shared model recovery path also applies to explicit coach plans and
  // image interpretation; neither may overwrite the user's changing input.
  const plan = await journey('plan-transient-recovery');
  plan.controller.behavior['coach-plan'] = async (count) => { if (count === 1) throw transient('provider_unreachable'); };
  await plan.page.locator('#field-coach-plan-submit').click();
  await plan.page.locator('.coach-plan-verdict').waitFor({ state: 'visible' });
  assert.equal(plan.controller.calls['coach-plan'], 2); assert.equal(plan.modelRequests('coach-plan').length, 2);
  assert.equal(new Set(plan.modelRequests('coach-plan').map(({ body }) => body.requestId)).size, 2);
  await plan.assertDrafts(); await plan.finish({ sharedPlanRecovery: true });

  const image = await journey('image-response-lost'); let imageIntercepted = 0;
  await image.page.route(image.url('image-read'), async (route) => { if (++imageIntercepted !== 1) return route.continue(); const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionclosed'); });
  await image.page.locator('#message-image-file').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await image.page.locator('#message-image-preview').waitFor({ state: 'visible' });
  await image.page.waitForFunction(() => document.getElementById('save-message').textContent === '识读图片');
  await image.page.locator('#save-message').click(); await image.page.locator('#message-image-result').waitFor({ state: 'visible' });
  assert.equal(image.controller.calls['image-read'], 1); assert.equal(image.modelRequests('image-read').length, 2);
  assert.equal(new Set(image.modelRequests('image-read').map(({ body }) => body.requestId)).size, 1);
  await image.finish({ sharedImageRecovery: true });

  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  report.passed = true; await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  for (const context of contexts) await context.close();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
