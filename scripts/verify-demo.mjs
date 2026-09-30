import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

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
  let classifications = 0, replies = 0;
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, localDemoMode: true,
    classifyFn: async (context, options) => {
      classifications++; assert.equal(options.knowledgeText, knowledge);
      const id = context.messages.at(-1).id;
      const observed = { level: 'positive', evidenceIds: [id] };
      return { status: 'ready', confidence: 'moderate', phase: 'ordinary',
        obstacle: { type: 'none', evidenceIds: [], reason: '她主动延续工作话题。' },
        heat: { activeInteraction: observed, responseEngagement: observed, personalInterest: observed, reciprocalFlirting: { level: 'unknown', evidenceIds: [] }, actionFollowThrough: { level: 'unknown', evidenceIds: [] } },
        options: [['up', .6], ['down', .1], ['sideways', .3]].map(([topicMove, weight]) => ({ topicMove, weight, relationAction: 'continue', reason: '依据当前的工作话题继续了解。', evidenceIds: [id] })),
        uncertainties: ['对方是否愿意见面尚不清楚。'], recommendationKind: 'uncalibrated' };
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
  assert.equal(classifications + replies, 0, 'Loading does not call the model');
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
  const originalText = '我刚好也参与了一个品牌项目。';
  await page.locator('#message-text').fill(originalText);
  await response(`/api/counterparts/${id}/messages`, 'POST', () => page.locator('#save-message').click());
  await page.locator('.message-bubble').filter({ hasText: originalText }).waitFor();
  assert.equal(classifications + replies, 0, 'Recording a message never starts an automatic paid call');
  await response(`/api/counterparts/${id}/classify`, 'POST', () => page.locator('#classify').click());
  await page.locator('[data-direction=down]').click();
  await response(`/api/counterparts/${id}/reply`, 'POST', () => page.locator('#chosen-reply').click());
  await page.locator('#suggestion-panel').waitFor({ state: 'visible' });
  const edited = '我做产品设计。你那个项目主要是在做什么？';
  await page.locator('#suggestion-text').fill(edited);
  await page.locator('#message-text').fill('尚未提交的示例草稿');
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
  assert.equal(await page.locator('#suggestion-text').inputValue(), edited);
  assert.equal(await page.locator('#message-text').inputValue(), '尚未提交的示例草稿');
  assert.equal(classifications + replies, 2);
  await page.screenshot({ path: join(evidenceDir, 'night.png'), fullPage: true });
  await response(`/api/counterparts/${id}/sent`, 'POST', () => page.locator('#record-sent').click());
  await page.locator('#sent-state').filter({ hasText: '已记录' }).waitFor();
  await page.locator('#reply-feedback').click();
  await page.locator('#feedback-observation').fill('虚构验收记录，不能用于真实效果结论。');
  await page.locator('#feedback-reply').fill('这个项目主要做品牌升级。');
  await page.locator('#feedback-consent').check();
  await response(`/api/counterparts/${id}/feedback`, 'POST', () => page.locator('#feedback-form button[type=submit]').click());
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
  assert.equal(await page.locator('#record-sent').isDisabled(), true);
  assert.equal(classifications, 1); assert.equal(replies, 1); assert.deepEqual(pageErrors, []);
  const failPage = await context.newPage();
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
  await failPage.route('**/messages', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_FORBIDDEN', message: '合成保存故障。' } }) }));
  await failPage.locator('#message-text').fill('合成故障检查，不写入任何记录。');
  await failPage.locator('#save-message').click();
  await failPage.locator('#message-form .form-error').waitFor({ state: 'visible' });
  await failPage.unroute('**/messages');
  await failPage.route('**/classify', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: '合成会话结束。' } }) }));
  await failPage.locator('#classify').click();
  await failPage.locator('#startup-retry').waitFor({ state: 'visible' });
  assert.equal(await failPage.locator('#auth').isVisible(), false);
  assert.equal(await failPage.locator('#auth-status').count(), 1, 'Session cleanup preserves permanent status nodes');
  assert.equal(await failPage.locator('#startup-message').count(), 1);
  await failPage.unroute('**/classify');
  await failPage.locator('#startup-retry').click();
  await failPage.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await failPage.close();
  assert.equal(classifications, 1); assert.equal(replies, 1); assert.deepEqual(pageErrors, []);
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ passed: true, synthetic: true, actualProviderCalls: 0, browser: browser.version(), classifications, replies, checks: ['direct entry', 'fictional label', 'opposite speaker sides', 'inline AI directions', 'lower-weight choice', 'editable pending reply', 'day/night and draft preservation', 'explicit manual sent receipt', 'raw feedback isolation', '390/320px layout and docked composer', 'theme and sent state after reload', 'keyboard menu/card focus', 'startup and expired-session failure recovery'], pageErrors }, null, 2) + '\n');
  console.log('Direct single-chat demo journey passed: day/night, inline advice, editable reply, manual receipt, raw feedback, mobile and reload. Zero paid calls.');
} finally {
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  await rm(directory, { recursive: true, force: true });
}
