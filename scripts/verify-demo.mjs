import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';
import { computeHeat } from '../src/domain.mjs';

// Synthetic, isolated browser acceptance; never reads provider credentials.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-direct-demo-'));
const evidenceDir = join(process.cwd(), 'runs/browser-demo');
let server, browser;
try {
  const knowledge = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md');
  await writeFile(knowledgePath, knowledge);
  await mkdir(evidenceDir, { recursive: true });
  let classifications = 0, replies = 0, plans = 0, nextFailure = false, holdClassification = null;
  let timingClockOffset = 0;
  let releaseClassification, releasePlan, holdPlan;
  // The expanded mock journey exceeds ten operations; production budget defaults stay unchanged.
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, localDemoMode: true, paidProviderDailyLimit: 20, now: () => Date.now() + timingClockOffset,
    classifyFn: async (context, options) => {
      classifications++; assert.equal(options.knowledgeText, knowledge);
      if (nextFailure) { nextFailure = false; throw Object.assign(new Error('Synthetic classification timeout'), { code: 'PROVIDER_TIMEOUT' }); }
      if (holdClassification) { const held = holdClassification; holdClassification = null; await held; }
      const id = context.messages.at(-1).id;
      const observed = { level: 'positive', evidenceIds: [...new Set([context.messages.find((message) => message.speaker === 'other')?.id || id, id])] };
      return { status: 'ready', confidence: 'moderate', phase: 'ordinary',
        obstacle: { type: 'none', evidenceIds: [], reason: '她主动延续工作话题。' },
        heat: { activeInteraction: observed, responseEngagement: observed, personalInterest: observed, reciprocalFlirting: { level: 'unknown', evidenceIds: [] }, actionFollowThrough: { level: 'unknown', evidenceIds: [] } },
        topicDecision: { mode: 'change', reason: '合成换题局面，用于三方向与并发回归。' },
        options: [['up', .6], ['down', .1], ['sideways', .3]].map(([topicMove, weight]) => ({ topicMove, weight, relationAction: 'continue', reason: '依据当前的工作话题继续了解。', evidenceIds: [id] })),
        uncertainties: ['对方是否愿意见面尚不清楚。'], recommendationKind: 'uncalibrated',
        fieldCoach: { currentTopic: '工作与新项目', topicStatus: 'developing', topicMessageIds: [id], initiative: '先接住她的新项目，再带入自己的具体经历。', nextAction: '顺着当前话题了解一处细节。', warmingLayer: 'none', reason: '她还在自然展开话题。' } };
    },
    planFn: async ({ context, plan }, options) => {
      plans++; if (holdPlan) await holdPlan; assert.equal(options.knowledgeText, knowledge); assert.equal(plan, '我想分享一个自己的项目，再问她怎么处理困难。');
      return { verdict: 'suitable', reason: '先分享再提问，更容易形成双向交流。', timingSuggestion: { status: 'after_response', guidance: '等她把当前项目讲完，再接一段自己的经历。', evidenceIds: [context.messages.at(-1).id] }, nextAction: '先听完当前回应。' };
    },
    replyFn: async ({ context, direction }, options) => {
      replies++; assert.equal(options.knowledgeText, knowledge); assert.equal(direction, 'down');
      assert.equal(JSON.parse(context.userProfile).questionnaire.answers.length, 10);
      return { reply: '我做产品设计。你这个新项目具体在做什么？', reason: '回答她的问题，再接住她主动提到的新项目。', action: 'reply', styleNote: '保留简短自然的表达。' };
    },
  });
  await server.ensureDemoSeed();
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  async function response(suffix, method, action) {
    const waiting = page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === method);
    await action(); const r = await waiting; const payload = await r.json(); assert.equal(r.status(), 200, JSON.stringify(payload)); return payload.data;
  }
  await page.goto(origin);
  await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#auth').isVisible(), false);
  assert.equal(await page.locator('#demo-banner').isVisible(), true);
  assert.equal(await page.locator('.message-bubble').count(), 4);
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  assert.equal(classifications, 1, 'First complete context analyzes once');
  assert.equal(replies, 0, 'Opening does not generate a reply');
  assert.equal(await page.locator('#direction-options button').count(), 3);
  assert.ok((await page.locator('[data-direction=down]').textContent()).includes('10%'));
  assert.equal(await page.locator('[data-direction=down] .weight').textContent(), '10%');
  assert.equal(await page.locator('[data-direction=down]').getAttribute('aria-label'), '下切，建议占比 10%');
  assert.ok((await page.locator('#field-coach-topic').textContent()).includes('工作与新项目'));
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '约65°');
  assert.equal(await page.locator('.coach-actions > li').count(), 3);
  assert.ok((await page.locator('#field-coach-heat-basis').textContent()).includes('已观察 3/5 维度'));
  assert.ok((await page.locator('#field-coach-pitfall').textContent()).startsWith('通用提醒'), 'Legacy cached output uses a labeled generic reminder');
  assert.equal(await page.locator('#field-coach-details').getAttribute('open'), null);
  assert.equal(await page.locator('#field-coach-full-guidance').isVisible(), false, 'Long explanations stay collapsed');
  assert.equal(await page.locator('#profile-view').isVisible(), false);
  assert.equal(await page.locator('#heat-panel').isVisible(), false);
  const other = await page.locator('.message.other .message-bubble').first().boundingBox();
  const self = await page.locator('.message.self .message-bubble').first().boundingBox();
  assert.ok(other.x < self.x && other.x + other.width < self.x + self.width, 'Speakers occupy opposite sides');
  await page.locator('#chat-menu > summary').focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'edit-counterpart');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.matches('#chat-menu > summary')), true);
  await page.locator('#chat-menu > summary').click();
  await page.locator('[data-view=profile]').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'profile-background');
  await page.locator('[data-close=profile-view]').click();
  assert.equal(await page.evaluate(() => document.activeElement.matches('#chat-menu > summary')), true, await page.evaluate(() => JSON.stringify({ tag: document.activeElement.tagName, id: document.activeElement.id, visible: document.activeElement.checkVisibility() })));
  await page.screenshot({ path: join(evidenceDir, 'day.png'), fullPage: true });
  const id = await page.locator('#counterpart-select').inputValue();
  // Actual heat-rule edge cases through the browser, isolated from saved jobs.
  // Opening/collapsing the coach and reading legacy results make no model calls.
  const originalDetail = (await (await context.request.get(`${origin}/api/counterparts/${id}`)).json()).data;
  const fixtureOther = originalDetail.messages.find((message) => message.speaker === 'other').id;
  const fixtureLast = originalDetail.messages.at(-1).id;
  let coachScenario = null;
  await page.route(`**/api/counterparts/${id}`, async (route) => {
    if (route.request().method() !== 'GET' || !coachScenario) return route.continue();
    const received = await route.fetch(); const body = await received.json();
    body.data.classification = coachScenario;
    body.data.heat = computeHeat(coachScenario);
    await route.fulfill({ response: received, json: body });
  });
  function scenario(level, evidenceIds, obstacle = 'none') {
    return { ...originalDetail.classification,
      obstacle: { type: obstacle, reason: '合成边界验证。', evidenceIds: obstacle === 'negative' ? [fixtureLast] : [] },
      heat: Object.fromEntries(Object.keys(originalDetail.classification.heat).map((dimension) => [dimension, { level, evidenceIds }])),
      fieldCoach: { ...originalDetail.classification.fieldCoach, initiative: '邀请她来家里。但先确认她愿意接受这类邀请，未知时不要推进。', pitfall: '别跳过她的真实意愿。' },
    };
  }
  coachScenario = scenario('repeated_positive', [fixtureOther]);
  assert.equal(computeHeat(coachScenario).score, null);
  assert.equal(computeHeat(coachScenario).status, 'insufficient_evidence');
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '待判断', 'One message does not establish a numeric heat score');
  assert.ok((await page.locator('#field-coach-initiative').textContent()).includes('未知时不要推进'), 'Legacy conditions and negations remain intact');
  await page.locator('#field-coach-details > summary').click();
  assert.equal(await page.locator('#field-coach-full-guidance').isVisible(), true);
  assert.equal(classifications, 1); assert.equal(replies, 0); assert.equal(plans, 0);
  coachScenario = scenario('repeated_positive', [fixtureOther, fixtureLast], 'negative');
  assert.equal(computeHeat(coachScenario).score, 100);
  assert.equal(computeHeat(coachScenario).status, 'pause');
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '先停推进');
  assert.equal(await page.locator('#field-coach-initiative').textContent(), '停止这类推进，尊重她的边界。');
  assert.equal(await page.locator('#field-coach-next').textContent(), '先留白，暂不升级或邀约。');
  coachScenario = { ...scenario('positive', [fixtureOther, fixtureLast]),
    options: originalDetail.classification.options.map((option) => ({ ...option, weight: option.topicMove === 'down' ? 0 : .5 })),
  };
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#field-coach-next').textContent()).startsWith('并列可选上切 / 平移'));
  assert.equal(await page.locator('#field-coach-pitfall').textContent(), '别跳过她的真实意愿。');
  coachScenario = scenario('unknown', []);
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '待判断');
  await page.unroute(`**/api/counterparts/${id}`);
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '约65°');
  assert.equal(classifications, 1); assert.equal(replies, 0); assert.equal(plans, 0);
  const originalText = '我刚好也参与了一个品牌项目。';
  await page.locator('#message-text').fill(originalText);
  let lostFollowup;
  await page.route('**/followup', async (route) => {
    lostFollowup = route.request().postDataJSON();
    const accepted = await route.fetch(); assert.equal(accepted.status(), 200);
    await route.abort('failed');
  });
  await page.locator('#save-message').click();
  await page.locator('#message-form .form-error').waitFor({ state: 'visible' });
  await page.unroute('**/followup');
  const replayRequest = page.waitForRequest((r) => r.url().endsWith(`/api/counterparts/${id}/followup`) && r.method() === 'POST');
  const replayedFollowup = await response(`/api/counterparts/${id}/followup`, 'POST', () => page.locator('#save-message').click());
  assert.deepEqual((await replayRequest).postDataJSON(), lostFollowup, 'Unknown-network retry reuses the same receipt and body');
  assert.equal(replayedFollowup.cached, true);
  assert.equal((await (await context.request.get(`${origin}/api/counterparts/${id}`)).json()).data.messages.filter((message) => message.text === originalText).length, 1);
  await page.locator('.message-bubble').filter({ hasText: originalText }).waitFor();
  assert.equal(await page.locator('#message-text').inputValue(), '', 'Successful message recording clears the composer');
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  assert.equal(classifications, 2, 'New other message analyzes once');
  await response(`/api/counterparts/${id}/reply`, 'POST', () => page.locator('[data-direction=down]').click());
  await page.locator('#suggestion-panel').waitFor({ state: 'visible' });
  const edited = '我做产品设计。你那个项目主要是在做什么？';
  await page.locator('#suggestion-text').fill(edited);
  await page.locator('#message-text').fill('尚未提交的示例草稿');
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
  assert.equal(await page.locator('#suggestion-text').inputValue(), edited);
  assert.equal(await page.locator('#message-text').inputValue(), '尚未提交的示例草稿');
  assert.equal(classifications, 2); assert.equal(replies, 1);
  await page.screenshot({ path: join(evidenceDir, 'night.png'), fullPage: true });
  await response(`/api/counterparts/${id}/suggestions/${(await (await context.request.get(`${origin}/api/counterparts/${id}`)).json()).data.suggestions.at(-1).id}/copied`, 'POST', () => page.locator('#copy-reply').click());
  await page.waitForFunction(() => !document.getElementById('copy-reply').disabled);
  assert.equal(await page.locator('[data-direction=down]').getAttribute('aria-pressed'), 'true', 'Copy refresh preserves the actual displayed direction');
  assert.equal(await page.locator('#suggestion-direction').textContent(), '下切');
  const followupText = '这个项目主要做品牌升级。';
  await page.locator('#message-text').fill(followupText);
  const followup = await response(`/api/counterparts/${id}/followup`, 'POST', () => page.locator('#save-message').click());
  assert.equal(followup.previousMessage.provenance, 'inferred_from_followup');
  assert.equal(followup.previousMessage.text, edited);
  assert.equal(followup.feedback.stage, 'raw_untrusted');
  assert.equal(followup.timing.fromSource, 'clipboard_copied');
  await page.locator('.message-bubble').filter({ hasText: followupText }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  await page.locator('#timing-note').filter({ hasText: '录入估计' }).waitFor();
  assert.equal(classifications, 3); assert.equal(replies, 1);
  const me = (await (await context.request.get(`${origin}/api/me`)).json()).data;
  const record = server.betaStore.listFeedback(me.user.id).find((item) => item.id === followup.feedback.id);
  assert.equal(record.raw.payload.consent, false);
  assert.equal(await readFile(knowledgePath, 'utf8'), knowledge);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px overflow`);
    const composer = await page.locator('#message-form').boundingBox();
    assert.ok(composer.y >= 0 && composer.y + composer.height <= 845, `${width}px composer stays visible`);
  }
  await page.screenshot({ path: join(evidenceDir, 'mobile.png'), fullPage: true });
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
  assert.equal(await page.locator('#auth').isVisible(), false);
  await page.waitForTimeout(150);
  assert.equal(classifications, 3); assert.equal(replies, 1, 'Reload does not generate another reply');
  assert.deepEqual(pageErrors, []);
  const failContext = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const failPage = await failContext.newPage();
  failPage.on('pageerror', (error) => pageErrors.push(error.message));
  const fail = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成启动故障，可稍后重试。' } }) });
  for (const endpoint of ['api/meta', 'api/demo/session']) {
    await failPage.route(`**/${endpoint}`, fail);
    await failPage.goto(origin);
    await failPage.locator('#startup-retry').waitFor({ state: 'visible' });
    assert.equal(await failPage.locator('#auth').isVisible(), false, 'Boot failures never fall back to login');
    await failPage.unroute(`**/${endpoint}`);
    await failPage.locator('#startup-retry').click();
    await failPage.locator('#counterpart-workspace').waitFor({ state: 'visible' });
    assert.equal(await failPage.locator('#startup-status').isVisible(), false);
    assert.equal(await failPage.evaluate(() => document.activeElement.id), 'message-text', 'Retry returns focus to the visible composer');
  }
  await failPage.route('**/followup', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_FORBIDDEN', message: '合成保存故障。' } }) }));
  await failPage.locator('#message-text').fill('合成故障检查，不写入任何记录。');
  await failPage.locator('#save-message').click();
  await failPage.locator('#message-form .form-error').waitFor({ state: 'visible' });
  await failPage.unroute('**/followup');
  await failPage.route('**/classify', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: '合成会话结束。' } }) }));
  await failPage.locator('#coach-panel > .coach-details > summary').click();
  await failPage.locator('#classify').click();
  await failPage.locator('#startup-retry').waitFor({ state: 'visible' });
  assert.equal(await failPage.locator('#auth').isVisible(), false);
  assert.equal(await failPage.locator('#auth-status').count(), 1, 'Session cleanup preserves permanent status nodes');
  assert.equal(await failPage.locator('#startup-message').count(), 1);
  await failPage.unroute('**/classify');
  await failPage.locator('#startup-retry').click();
  await failPage.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await failContext.close();
  assert.equal(classifications, 3); assert.equal(replies, 1); assert.deepEqual(pageErrors, []);
  // A completed request for another object cannot clear this object's draft or loading state.
  await page.locator('#add-counterpart').click();
  await page.locator('#intake-alias').fill('虚构对象 B'); await page.locator('#intake-app').fill('虚构资料，喜欢电影。');
  await page.locator('#intake-background').fill('虚构跨对象并发验收。');
  const second = await response('/api/counterparts', 'POST', () => page.locator('#counterpart-form button[type=submit]').click());
  const secondId = second.counterpart.id;
  holdClassification = new Promise((done) => { releaseClassification = done; });
  await page.locator('#message-text').fill('虚构 B 的第一句。');
  await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  await page.locator('#coach-loading').waitFor({ state: 'visible' });
  await page.locator('#counterpart-select').selectOption(id);
  await page.locator('#message-text').waitFor({ state: 'visible' });
  await page.waitForFunction((id) => document.getElementById('counterpart-select').value === id && !document.getElementById('message-text').disabled, id);
  await page.locator('#message-text').fill('A 的未提交草稿');
  releaseClassification();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#message-text').inputValue(), 'A 的未提交草稿');
  assert.equal(await page.locator('#coach-loading').isVisible(), false);
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  assert.equal(classifications, 4);
  nextFailure = true;
  await page.locator('#message-text').fill('这轮合成分析会失败。');
  await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  await page.locator('#coach-error').waitFor({ state: 'visible' });
  assert.equal(classifications, 5);
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.waitForTimeout(150);
  assert.equal(classifications, 5, 'Failed current context does not auto-retry after reload');
  await response(`/api/counterparts/${secondId}/classify`, 'POST', async () => { if (!await page.locator('#classify').isVisible()) await page.locator('#coach-panel > .coach-details > summary').click(); await page.locator('#classify').click(); });
  assert.equal(classifications, 6, 'Explicit reanalysis is allowed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-field-coach').click();
  assert.equal(await page.locator('#field-coach').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'field-coach-title');
  const coachPlan = '我想分享一个自己的项目，再问她怎么处理困难。';
  await page.locator('#field-coach-plan').fill(coachPlan);
  const beforePlan = (await (await context.request.get(`${origin}/api/counterparts/${secondId}`)).json()).data;
  holdPlan = new Promise((done) => { releasePlan = done; });
  const planResponse = page.waitForResponse((r) => r.url().endsWith(`/api/counterparts/${secondId}/coach-plan`) && r.request().method() === 'POST');
  await page.locator('#field-coach-plan-submit').click();
  await page.locator('#field-coach-plan-submit').filter({ hasText: '教练正在看' }).waitFor();
  await page.locator('#close-field-coach').click();
  await page.locator('#counterpart-select').selectOption(id);
  await page.waitForFunction(() => !document.getElementById('message-text').disabled);
  await page.locator('#toggle-field-coach').click();
  await page.locator('#field-coach-plan').fill('A 的未提交主导计划');
  releasePlan();
  assert.equal((await planResponse).status(), 200);
  assert.equal(await page.locator('#field-coach-plan').inputValue(), 'A 的未提交主导计划');
  assert.equal(await page.locator('#field-coach-plan-result').textContent(), '', 'Background B assessment never appears for A');
  await page.locator('#close-field-coach').click();
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.waitForFunction(() => !document.getElementById('message-text').disabled);
  await page.locator('#toggle-field-coach').click();
  await page.locator('#field-coach-plan-result').filter({ hasText: '等对方回应后' }).waitFor();
  const afterPlan = (await (await context.request.get(`${origin}/api/counterparts/${secondId}`)).json()).data;
  assert.equal(afterPlan.messages.length, beforePlan.messages.length, 'Coach plan is not a WeChat message');
  assert.equal(afterPlan.suggestions.length, beforePlan.suggestions.length, 'Coach plan is not a pending reply');
  assert.equal(plans, 1);
  await page.locator('#field-coach-plan').focus(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#field-coach').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle-field-coach');
  await page.locator('#counterpart-select').selectOption(id); await page.locator('#message-text').waitFor({ state: 'visible' });
  await page.locator('#toggle-field-coach').click();
  assert.equal(await page.locator('#field-coach-plan').inputValue(), 'A 的未提交主导计划');
  await page.locator('#close-field-coach').click();
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.locator('#message-text').waitFor({ state: 'visible' });
  await page.locator('#toggle-field-coach').click();
  assert.equal(await page.locator('#field-coach-plan').inputValue(), coachPlan);
  await page.locator('#close-field-coach').click();
  const beforeTiming = (await (await context.request.get(`${origin}/api/counterparts/${secondId}`)).json()).data.messages.at(-1);
  const messageCard = page.locator(`[data-message-id="${beforeTiming.id}"]`);
  await messageCard.locator('.message-menu > summary').click();
  await messageCard.getByRole('button', { name: '编辑对方的消息' }).click();
  await page.locator('#message-speaker').selectOption('self');
  await page.locator('#message-text').fill('重要的未提交编辑草稿，修改时间不得擦掉。');
  await messageCard.locator('.message-menu > summary').click();
  await messageCard.getByRole('button', { name: '修改消息时间' }).click();
  const timingEditor = messageCard.locator('.message-time-edit');
  const hour = timingEditor.getByRole('textbox', { name: '小时', exact: true });
  const minute = timingEditor.getByRole('textbox', { name: '分钟', exact: true });
  const dateDisclosure = timingEditor.locator('details.message-time-date');
  const date = dateDisclosure.locator('input[type=date]');
  const recordedLocal = await page.evaluate((at) => {
    const value = new Date(at);
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }, beforeTiming.recordedAt);
  assert.equal(await minute.evaluate((input) => document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length), true, 'Time correction starts with the minute selected');
  for (const input of [hour, minute]) {
    assert.equal(await input.getAttribute('type'), 'text');
    assert.equal(await input.getAttribute('inputmode'), 'numeric');
    assert.equal(await input.getAttribute('maxlength'), '2');
  }
  assert.equal(await hour.inputValue(), recordedLocal.slice(11, 13));
  assert.equal(await minute.inputValue(), recordedLocal.slice(14, 16));
  assert.equal(await date.inputValue(), recordedLocal.slice(0, 10));
  assert.equal(await dateDisclosure.evaluate((element) => element.open), false, 'The date is secondary until explicitly expanded');
  assert.equal(await date.isVisible(), false);
  assert.equal(await timingEditor.getByRole('button', { name: '清除修改', exact: true }).isVisible(), false);
  assert.equal((await timingEditor.textContent()).includes('未核验'), false);
  const timeViewport = page.viewportSize(), timeTheme = await page.locator('html').getAttribute('data-theme');
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await timingEditor.scrollIntoViewIfNeeded();
      await minute.focus(); await minute.evaluate((input) => input.select());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px time editor stays within the viewport`);
      assert.equal(await dateDisclosure.evaluate((element) => element.open), false);
      await page.screenshot({ path: join(evidenceDir, `time-edit-${width}-${theme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize(timeViewport);
  if (await page.locator('html').getAttribute('data-theme') !== timeTheme) await page.locator('#theme-toggle').click();
  const timingUrl = `${origin}/api/counterparts/${secondId}/messages/${beforeTiming.id}/timing`;
  // At xx:00 the only different same-hour minute is in the future. Advance the
  // isolated server clock two minutes only for that boundary, without sleeping.
  const originalMinute = Number(recordedLocal.slice(14, 16));
  if (originalMinute === 0) timingClockOffset = 120_000;
  const correctedMinute = String(originalMinute > 0 ? originalMinute - 1 : 1).padStart(2, '0');
  await minute.fill(correctedMinute);
  const minuteOnly = await response(`/api/counterparts/${secondId}/messages/${beforeTiming.id}/timing`, 'PATCH', () => timingEditor.getByRole('button', { name: '保存时间', exact: true }).click());
  assert.equal(minuteOnly.message.wechatTime.at, await page.evaluate((value) => new Date(value).toISOString(), `${recordedLocal.slice(0, 14)}${correctedMinute}`), 'Changing only minutes persists the original local year/month/day/hour');
  assert.equal(minuteOnly.message.recordedAt, beforeTiming.recordedAt);
  assert.equal(minuteOnly.message.wechatTime.source, 'user_reported');
  await messageCard.locator('.message-label').filter({ hasText: '标注' }).waitFor();
  await messageCard.locator('.message-menu > summary').click();
  await messageCard.getByRole('button', { name: '修改消息时间' }).click();
  assert.equal(await minute.inputValue(), correctedMinute);
  assert.equal(await hour.inputValue(), recordedLocal.slice(11, 13));
  assert.equal(await date.inputValue(), recordedLocal.slice(0, 10));
  assert.equal(await dateDisclosure.evaluate((element) => element.open), false);
  let invalidTimingRequests = 0;
  const countInvalidTiming = (request) => { if (request.url() === timingUrl && request.method() === 'PATCH') invalidTimingRequests++; };
  page.on('request', countInvalidTiming);
  for (const [hours, minutes] of [['24', '03'], [recordedLocal.slice(11, 13), '60'], ['', '03'], [recordedLocal.slice(11, 13), '']]) {
    await hour.fill(hours); await minute.fill(minutes);
    await timingEditor.getByRole('button', { name: '保存时间', exact: true }).click();
    await timingEditor.locator('.form-error').filter({ hasText: '0–23' }).waitFor({ state: 'visible' });
    assert.equal(invalidTimingRequests, 0, 'An out-of-range or partially empty clock stays local');
  }
  page.off('request', countInvalidTiming);
  const reported = new Date(Date.now() - 49 * 3600000);
  const reportedLocal = new Date(reported.getTime() - reported.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await hour.fill(reportedLocal.slice(11, 13)); await minute.fill(reportedLocal.slice(14, 16));
  await dateDisclosure.locator('summary').click(); await date.fill(reportedLocal.slice(0, 10));
  const timingFailure = deferred(), timingStarted = deferred();
  await page.route(timingUrl, async (route) => { timingStarted.resolve(); await timingFailure.promise; await route.fulfill({ status: 503, contentType: 'application/json', json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成时间保存失败，可稍后重试。' } } }); });
  await timingEditor.getByRole('button', { name: '保存时间', exact: true }).click();
  await timingStarted.promise;
  try {
    for (const input of [hour, minute, date]) assert.equal(await input.isDisabled(), true, 'Pending time save locks the submitted fields');
    assert.equal(await timingEditor.locator('button[type=submit]').isDisabled(), true);
    assert.equal(await page.locator('[data-edit-time]').evaluateAll((buttons) => buttons.length > 1 && buttons.every((button) => button.disabled)), true, 'Pending time save blocks another editor for this conversation');
  } finally { timingFailure.resolve(); }
  await timingEditor.locator('.form-error').waitFor({ state: 'visible' });
  for (const input of [hour, minute, date]) assert.equal(await input.isDisabled(), false, 'Failed saves unlock the retained fields');
  assert.equal(await timingEditor.getByRole('button', { name: '保存时间', exact: true }).isDisabled(), false);
  assert.equal(await page.locator('[data-edit-time]').evaluateAll((buttons) => buttons.every((button) => !button.disabled)), true);
  assert.equal(await hour.inputValue(), reportedLocal.slice(11, 13));
  assert.equal(await minute.inputValue(), reportedLocal.slice(14, 16));
  assert.equal(await date.inputValue(), reportedLocal.slice(0, 10));
  assert.equal(await page.locator('#message-text').inputValue(), '重要的未提交编辑草稿，修改时间不得擦掉。', 'Failed timing changes retain unrelated composer input');
  await page.unroute(timingUrl);
  const timingChange = await response(`/api/counterparts/${secondId}/messages/${beforeTiming.id}/timing`, 'PATCH', () => messageCard.getByRole('button', { name: '保存时间' }).click());
  assert.equal(timingChange.message.recordedAt, beforeTiming.recordedAt);
  assert.equal(timingChange.message.wechatTime.source, 'user_reported');
  assert.equal(timingChange.message.wechatTime.at, await page.evaluate((value) => new Date(value).toISOString(), reportedLocal));
  await messageCard.locator('.message-label').filter({ hasText: '标注' }).waitFor();
  assert.equal(await page.locator('#message-text').inputValue(), '重要的未提交编辑草稿，修改时间不得擦掉。');
  assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
  assert.equal(await page.locator('#cancel-message-edit').isVisible(), true);
  assert.equal(await page.locator('#save-message').textContent(), '保存修改');
  await messageCard.locator('.message-label').filter({ hasText: '标注' }).waitFor();
  assert.ok(!(await messageCard.locator('.message-label').textContent()).includes('录入'), 'Primary time uses the explicit annotation');
  assert.ok((await messageCard.locator('.message-label').getAttribute('title')).includes(beforeTiming.recordedAt));
  await messageCard.locator('.message-menu > summary').click();
  await messageCard.getByRole('button', { name: '修改消息时间' }).click();
  assert.equal(await minute.inputValue(), reportedLocal.slice(14, 16), 'Reopening uses the saved correction');
  assert.equal(await dateDisclosure.evaluate((element) => element.open), false);
  const clearedTiming = await response(`/api/counterparts/${secondId}/messages/${beforeTiming.id}/timing`, 'PATCH', () => timingEditor.getByRole('button', { name: '清除修改', exact: true }).click());
  assert.equal(clearedTiming.message.wechatTime, null);
  assert.equal(clearedTiming.message.recordedAt, beforeTiming.recordedAt);
  await messageCard.locator('.message-label').filter({ hasText: '录入' }).waitFor();
  assert.equal(await page.locator('#message-text').inputValue(), '重要的未提交编辑草稿，修改时间不得擦掉。');
  // Keep the original journey's corrected-time context for its followup checks.
  await messageCard.locator('.message-menu > summary').click();
  await messageCard.getByRole('button', { name: '修改消息时间' }).click();
  assert.equal(await date.inputValue(), recordedLocal.slice(0, 10), 'Clearing returns the editor default to the original recording date');
  await hour.fill(reportedLocal.slice(11, 13)); await minute.fill(reportedLocal.slice(14, 16));
  await dateDisclosure.locator('summary').click(); await date.fill(reportedLocal.slice(0, 10));
  await response(`/api/counterparts/${secondId}/messages/${beforeTiming.id}/timing`, 'PATCH', () => timingEditor.getByRole('button', { name: '保存时间', exact: true }).click());
  await messageCard.locator('.message-label').filter({ hasText: '标注' }).waitFor();
  assert.equal(classifications, 6, 'Changing metadata does not silently call the model');
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '待判断', 'Correcting time invalidates the previous displayed temperature');
  await response(`/api/counterparts/${secondId}/classify`, 'POST', async () => { if (!await page.locator('#classify').isVisible()) await page.locator('#coach-panel > .coach-details > summary').click(); await page.locator('#classify').click(); });
  assert.equal(classifications, 7);
  await page.locator('#cancel-message-edit').click();
  const suggestedA = (await response(`/api/counterparts/${secondId}/reply`, 'POST', () => page.locator('[data-direction=down]').click())).suggestion;
  assert.equal(suggestedA.pendingEligible, true);
  const feedbackBeforeManual = server.betaStore.listFeedback(me.user.id).length;
  const manualB = '这是我自己真正发送的 B，不是 AI 的 A。';
  await page.locator('#message-speaker').selectOption('self'); await page.locator('#message-text').fill(manualB);
  await response(`/api/counterparts/${secondId}/messages`, 'POST', () => page.locator('#save-message').click());
  await page.locator('.message-bubble').filter({ hasText: manualB }).waitFor();
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false, 'Manual self text supersedes the old AI pending bubble');
  assert.equal(await page.locator('#suggestion-history').isVisible(), true, 'A single historical suggestion stays reachable');
  async function viewHistoricalA() {
    const history = page.locator(`[data-suggestion-id="${suggestedA.id}"]`);
    if (!await history.isVisible()) await page.locator('#suggestion-history > summary').click();
    await history.click();
    await page.locator('#suggestion-panel').waitFor({ state: 'visible' });
  }
  await viewHistoricalA();
  assert.ok((await page.locator('#suggestion-title').textContent()).includes('仅供查看'));
  const counterpartC = '这是对我实际 B 的后续 C。';
  await page.locator('#message-speaker').selectOption('other'); await page.locator('#message-text').fill(counterpartC);
  const cRequest = page.waitForRequest((r) => r.url().endsWith(`/api/counterparts/${secondId}/followup`) && r.method() === 'POST');
  const cResult = await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  assert.equal((await cRequest).postDataJSON().previousSuggestionId, undefined, 'Browsing old A does not select its feedback source');
  assert.equal(cResult.previousMessage, null); assert.equal(cResult.feedback, null);
  assert.equal(cResult.timing.fromSource, 'unknown');
  await page.locator('.message-bubble').filter({ hasText: counterpartC }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  const afterC = (await (await context.request.get(`${origin}/api/counterparts/${secondId}`)).json()).data;
  assert.deepEqual(afterC.messages.slice(-2).map((message) => message.text), [manualB, counterpartC]);
  assert.equal(server.betaStore.listFeedback(me.user.id).length, feedbackBeforeManual, 'No stale A feedback anchor is created');
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.waitForFunction(() => !document.getElementById('message-text').disabled);
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false, 'Reload never restores superseded A as pending');
  const newAfterB = (await response(`/api/counterparts/${secondId}/reply`, 'POST', () => page.locator('[data-direction=down]').click())).suggestion;
  assert.equal(newAfterB.pendingEligible, true, 'A new reply after B remains eligible');
  await viewHistoricalA();
  const copiedHistoricalText = '旧建议重新使用时，这个修改版本只按复制记录推定。';
  await page.locator('#suggestion-text').fill(copiedHistoricalText);
  await page.locator('#message-text').fill('复制失败也不能擦掉的草稿');
  await page.route('**/suggestions/*/copied', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_COPY_FAILURE', message: '合成复制记录故障。' } }) }));
  await page.locator('#copy-reply').click();
  await page.locator('#notice').filter({ hasText: '复制时间未保存' }).waitFor();
  assert.equal(await page.locator('#message-text').inputValue(), '复制失败也不能擦掉的草稿');
  assert.ok((await page.locator('#suggestion-title').textContent()).includes('仅供查看'));
  await page.unroute('**/suggestions/*/copied');
  const firstRecopy = await response(`/api/counterparts/${secondId}/suggestions/${suggestedA.id}/copied`, 'POST', () => page.locator('#copy-reply').click());
  await page.locator('#suggestion-title').filter({ hasText: '我 · AI 建议' }).waitFor();
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.waitForFunction(() => !document.getElementById('message-text').disabled);
  assert.equal(await page.locator('#suggestion-text').inputValue(), copiedHistoricalText, 'Reload restores the eligible edited copy');
  await page.locator('#message-text').fill('历史建议新复制后的回应一。');
  const recopyFollowup = await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  assert.equal(recopyFollowup.previousMessage.suggestionId, suggestedA.id);
  assert.equal(recopyFollowup.previousMessage.text, copiedHistoricalText);
  assert.equal(recopyFollowup.timing.fromSource, 'clipboard_copied');
  await page.locator('.message-bubble').filter({ hasText: '历史建议新复制后的回应一。' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  await viewHistoricalA();
  const secondRecopy = await response(`/api/counterparts/${secondId}/suggestions/${suggestedA.id}/copied`, 'POST', () => page.locator('#copy-reply').click());
  assert.notEqual(secondRecopy.copyReceipt.id, firstRecopy.copyReceipt.id);
  await page.locator('#suggestion-title').filter({ hasText: '我 · AI 建议' }).waitFor();
  await page.locator('#message-text').fill('同一历史建议另一次新复制后的回应二。');
  const secondRecopyFollowup = await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  assert.equal(secondRecopyFollowup.previousMessage.suggestionId, suggestedA.id);
  assert.notEqual(secondRecopyFollowup.feedback.id, recopyFollowup.feedback.id, 'A different fresh copy can support another unverified followup');
  await page.locator('.message-bubble').filter({ hasText: '同一历史建议另一次新复制后的回应二。' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  // Direction feedback uses held HTTP fixtures after the existing durable journey.
  // These extra reply requests never reach even the synthetic provider or a real account.
  const beforeDirectionChecks = { classifications, replies, plans };
  const directionLabels = { up: '上切', down: '下切', sideways: '平移' };
  const sameReply = '我也遇到过类似的项目。你当时是怎么处理的？';
  const directionRequests = [], replyQueue = [], directionFixtures = [];
  let staticDirectionFixtures = false, heldDirectionDetail = null, serverDirectionReplies = 0;
  function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }
  await page.route('**/api/counterparts/*/reply', async (route) => {
    const queued = replyQueue.shift();
    assert.ok(queued, 'Each direction request has an isolated response fixture');
    directionRequests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    if (queued.fromServer) {
      const received = await route.fetch(); assert.equal(received.status(), 200);
      queued.body = await received.json(); queued.suggestion = queued.body.data.suggestion;
      serverDirectionReplies++;
    }
    queued.arrived.resolve();
    await queued.release.promise;
    await route.fulfill({ status: queued.status, contentType: 'application/json', body: JSON.stringify(queued.body) });
  });
  await page.route(`**/api/counterparts/${secondId}`, async (route) => {
    if (route.request().method() !== 'GET' || !staticDirectionFixtures && !heldDirectionDetail) return route.continue();
    const received = await route.fetch(); const body = await received.json();
    if (staticDirectionFixtures) {
      body.data.suggestions.push(...directionFixtures);
      body.data.currentSuggestionIds = [...(body.data.currentSuggestionIds || []), ...directionFixtures.map(({ id }) => id)];
    }
    if (heldDirectionDetail) {
      const held = heldDirectionDetail; heldDirectionDetail = null;
      held.arrived.resolve(); await held.release.promise;
    }
    await route.fulfill({ response: received, json: body });
  });
  async function assertSelectedDirection(direction) {
    assert.equal(await page.locator('#direction-options [aria-pressed=true]').count(), 1);
    const selected = page.locator(`[data-direction=${direction}]`);
    assert.equal(await selected.getAttribute('aria-pressed'), 'true');
    assert.equal(await selected.evaluate((button) => button.classList.contains('selected')), true);
    assert.equal(await selected.locator('.direction-check').isVisible(), true, 'The selected direction has a visible check');
    const colors = await selected.evaluate((button) => {
      const sample = document.createElement('span'); sample.style.backgroundColor = 'var(--color-accent)'; button.append(sample);
      const result = { selected: getComputedStyle(button).backgroundColor, accent: getComputedStyle(sample).backgroundColor };
      sample.remove(); return result;
    });
    assert.equal(colors.selected, colors.accent, 'Selection uses a solid accent fill in either theme');
  }
  async function assertDirectionLoading(direction) {
    await page.locator('#suggestion-panel[aria-busy=true]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#suggestion-loading').isVisible(), true);
    const text = await page.locator('#suggestion-loading').textContent();
    assert.ok(text.includes('正在生成') && text.includes(directionLabels[direction]) && text.includes('回复'), text);
    assert.equal(await page.locator('#suggestion-editor').isVisible(), false, 'The previous draft is hidden during generation');
    assert.equal(await page.locator('#suggestion-meta').isVisible(), false);
    assert.equal(await page.locator('#copy-reply').isDisabled(), true);
    const historicalButtons = await page.locator('#suggestion-list button').all();
    assert.ok(historicalButtons.length > 0);
    for (const button of historicalButtons) assert.equal(await button.isDisabled(), true, 'History cannot replace a busy reply');
    await assertSelectedDirection(direction);
  }
  async function beginDirection(direction, { resultDirection = direction, reply = sameReply, cached = false, status = 200, fromServer = false } = {}) {
    const arrived = deferred(), release = deferred();
    const suggestion = { ...newAfterB, id: `synthetic-direction-${directionRequests.length + 1}`, direction: resultDirection,
      reply, createdAt: new Date().toISOString(), pendingReplyText: null, pendingCopyReceiptId: null, pendingEligible: true };
    const body = status === 200 ? { data: { suggestion, cached } } : { error: { code: 'SYNTHETIC_REPLY_FAILURE', message: '合成方向生成故障。' } };
    const queued = { arrived, release, status, body, suggestion, fromServer };
    replyQueue.push(queued);
    const received = page.waitForResponse((r) => r.url().endsWith(`/api/counterparts/${secondId}/reply`) && r.request().method() === 'POST');
    received.catch(() => {}); // Keep an earlier assertion failure visible if cleanup closes this held request.
    await page.locator(`[data-direction=${direction}]`).click();
    await arrived.promise;
    await assertDirectionLoading(direction);
    return { suggestion: queued.suggestion, complete: async () => { release.resolve(); assert.equal((await received).status(), status); } };
  }
  async function assertDirectionResult(direction, { cached = false, reply = sameReply, copying = false } = {}) {
    await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#suggestion-loading').isVisible(), false);
    assert.equal(await page.locator('#suggestion-editor').isVisible(), true);
    assert.equal(await page.locator('#suggestion-meta').isVisible(), true);
    assert.equal(await page.locator('#copy-reply').isDisabled(), copying);
    assert.equal(await page.locator('#suggestion-text').inputValue(), reply);
    assert.ok((await page.locator('#suggestion-direction').textContent()).includes(directionLabels[direction]), 'The marker uses the returned suggestion direction');
    assert.equal(await page.locator('#suggestion-update').getAttribute('role'), 'status');
    assert.equal(await page.locator('#suggestion-update').isVisible(), true);
    const update = await page.locator('#suggestion-update').textContent();
    assert.ok(update.includes('已切换到') && update.includes(directionLabels[direction]), update);
    if (cached) assert.ok(update.includes('已保存结果'), update);
    assert.equal(await page.locator('#suggestion-panel').evaluate((panel) => panel.classList.contains('reply-updated')), true);
    await assertSelectedDirection(direction);
    await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  }
  async function assertStaticDirection(direction) {
    await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#suggestion-direction').textContent()).includes(directionLabels[direction]));
    assert.equal(await page.locator('#suggestion-update').isVisible(), false, 'Reading history or reloading has no fresh-switch announcement');
    assert.equal(await page.locator('#suggestion-panel').evaluate((panel) => panel.classList.contains('reply-updated')), false);
    await assertSelectedDirection(direction);
  }
  await page.setViewportSize({ width: 1280, height: 950 });
  const firstDirection = await beginDirection('down');
  await page.screenshot({ path: join(evidenceDir, 'direction-loading-desktop.png'), fullPage: true });
  await firstDirection.complete(); await assertDirectionResult('down');
  directionFixtures.push(firstDirection.suggestion);
  await page.screenshot({ path: join(evidenceDir, 'direction-updated-desktop.png'), fullPage: true });
  await page.waitForFunction(() => !document.getElementById('suggestion-panel').classList.contains('reply-updated'));
  assert.equal(await page.locator('#suggestion-update').isVisible(), true, 'The status remains readable after the short highlight ends');
  // Identical text still announces the switch. Returned direction is authoritative.
  const returnedDirection = await beginDirection('up', { resultDirection: 'sideways', cached: true });
  await returnedDirection.complete(); await assertDirectionResult('sideways', { cached: true });
  directionFixtures.push(returnedDirection.suggestion);
  const retainedReplyDraft = '切换失败后必须保留的私有编辑草稿。';
  await page.locator('#suggestion-text').fill(retainedReplyDraft);
  const failedDirection = await beginDirection('up', { status: 503 });
  await failedDirection.complete();
  await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#suggestion-editor').isVisible(), true);
  assert.equal(await page.locator('#suggestion-text').inputValue(), retainedReplyDraft);
  assert.equal(await page.locator('#copy-reply').isDisabled(), false);
  await assertSelectedDirection('sideways');
  const failedUpdate = await page.locator('#suggestion-update').textContent();
  assert.ok(failedUpdate.includes('未取回') && failedUpdate.includes('新回复'), failedUpdate);
  assert.equal(await page.locator('#suggestion-update').isVisible(), true);
  assert.equal(await page.locator('#suggestion-panel').evaluate((panel) => panel.classList.contains('reply-updated')), false);
  const historyFirst = page.locator(`[data-suggestion-id="${firstDirection.suggestion.id}"]`);
  if (!await historyFirst.isVisible()) await page.locator('#suggestion-history > summary').click();
  await historyFirst.click(); await assertStaticDirection('down');
  await page.locator(`[data-suggestion-id="${returnedDirection.suggestion.id}"]`).click();
  await assertStaticDirection('sideways');
  assert.equal(await page.locator('#suggestion-text').inputValue(), retainedReplyDraft, 'History preserves edits to each suggestion');
  staticDirectionFixtures = true;
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await page.locator('#counterpart-select').selectOption(secondId);
  await assertStaticDirection('sideways');
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  // A previous copy refresh cannot replace a newly accepted reply with its stale GET.
  const copyRefresh = { arrived: deferred(), release: deferred() };
  heldDirectionDetail = copyRefresh;
  await page.route(`**/api/counterparts/${secondId}/suggestions/*/copied`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: { copyReceipt: { id: 'synthetic-held-copy' } } }),
  }));
  await page.locator('#copy-reply').click(); await copyRefresh.arrived.promise;
  assert.equal(await page.locator('#copy-reply').isDisabled(), true, 'Copy remains locked during its refresh');
  const afterOldCopyText = '新方向建议不能被旧复制的读取结果覆盖。';
  const duringCopyReply = await beginDirection('down', { reply: afterOldCopyText });
  await duringCopyReply.complete(); await assertDirectionResult('down', { reply: afterOldCopyText, copying: true });
  directionFixtures.push(duringCopyReply.suggestion);
  copyRefresh.release.resolve();
  await page.waitForFunction(() => !document.getElementById('copy-reply').disabled);
  assert.equal(await page.locator('#suggestion-text').inputValue(), afterOldCopyText);
  assert.equal(await page.locator('#suggestion-direction').textContent(), '下切');
  await assertSelectedDirection('down');
  assert.equal(await page.locator('#suggestion-update').isVisible(), true, 'Stale copy refresh preserves the new direction feedback');
  await page.unroute(`**/api/counterparts/${secondId}/suggestions/*/copied`);
  // Small screens retain the explicit labels/check and support reduced motion.
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotionReply = await beginDirection('down', { cached: true });
  assert.equal(await page.locator('#suggestion-loading').evaluate((node) => getComputedStyle(node, '::before').animationName), 'none');
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    await assertDirectionLoading('down');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Direction loading fits 320px ${theme}`);
    await page.screenshot({ path: join(evidenceDir, `direction-loading-320-${theme}.png`), fullPage: true });
  }
  await reducedMotionReply.complete(); await assertDirectionResult('down', { cached: true });
  assert.equal(await page.locator('#suggestion-panel .suggestion-bubble').evaluate((node) => getComputedStyle(node).animationName), 'none');
  directionFixtures.push(reducedMotionReply.suggestion);
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    await assertSelectedDirection('down');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Direction result fits 320px ${theme}`);
    const composer = await page.locator('#message-form').boundingBox();
    assert.ok(composer.y >= 0 && composer.y + composer.height <= 845, `Direction reply keeps the composer visible in ${theme}`);
    await page.screenshot({ path: join(evidenceDir, `direction-updated-320-${theme}.png`), fullPage: true });
    await page.locator('#coach-panel').screenshot({ path: join(evidenceDir, `direction-controls-320-${theme}.png`) });
  }
  await page.waitForFunction(() => !document.getElementById('suggestion-panel').classList.contains('reply-updated'));
  assert.equal(await page.locator('#suggestion-update').isVisible(), true, 'Reduced motion also clears the short highlight while keeping the status');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // A held B reply cannot update A, erase A's draft or show a fresh-switch status there.
  const crossObjectReply = await beginDirection('up', { reply: 'B 的晚回建议绝不能显示在 A。' });
  await page.locator('#counterpart-select').selectOption(id);
  await page.waitForFunction((id) => document.getElementById('counterpart-select').value === id && !document.getElementById('message-text').disabled, id);
  await page.locator('#message-text').fill('方向生成期间 A 的新草稿。');
  const otherDirectoryRefresh = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/counterparts' && r.request().method() === 'GET');
  await crossObjectReply.complete(); await otherDirectoryRefresh;
  assert.equal(await page.locator('#message-text').inputValue(), '方向生成期间 A 的新草稿。');
  assert.notEqual(await page.locator('#suggestion-text').inputValue(), crossObjectReply.suggestion.reply);
  assert.equal(await page.locator('#suggestion-loading').isVisible(), false);
  assert.equal(await page.locator('#suggestion-update').isVisible(), false);
  await page.locator('#counterpart-select').selectOption(secondId);
  await assertStaticDirection('down');
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  // A hidden draft is not evidence of having used a reply when a new other message arrives.
  const hiddenDraft = '尚未发送的隐藏旧草稿，不能被推定使用。';
  await page.locator('#suggestion-text').fill(hiddenDraft);
  const staleContextReply = await beginDirection('up', { reply: '旧消息上下文的晚回建议。' });
  staticDirectionFixtures = false;
  const feedbackBeforeBusyFollowup = server.betaStore.listFeedback(me.user.id).length;
  await page.locator('#message-speaker').selectOption('other');
  const busyFollowupText = '方向还在生成时收到的全新对方原话。';
  await page.locator('#message-text').fill(busyFollowupText);
  const busyFollowupRequest = page.waitForRequest((r) => r.url().endsWith(`/api/counterparts/${secondId}/followup`) && r.method() === 'POST');
  const busyFollowup = await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  const busyFollowupBody = (await busyFollowupRequest).postDataJSON();
  for (const key of ['previousSuggestionId', 'previousReplyText', 'previousCopyReceiptId']) assert.equal(busyFollowupBody[key], undefined, `Busy followup omits ${key}`);
  assert.equal(busyFollowup.previousMessage, null); assert.equal(busyFollowup.feedback, null);
  assert.equal(server.betaStore.listFeedback(me.user.id).length, feedbackBeforeBusyFollowup);
  await page.locator('.message-bubble').filter({ hasText: busyFollowupText }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  await page.locator('#message-text').fill('新上下文中的未提交草稿。');
  const sameObjectDirectoryRefresh = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/counterparts' && r.request().method() === 'GET');
  await staleContextReply.complete(); await sameObjectDirectoryRefresh;
  assert.equal(await page.locator('#message-text').inputValue(), '新上下文中的未提交草稿。');
  assert.notEqual(await page.locator('#suggestion-text').inputValue(), staleContextReply.suggestion.reply);
  assert.equal(await page.locator('#suggestion-loading').isVisible(), false);
  assert.equal(await page.locator('#suggestion-update').isVisible(), false);
  assert.equal(await page.locator('#suggestion-panel').evaluate((panel) => panel.classList.contains('reply-updated')), false);
  // The reverse race also needs a readback: a new-message GET was already in flight
  // when the old-context reply POST finally returned. Keep the new message visible.
  const beforeDelayedPost = await beginDirection('down');
  await beforeDelayedPost.complete(); await assertDirectionResult('down');
  await page.locator('#suggestion-text').fill('真实隔离回复返回前的隐藏草稿，不表示发送。');
  const delayedStoredReply = await beginDirection('down', { fromServer: true });
  const delayedReadback = { arrived: deferred(), release: deferred() };
  heldDirectionDetail = delayedReadback;
  const delayedMessageText = '已保存但读取仍在路上的全新对方消息。';
  await page.locator('#message-text').fill(delayedMessageText);
  const delayedFollowupRequest = page.waitForRequest((r) => r.url().endsWith(`/api/counterparts/${secondId}/followup`) && r.method() === 'POST');
  const delayedFollowup = await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  await delayedReadback.arrived.promise;
  const delayedFollowupBody = (await delayedFollowupRequest).postDataJSON();
  for (const key of ['previousSuggestionId', 'previousReplyText', 'previousCopyReceiptId']) assert.equal(delayedFollowupBody[key], undefined, `Held-readback followup omits ${key}`);
  assert.equal(delayedFollowup.previousMessage, null); assert.equal(delayedFollowup.feedback, null);
  const savedDuringHold = (await (await context.request.get(`${origin}/api/counterparts/${secondId}`)).json()).data;
  assert.equal(savedDuringHold.messages.at(-1).text, delayedMessageText, 'New message is durably saved while its UI readback is held');
  assert.ok(savedDuringHold.suggestions.some((item) => item.id === delayedStoredReply.suggestion.id), 'The completed old reply remains available as history');
  const delayedDirectoryRefresh = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/counterparts' && r.request().method() === 'GET');
  await delayedStoredReply.complete(); await delayedDirectoryRefresh;
  delayedReadback.release.resolve();
  await page.locator('.message-bubble').filter({ hasText: delayedMessageText }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  await page.screenshot({ path: join(evidenceDir, 'direction-held-readback-result.png'), fullPage: true });
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false, 'Old prepared reply never returns as pending after the new message readback');
  assert.equal(await page.locator('#suggestion-update').isVisible(), false);
  assert.equal(server.betaStore.listFeedback(me.user.id).length, feedbackBeforeBusyFollowup);
  await page.locator('#message-text').fill('术语开关验证保留的未提交聊天草稿。');
  const finalDirectionReply = await beginDirection('down');
  await finalDirectionReply.complete(); await assertDirectionResult('down');
  await page.waitForFunction(() => !document.getElementById('suggestion-panel').classList.contains('reply-updated'));
  async function assertReplyPaletteAndAlignment(theme) {
    const layout = await page.evaluate(() => {
      const coach = document.getElementById('coach-panel');
      const reply = document.querySelector('#suggestion-panel .suggestion-bubble');
      const self = document.querySelector('.message.self .message-bubble');
      const other = document.querySelector('.message.other .message-bubble');
      const colors = {};
      for (const name of ['coach', 'self', 'surface']) {
        const sample = document.createElement('span'); sample.style.backgroundColor = `var(--color-${name})`; document.body.append(sample);
        colors[name] = getComputedStyle(sample).backgroundColor; sample.remove();
      }
      const coachBox = coach.getBoundingClientRect(), replyBox = reply.getBoundingClientRect();
      return { coachWidth: coachBox.width, replyWidth: replyBox.width, coachRight: coachBox.right, replyRight: replyBox.right,
        coachColor: getComputedStyle(coach).backgroundColor, replyColor: getComputedStyle(reply).backgroundColor,
        selfColor: getComputedStyle(self).backgroundColor, otherColor: getComputedStyle(other).backgroundColor, colors };
    });
    assert.ok(Math.abs(layout.coachWidth - layout.replyWidth) < 1 && Math.abs(layout.coachRight - layout.replyRight) < 1, `${theme} AI card shares the reply width and right edge`);
    assert.equal(layout.coachColor, layout.colors.coach); assert.equal(layout.replyColor, layout.colors.self);
    assert.equal(layout.selfColor, layout.colors.self); assert.equal(layout.otherColor, layout.colors.surface);
    assert.notEqual(layout.coachColor, layout.replyColor, 'The AI card has a lighter, distinct green surface');
  }
  await page.setViewportSize({ width: 1280, height: 950 });
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    await assertReplyPaletteAndAlignment(theme);
    await page.screenshot({ path: join(evidenceDir, `direction-final-desktop-${theme}.png`), fullPage: true });
  }
  // Coach terms explain only on demand. Toggling them preserves both local drafts.
  const glossary = page.locator('#coach-glossary-toggle');
  assert.equal(await glossary.isChecked(), true, 'Term explanations default to enabled');
  assert.equal(await glossary.getAttribute('aria-controls'), 'coach-glossary-terms');
  assert.equal(await page.locator('#coach-glossary-terms > details').count(), 7);
  for (const term of await page.locator('#coach-glossary-terms > details').all()) {
    assert.equal(await term.getAttribute('open'), null, 'Terms default to collapsed explanations');
    assert.equal(await term.locator('p').first().isVisible(), false);
  }
  const strongCoachText = await page.evaluate(() => {
    const selectors = ['.coach-temperature-top > span', '#field-coach-temperature', '.coach-action-label'];
    return selectors.map((selector) => { const style = getComputedStyle(document.querySelector(selector)); return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight) }; });
  });
  assert.ok(strongCoachText[0].size >= 16 && strongCoachText[1].size >= 28 && strongCoachText[2].size >= 16);
  assert.ok(strongCoachText.every(({ weight }) => weight >= 600), 'Heat and action headings have clear visual emphasis');
  const glossaryPlan = '术语操作不得擦掉的场外计划。';
  await page.locator('#field-coach-plan').fill(glossaryPlan);
  const glossaryComposer = await page.locator('#message-text').inputValue();
  const beforeGlossary = { classifications, replies, plans, directionRequests: directionRequests.length };
  await page.setViewportSize({ width: 320, height: 844 });
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    await assertReplyPaletteAndAlignment(theme);
    if (!await page.locator('#field-coach').isVisible()) await page.locator('#toggle-field-coach').click();
    await glossary.focus(); await page.keyboard.press('Space');
    assert.equal(await glossary.isChecked(), false); assert.equal(await page.locator('#coach-glossary-terms').isVisible(), false);
    await page.keyboard.press('Space');
    assert.equal(await glossary.isChecked(), true); assert.equal(await page.locator('#coach-glossary-terms').isVisible(), true);
    const upSummary = page.locator('[data-coach-term=up] > summary');
    await upSummary.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-coach-term=up] p').isVisible(), true, 'Keyboard Enter opens a term explanation');
    await glossary.uncheck(); await glossary.check();
    assert.equal(await page.locator('[data-coach-term=up]').getAttribute('open'), '', 'Disabling explanations preserves expanded terms');
    await upSummary.click();
    for (const name of ['up', 'down', 'sideways', 'relationship', 'warming']) {
      const term = page.locator(`[data-coach-term=${name}]`);
      const summary = term.locator(':scope > summary');
      assert.ok((await summary.boundingBox()).height >= 44, 'Term summaries preserve touch targets');
      await summary.click(); assert.equal(await term.locator('p').first().isVisible(), true);
      await summary.click(); assert.equal(await term.locator('p').first().isVisible(), false);
    }
    assert.ok((await page.locator('.coach-glossary-toggle').boundingBox()).height >= 44);
    assert.equal(await page.locator('#message-text').inputValue(), glossaryComposer);
    assert.equal(await page.locator('#field-coach-plan').inputValue(), glossaryPlan);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Coach glossary fits 320px ${theme}`);
    await page.locator('.coach-glossary').screenshot({ path: join(evidenceDir, `coach-glossary-320-${theme}.png`) });
    await page.locator('[data-coach-term=warming] > summary').click();
    assert.equal(await page.locator('.coach-glossary').evaluate((node) => node.scrollWidth > node.clientWidth + 1), false, `Expanded glossary wraps in ${theme}`);
    await page.locator('[data-coach-term=warming]').screenshot({ path: join(evidenceDir, `coach-warming-320-${theme}.png`) });
    await page.locator('[data-coach-term=warming] > summary').click();
    await page.locator('#close-field-coach').click();
  }
  assert.deepEqual({ classifications, replies, plans, directionRequests: directionRequests.length }, beforeGlossary, 'Term explanations never call a model');
  assert.equal(replyQueue.length, 0);
  assert.equal(serverDirectionReplies, 1);
  assert.equal(replies, beforeDirectionChecks.replies + serverDirectionReplies, 'Only the held durable mock reply reaches the isolated provider');
  assert.equal(plans, beforeDirectionChecks.plans);
  assert.equal(classifications, beforeDirectionChecks.classifications + 2, 'Only the two isolated followups analyze their new contexts');
  await page.unroute('**/api/counterparts/*/reply');
  await page.unroute(`**/api/counterparts/${secondId}`);
  // A conversation switch, an unrelated read or a late save cannot destroy
  // unsubmitted wording. These are temporary real records, not response mocks.
  await page.setViewportSize({ width: 1280, height: 950 });
  async function selectConversation(targetId) {
    await response(`/api/counterparts/${targetId}`, 'GET', () => page.locator('#counterpart-select').selectOption(targetId));
    await page.waitForFunction(() => !document.getElementById('message-text').disabled);
  }
  await page.locator('#message-speaker').selectOption('self');
  await page.locator('#message-text').fill('B 的草稿，切换后仍需保留。');
  await selectConversation(id);
  await page.locator('#message-speaker').selectOption('other');
  await page.locator('#message-text').fill('A 的草稿，和 B 分开。');
  await selectConversation(secondId);
  assert.equal(await page.locator('#message-text').inputValue(), 'B 的草稿，切换后仍需保留。');
  assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
  if (!await page.locator('#job-history').getAttribute('open')) await page.locator('#job-history > summary').click();
  await response(`/api/counterparts/${secondId}`, 'GET', () => page.getByRole('button', { name: '刷新保存状态', exact: true }).click());
  assert.equal(await page.locator('#message-text').inputValue(), 'B 的草稿，切换后仍需保留。', 'Readback preserves the current draft');
  const editCard = page.locator('.message').filter({ has: page.locator('.message-menu') }).first();
  await editCard.locator('.message-menu > summary').click();
  await editCard.getByRole('button', { name: /^编辑/ }).click();
  await page.locator('#message-text').fill('尚未保存的历史消息修改。');
  await selectConversation(id);
  assert.equal(await page.locator('#message-text').inputValue(), 'A 的草稿，和 B 分开。');
  await selectConversation(secondId);
  assert.equal(await page.locator('#message-text').inputValue(), '尚未保存的历史消息修改。');
  assert.equal(await page.locator('#cancel-message-edit').isVisible(), true);
  await page.locator('#cancel-message-edit').click();
  assert.equal(await page.locator('#message-text').inputValue(), 'B 的草稿，切换后仍需保留。', 'Canceling an edit returns to the unfinished new-message draft');
  assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
  let releaseMessageSave;
  let messageSaved;
  const messageSavedPromise = new Promise((resolve) => { messageSaved = resolve; });
  const messageSaveGate = new Promise((resolve) => { releaseMessageSave = resolve; });
  const messageUrl = `**/api/counterparts/${secondId}/messages`;
  await page.route(messageUrl, async (route) => {
    const savedResponse = await route.fetch(); messageSaved();
    await messageSaveGate; await route.fulfill({ response: savedResponse });
  });
  await page.locator('#save-message').click(); await messageSavedPromise;
  await page.locator('#message-text').fill('保存期间接着写的下一句。');
  await response(`/api/counterparts/${secondId}`, 'GET', () => page.getByRole('button', { name: '刷新保存状态', exact: true }).click());
  assert.equal(await page.locator('#save-message').isDisabled(), true, 'Rendering a new detail keeps an in-flight submission locked');
  const savedMessageResponse = page.waitForResponse((r) => r.url().endsWith(`/api/counterparts/${secondId}/messages`) && r.request().method() === 'POST');
  releaseMessageSave(); await savedMessageResponse;
  await page.waitForFunction(() => !document.getElementById('save-message').disabled);
  assert.equal(await page.locator('#message-text').inputValue(), '保存期间接着写的下一句。', 'A late save clears only the submitted version');
  await page.unroute(messageUrl);
  const afterDraftSave = (await (await context.request.get(`${origin}/api/counterparts/${secondId}`)).json()).data;
  assert.equal(afterDraftSave.messages.filter((message) => message.text === 'B 的草稿，切换后仍需保留。').length, 1);
  assert.equal(afterDraftSave.messages.some((message) => message.text === '保存期间接着写的下一句。'), false, 'Later input was never submitted');
  await selectConversation(id); await selectConversation(secondId);
  assert.equal(await page.locator('#message-text').inputValue(), '保存期间接着写的下一句。');
  await page.route(messageUrl, (route) => route.abort('failed'));
  await page.locator('#save-message').click();
  await page.locator('#message-form .form-error').waitFor();
  assert.equal(await page.locator('#message-text').inputValue(), '保存期间接着写的下一句。', 'Network failure retains the draft');
  await page.unroute(messageUrl);
  await page.screenshot({ path: join(evidenceDir, 'composer-preserved-after-error.png'), fullPage: true });
  const beforeEmptyIntake = { classifications, replies, plans };
  await page.locator('#add-counterpart').click();
  await page.locator('#intake-alias').fill('背景草稿验收对象');
  await page.locator('#intake-channel').selectOption('offline');
  await page.locator('#intake-offline').fill('虚构跑步活动上互相认识，简单聊了路线。');
  await page.locator('#intake-background').fill('刚认识，只知道双方都喜欢跑步。');
  await page.locator('#close-counterpart-dialog').click();
  await page.locator('#add-counterpart').click();
  assert.equal(await page.locator('#intake-alias').inputValue(), '背景草稿验收对象');
  assert.equal(await page.locator('#intake-channel').inputValue(), 'offline');
  assert.equal(await page.locator('#intake-offline').inputValue(), '虚构跑步活动上互相认识，简单聊了路线。');
  assert.equal(await page.locator('#intake-background').inputValue(), '刚认识，只知道双方都喜欢跑步。');
  const emptyContact = await response('/api/counterparts', 'POST', () => page.locator('#counterpart-form button[type=submit]').click());
  const emptyId = emptyContact.counterpart.id;
  await page.waitForFunction((emptyId) => document.getElementById('counterpart-select').value === emptyId && !document.getElementById('message-text').disabled, emptyId);
  assert.equal(await page.locator('.message-bubble').count(), 0);
  assert.equal(await page.locator('#direct-reply').isDisabled(), true);
  assert.equal(await page.locator('#classify').isDisabled(), true);
  assert.equal(await page.locator('#field-coach-plan-submit').isDisabled(), true);
  assert.ok((await page.locator('#classification-summary').textContent()).includes('先在下方粘贴对方的一条消息'));
  assert.equal(await page.locator('#suggestion-panel').isVisible(), false);
  assert.deepEqual({ classifications, replies, plans }, beforeEmptyIntake, 'An empty conversation neither generates nor manufactures a failed attempt');
  await page.screenshot({ path: join(evidenceDir, 'empty-conversation-next-step.png'), fullPage: true });
  await page.locator('#add-counterpart').click();
  assert.equal(await page.locator('#intake-alias').inputValue(), '', 'A successful save clears only its submitted new-object draft');
  await page.locator('#intake-alias').fill('明确取消的草稿');
  await page.locator('#cancel-counterpart-dialog').click();
  await page.locator('#add-counterpart').click();
  assert.equal(await page.locator('#intake-alias').inputValue(), '', 'Cancel explicitly discards the current intake draft');
  await page.locator('#close-counterpart-dialog').click();
  const failedConversationPath = `**/api/counterparts/${secondId}`;
  await page.route(failedConversationPath, (route) => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '隔离的读取失败。' } } }));
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.locator('#retry-counterpart').waitFor();
  assert.equal(await page.locator('#message-text').isDisabled(), true);
  assert.equal(await page.locator('#counterpart-workspace').isVisible(), false);
  assert.ok((await page.locator('#counterpart-loading-message').textContent()).includes('未提交的草稿仍保留'));
  await page.screenshot({ path: join(evidenceDir, 'conversation-retry.png'), fullPage: true });
  await page.locator('#retry-counterpart').click();
  await page.waitForFunction(() => !document.getElementById('retry-counterpart').hidden && !document.getElementById('retry-counterpart').disabled);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'retry-counterpart', 'A second failure keeps the retry reachable by keyboard');
  await page.unroute(failedConversationPath);
  await response(`/api/counterparts/${secondId}`, 'GET', () => page.locator('#retry-counterpart').click());
  await page.waitForFunction(() => !document.getElementById('message-text').disabled);
  assert.equal(await page.locator('#counterpart-loading').isVisible(), false);
  assert.equal(await page.locator('#message-text').inputValue(), '保存期间接着写的下一句。');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-text', 'Retry returns focus to the restored composer');
  await selectConversation(emptyId);
  let releaseLateFailure, startLateRead, holdLateFailure = false;
  const lateReadStarted = new Promise((resolve) => { startLateRead = resolve; });
  const lateFailureGate = new Promise((resolve) => { releaseLateFailure = resolve; });
  await page.route(failedConversationPath, async (route) => {
    if (holdLateFailure) { startLateRead(); await lateFailureGate; }
    await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '旧对象的迟到错误不能出现在新对象。' } } });
  });
  await page.locator('#counterpart-select').selectOption(secondId);
  await page.locator('#retry-counterpart').waitFor();
  holdLateFailure = true;
  await page.locator('#retry-counterpart').click(); await lateReadStarted;
  await selectConversation(emptyId);
  releaseLateFailure();
  await page.waitForFunction(() => !document.getElementById('retry-counterpart').disabled);
  assert.equal(await page.locator('#counterpart-select').inputValue(), emptyId);
  assert.equal(await page.locator('#counterpart-loading').isVisible(), false);
  assert.equal(await page.locator('#notice').isVisible(), false, 'A delayed failure cannot report against a different conversation');
  await page.unroute(failedConversationPath);
  await selectConversation(secondId);
  if (!await page.locator('#copy-reply').isVisible()) {
    if (!await page.locator('#suggestion-history').getAttribute('open')) await page.locator('#suggestion-history > summary').click();
    await page.locator('#suggestion-list .history-button').first().click();
  }
  await page.locator('#copy-reply').click();
  await page.locator('#notice').filter({ hasText: '已复制' }).waitFor();
  await page.waitForFunction(() => !document.getElementById('copy-reply').disabled);
  const visibleFeedback = await page.evaluate(() => {
    const notice = document.getElementById('notice').getBoundingClientRect();
    const toolbar = document.querySelector('.chat-toolbar').getBoundingClientRect();
    return { fullyVisible: notice.top >= toolbar.bottom - 1 && notice.bottom <= innerHeight, toolbarVisible: toolbar.top >= 0, shellScroll: document.getElementById('workspace').scrollTop };
  });
  assert.deepEqual(visibleFeedback, { fullyVisible: true, toolbarVisible: true, shellScroll: 0 }, 'Copy feedback and toolbar stay in view after nested scrolling');
  await page.screenshot({ path: join(evidenceDir, 'copy-feedback-visible.png'), fullPage: true });
  await page.locator('#add-counterpart').click();
  await page.locator('#intake-alias').fill('异步保存对象 A');
  await page.locator('#intake-channel').selectOption('other');
  await page.locator('#intake-background').fill('合成背景 A，正在保存。');
  let releaseIntakeSave, intakeSaved;
  const intakeSavedPromise = new Promise((resolve) => { intakeSaved = resolve; });
  const intakeSaveGate = new Promise((resolve) => { releaseIntakeSave = resolve; });
  await page.route('**/api/counterparts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const savedResponse = await route.fetch(); intakeSaved();
    await intakeSaveGate; await route.fulfill({ response: savedResponse });
  });
  const savedIntakeResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/counterparts' && r.request().method() === 'POST');
  await page.locator('#counterpart-form button[type=submit]').click(); await intakeSavedPromise;
  await page.locator('#close-counterpart-dialog').click();
  await page.locator('#add-counterpart').click();
  await page.locator('#intake-alias').fill('另外新建的对象 B');
  await page.locator('#intake-background').fill('合成背景 B，属于重新打开的新表单。');
  releaseIntakeSave(); const savedA = (await (await savedIntakeResponse).json()).data.counterpart;
  await page.waitForFunction(() => !document.querySelector('#counterpart-form button[type=submit]').disabled);
  assert.equal(await page.locator('#counterpart-dialog-title').textContent(), '添加聊天对象');
  assert.equal(await page.locator('#intake-alias').inputValue(), '另外新建的对象 B');
  assert.equal(await page.locator('#counterpart-select').inputValue(), secondId, 'A late save never changes the active conversation for a reopened intake');
  await page.unroute('**/api/counterparts');
  const savedB = (await response('/api/counterparts', 'POST', () => page.locator('#counterpart-form button[type=submit]').click())).counterpart;
  assert.notEqual(savedA.id, savedB.id, 'The reopened intake creates B instead of overwriting A');
  const readA = (await (await context.request.get(`${origin}/api/counterparts/${savedA.id}`)).json()).data.counterpart;
  assert.equal(readA.alias, '异步保存对象 A');
  assert.deepEqual(pageErrors, []);
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ passed: true, synthetic: true, actualProviderCalls: 0, browser: browser.version(), classifications, replies, plans, directionReplyFixtures: directionRequests.length, directionSavedMockReplies: serverDirectionReplies, checks: ['per-conversation unsent drafts and edit cancellation', 'late saves preserve newer input with submit locking', 'readback and network failure preserve unsubmitted wording', 'intake collapse retains drafts and explicit cancel clears them', 'empty conversation gives next step without model calls', 'direct entry', 'fictional label', 'opposite speaker sides', 'inline AI directions', 'lower-weight choice', 'editable pending reply', 'day/night and draft preservation', 'unknown-network followup replay with stable receipt', 'followup inferred receipt and raw isolation', 'clipboard-to-recording timing estimate', 'minute-first time editing with collapsed arbitrary date, retained failed save, explicit clearing and preserved provenance/composer draft', '390/320px layout and docked composer', 'theme and classification reuse after reload', 'cross-object pending request isolation', 'failed analysis durable no-auto-retry', 'keyboard menu/card focus', 'startup and expired-session failure recovery', 'field coach topic and explicit plan outside WeChat messages', 'mobile coach focus and per-object plan draft', 'manual self overrides old pending and feedback source', 'historical copy eligibility and separate receipt reuse', 'solid direction selection with visible check', 'held direction generation hides previous draft and metadata and disables copy and history', 'returned direction and identical-text cache switch announcement', 'short reply highlight with persistent status and reduced-motion rendering', 'failed direction restores selection and per-suggestion edited draft', 'history and reload use static direction markers', '320px day and night direction loading and results', 'late reply isolation after object switch and new followup context', 'busy hidden draft never supplies inferred followup evidence', 'copy stays locked and delayed copy GET cannot roll back a new direction', 'durable mock reply POST before new message GET rereads and preserves current context', 'green AI and self surfaces with matched right alignment', 'prominent field coach heat and action labels', 'default enabled glossary with seven collapsed terms and keyboard toggle', 'on-demand term explanations preserve composer and plan drafts without model calls', '320px day and night glossary touch targets and wrapping'], pageErrors }, null, 2) + '\n');
  console.log('Direct single-chat demo journey passed: retained original journeys, direction loading/success/failure/cache/history, late-result/copy/readback and followup isolation, reduced motion, glossary keyboard/drafts, 320px day/night. Zero paid calls.');
} finally {
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  await rm(directory, { recursive: true, force: true });
}
