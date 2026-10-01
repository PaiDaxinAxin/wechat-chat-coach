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
  let releaseClassification, releasePlan, holdPlan;
  // The expanded mock journey exceeds ten operations; production budget defaults stay unchanged.
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, localDemoMode: true, paidProviderDailyLimit: 20,
    classifyFn: async (context, options) => {
      classifications++; assert.equal(options.knowledgeText, knowledge);
      if (nextFailure) { nextFailure = false; throw Object.assign(new Error('Synthetic classification timeout'), { code: 'PROVIDER_TIMEOUT' }); }
      if (holdClassification) { const held = holdClassification; holdClassification = null; await held; }
      const id = context.messages.at(-1).id;
      const observed = { level: 'positive', evidenceIds: [...new Set([context.messages.find((message) => message.speaker === 'other')?.id || id, id])] };
      return { status: 'ready', confidence: 'moderate', phase: 'ordinary',
        obstacle: { type: 'none', evidenceIds: [], reason: '她主动延续工作话题。' },
        heat: { activeInteraction: observed, responseEngagement: observed, personalInterest: observed, reciprocalFlirting: { level: 'unknown', evidenceIds: [] }, actionFollowThrough: { level: 'unknown', evidenceIds: [] } },
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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
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
  assert.equal(computeHeat(coachScenario).score, 100);
  assert.equal(computeHeat(coachScenario).status, 'insufficient_evidence');
  await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '待判断', 'A 100 index from one message cannot become a temperature');
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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
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
  const followupText = '这个项目主要做品牌升级。';
  await page.locator('#message-text').fill(followupText);
  const followup = await response(`/api/counterparts/${id}/followup`, 'POST', () => page.locator('#save-message').click());
  assert.equal(followup.previousMessage.provenance, 'inferred_from_followup');
  assert.equal(followup.previousMessage.text, edited);
  assert.equal(followup.feedback.stage, 'raw_untrusted');
  assert.equal(followup.timing.fromSource, 'clipboard_copied');
  await page.locator('.message-bubble').filter({ hasText: followupText }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
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
  await response(`/api/counterparts/${secondId}/classify`, 'POST', () => page.locator('#classify').click());
  assert.equal(classifications, 6, 'Explicit reanalysis is allowed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-field-coach').click();
  assert.equal(await page.locator('#field-coach').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'field-coach-plan');
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
  const reported = new Date(Date.now() - 3600000);
  const reportedLocal = new Date(reported.getTime() - reported.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await messageCard.locator('input[type=datetime-local]').fill(reportedLocal);
  const timingChange = await response(`/api/counterparts/${secondId}/messages/${beforeTiming.id}/timing`, 'PATCH', () => messageCard.getByRole('button', { name: '保存时间' }).click());
  assert.equal(timingChange.message.recordedAt, beforeTiming.recordedAt);
  assert.equal(timingChange.message.wechatTime.source, 'user_reported');
  await messageCard.locator('.message-label').filter({ hasText: '标注' }).waitFor();
  assert.equal(await page.locator('#message-text').inputValue(), '重要的未提交编辑草稿，修改时间不得擦掉。');
  assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
  assert.equal(await page.locator('#cancel-message-edit').isVisible(), true);
  assert.equal(await page.locator('#save-message').textContent(), '保存修改');
  await messageCard.locator('.message-label').filter({ hasText: '标注' }).waitFor();
  assert.ok(!(await messageCard.locator('.message-label').textContent()).includes('录入'), 'Primary time uses the explicit annotation');
  assert.ok((await messageCard.locator('.message-label').getAttribute('title')).includes(beforeTiming.recordedAt));
  assert.equal(classifications, 6, 'Changing metadata does not silently call the model');
  assert.equal(await page.locator('#field-coach-temperature').textContent(), '待判断', 'Correcting time invalidates the previous displayed temperature');
  await response(`/api/counterparts/${secondId}/classify`, 'POST', () => page.locator('#classify').click());
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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  await viewHistoricalA();
  const secondRecopy = await response(`/api/counterparts/${secondId}/suggestions/${suggestedA.id}/copied`, 'POST', () => page.locator('#copy-reply').click());
  assert.notEqual(secondRecopy.copyReceipt.id, firstRecopy.copyReceipt.id);
  await page.locator('#suggestion-title').filter({ hasText: '我 · AI 建议' }).waitFor();
  await page.locator('#message-text').fill('同一历史建议另一次新复制后的回应二。');
  const secondRecopyFollowup = await response(`/api/counterparts/${secondId}/followup`, 'POST', () => page.locator('#save-message').click());
  assert.equal(secondRecopyFollowup.previousMessage.suggestionId, suggestedA.id);
  assert.notEqual(secondRecopyFollowup.feedback.id, recopyFollowup.feedback.id, 'A different fresh copy can support another unverified followup');
  await page.locator('.message-bubble').filter({ hasText: '同一历史建议另一次新复制后的回应二。' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
  assert.deepEqual(pageErrors, []);
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ passed: true, synthetic: true, actualProviderCalls: 0, browser: browser.version(), classifications, replies, plans, checks: ['direct entry', 'fictional label', 'opposite speaker sides', 'inline AI directions', 'lower-weight choice', 'editable pending reply', 'day/night and draft preservation', 'unknown-network followup replay with stable receipt', 'followup inferred receipt and raw isolation', 'clipboard-to-recording timing estimate', 'user-reported time override with preserved recording time and composer edit draft', '390/320px layout and docked composer', 'theme and classification reuse after reload', 'cross-object pending request isolation', 'failed analysis durable no-auto-retry', 'keyboard menu/card focus', 'startup and expired-session failure recovery', 'field coach topic and explicit plan outside WeChat messages', 'mobile coach focus and per-object plan draft', 'manual self overrides old pending and feedback source', 'historical copy eligibility and separate receipt reuse'], pageErrors }, null, 2) + '\n');
  console.log('Direct single-chat demo journey passed: compact coach heat/actions/pitfalls, refusal and uncertainty overrides, day/night, inferred followup, retained drafts, mobile and reload. Zero paid calls.');
} finally {
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  await rm(directory, { recursive: true, force: true });
}
