import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Fictional records, a temporary database/knowledge copy and injected providers.
// Clipboard is a browser-only fake; no operator data or paid models are touched.
process.umask(0o077);
const temporary = await mkdtemp(join(tmpdir(), 'coach-ux-feedback-'));
const evidenceDir = join(process.cwd(), 'runs/ux-feedback');
const report = { passed: false, synthetic: true, actualProviderCalls: 0, cases: [], pageErrors: [], externalRequests: [], modelCalls: { reply: 0, classify: 0 } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let server, browser;
try {
  await mkdir(evidenceDir, { recursive: true });
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8'), knowledgePath = join(temporary, 'knowledge.md');
  await writeFile(knowledgePath, knowledgeText);
  const webDir = join(temporary, 'public'); await mkdir(webDir);
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  server = await createBetaServer({ dataDir: join(temporary, 'data'), knowledgePath, webDir, providerEnv: {}, localDemoMode: true, paidProviderDailyLimit: 40,
    classifyFn: async () => { report.modelCalls.classify++; throw new Error('These explicit reply/readback journeys do not request classification'); },
    replyFn: async ({ context }, options) => {
      assert.equal(options.knowledgeText, knowledgeText); report.modelCalls.reply++;
      return { reply: `我做产品设计，最近刚忙完一个项目。你这个新项目最有意思的是哪部分？（${report.modelCalls.reply}）`, action: 'reply',
        reason: '先回答她的问题，再接住她主动说的项目，给双方一个自然展开的入口。', styleNote: '简短自然，保留自己的表达习惯。',
        workingFocus: { stage: 'value_display', reason: '通过真实的工作经历，建立更具体的了解。', evidenceIds: [context.messages.at(-1).id] },
        guidance: { topicMove: null, relationMove: 'continue', ownWordsGuide: '如果想自己回，就先用一句说清你的工作，再挑她刚说的一处细节继续聊。不用一次问太多问题，也不用把完整经历都写出来。', reentryWhen: '她愿意展开时再顺着接话；如果只是简单回应，可以自然收住，等你们有真实的新话题时再聊。' },
        contextUpdates: { facts: [], meeting: null } };
    },
    planFn: async () => { throw new Error('No plans requested'); }, imageFn: async () => { throw new Error('No image inference requested'); },
  });
  const seed = await server.ensureDemoSeed();
  const other = server.betaStore.putCounterpart(seed.user.id, { alias: '林微', remark: '虚构验收', channel: 'other', background: '虚构联系人。', appProfile: '', offlineScene: '', rounds: 1 });
  server.betaStore.putMessage(seed.user.id, other.id, { speaker: 'other', text: '我周末喜欢拍照，你呢？' });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  async function makePage(viewport) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      window.fixtureClipboard = { text: null, hold: false, fail: false, release: null };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
        const fixture = window.fixtureClipboard;
        if (fixture.hold) await new Promise((resolve) => { fixture.release = resolve; });
        if (fixture.fail) { fixture.rejected = (fixture.rejected || 0) + 1; throw new Error('Synthetic clipboard permission failure'); }
        fixture.text = text;
      } } });
    });
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      report.externalRequests.push(new URL(route.request().url()).origin); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.goto(origin); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
    return { page, context };
  }
  async function perform(page, suffix, action) {
    const pending = page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === 'POST');
    await action(); const response = await pending, payload = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(payload)); return payload.data;
  }
  async function idle(page) {
    await page.waitForFunction(() => document.getElementById('suggestion-panel').getAttribute('aria-busy') === 'false' && !document.getElementById('direct-reply').disabled);
  }
  async function reply(page, intent = '') {
    if (intent) { await page.locator('#intent').evaluate((node) => { node.closest('details').open = true; }); await page.locator('#intent').fill(intent); }
    const data = await perform(page, '/reply', () => page.locator('#direct-reply').click());
    await idle(page); await page.waitForFunction((text) => document.getElementById('suggestion-text').value === text, data.suggestion.reply);
    // Allow the application's requested scroll and its layout to settle, without
    // scrolling the target ourselves (Playwright click would otherwise mask it).
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return data.suggestion;
  }
  async function visibleReply(page, label) {
    const measured = await page.evaluate(() => {
      const thread = document.getElementById('chat-thread').getBoundingClientRect();
      const editor = document.getElementById('suggestion-text').getBoundingClientRect();
      const button = document.getElementById('copy-reply'), copy = button.getBoundingClientRect();
      const style = getComputedStyle(button), textStyle = getComputedStyle(document.getElementById('suggestion-text'));
      const top = Math.max(thread.top, 0), bottom = Math.min(thread.bottom, innerHeight);
      return { firstLine: editor.top >= top - 1 && editor.top + parseFloat(textStyle.lineHeight) <= bottom + 1,
        copyVisible: copy.top >= top - 1 && copy.bottom <= bottom + 1 && copy.left >= 0 && copy.right <= innerWidth + 1,
        copyBorder: parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none' && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.borderTopColor),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        thread: { top, bottom }, editorTop: editor.top, copy: { top: copy.top, bottom: copy.bottom } };
    });
    assert.equal(measured.firstLine, true, `${label}: reply begins inside the visible conversation: ${JSON.stringify(measured)}`);
    assert.equal(measured.copyVisible, true, `${label}: copy stays visible with the reply: ${JSON.stringify(measured)}`);
    assert.equal(measured.copyBorder, true, `${label}: the copy action has a persistent visible boundary`);
    assert.equal(measured.overflow, false, `${label}: no horizontal page overflow`);
  }
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const { page, context } = await makePage(viewport);
    await reply(page, `合成视口 ${viewport.width}`);
    await visibleReply(page, `${viewport.width}x${viewport.height}`);
    assert.equal(await page.locator('.suggestion-heading #copy-reply').count(), 1, 'The action sits with the reply heading');
    assert.equal(await page.locator('#copy-reply').textContent(), '复制回复');
    await page.screenshot({ path: join(evidenceDir, `reply-${viewport.width}.png`) });
    const contact = await page.locator('#counterpart-select').inputValue(), replyCalls = report.modelCalls.reply;
    await page.reload();
    await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await visibleReply(page, `${viewport.width}x${viewport.height} after reload`);
    await page.locator('#counterpart-select').selectOption(other.id);
    await page.waitForFunction((value) => document.querySelector('.message-bubble')?.textContent === value, '我周末喜欢拍照，你呢？');
    await page.locator('#counterpart-select').selectOption(contact);
    await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await visibleReply(page, `${viewport.width}x${viewport.height} after switching back`);
    assert.equal(report.modelCalls.reply, replyCalls, 'Restoring saved advice never generates another reply');
    report.cases.push(`Reply beginning and copy action visible on generate/reload/switch at ${viewport.width}x${viewport.height}`);
    await context.close();
  }

  const { page, context } = await makePage({ width: 1280, height: 720 });
  await page.clock.install();
  await reply(page, '改写与复制反馈');
  const id = await page.locator('#counterpart-select').inputValue();
  const edited = '我做产品设计，你最近的项目是什么方向？';
  await page.locator('#suggestion-text').fill(edited);
  await page.locator('#message-text').fill('暂时没有提交的对方消息草稿');
  const beforeCopy = report.modelCalls.reply;
  const copyRequest = page.waitForRequest((request) => request.url().endsWith('/copied'));
  const receipt = await perform(page, '/copied', () => page.locator('#copy-reply').click());
  await page.waitForFunction(() => document.getElementById('copy-reply').textContent === '已复制');
  assert.equal(await page.evaluate(() => window.fixtureClipboard.text), edited);
  assert.equal((await copyRequest).postDataJSON().copiedText, edited);
  assert.ok(receipt.copyReceipt.id);
  assert.equal(await page.locator('#message-text').inputValue(), '暂时没有提交的对方消息草稿');
  assert.equal(await page.locator('#notice').isVisible(), false, 'Copy success is local, not a persistent full-width notice');
  assert.equal(report.modelCalls.reply, beforeCopy, 'Copying never invokes a model');
  await page.clock.fastForward(6000);
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复', 'Success feedback expires');
  await perform(page, '/copied', () => page.locator('#copy-reply').click());
  await page.waitForFunction(() => document.getElementById('copy-reply').textContent === '已复制');
  await page.locator('#suggestion-text').fill('这是刚修改的新版本。');
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复', 'Editing does not inherit a prior successful copy');
  await perform(page, '/copied', () => page.locator('#copy-reply').click());
  await page.waitForFunction(() => document.getElementById('copy-reply').textContent === '已复制');
  await reply(page, '生成一个新的建议版本');
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复', 'A new suggestion does not inherit copied feedback');
  report.cases.push('Edited text copied, drafts preserved, no model side effect, feedback expires or clears on edit/new reply');

  // Clipboard resolution may arrive after the user edits the text.
  await page.evaluate(() => { window.fixtureClipboard.hold = true; });
  await page.locator('#copy-reply').click();
  await page.waitForFunction(() => typeof window.fixtureClipboard.release === 'function');
  await page.locator('#suggestion-text').fill('复制进行时又改了一个版本。');
  const delayedCopy = page.waitForResponse((r) => r.url().endsWith('/copied'));
  await page.evaluate(() => { window.fixtureClipboard.hold = false; window.fixtureClipboard.release(); });
  assert.equal((await delayedCopy).status(), 200);
  await page.waitForFunction(() => !document.getElementById('copy-reply').disabled);
  assert.equal(await page.locator('#suggestion-text').inputValue(), '复制进行时又改了一个版本。');
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复', 'A delayed copy cannot mark the newer edited text as copied');

  let rejectedCopyPosts = 0;
  const countCopy = (request) => { if (request.url().endsWith('/copied')) rejectedCopyPosts++; };
  page.on('request', countCopy);
  await page.evaluate(() => { window.fixtureClipboard.fail = true; });
  await page.locator('#copy-reply').click();
  await page.locator('#notice.error').filter({ hasText: '浏览器未允许复制' }).waitFor();
  await page.waitForFunction(() => !document.getElementById('copy-reply').disabled);
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复');
  assert.equal(rejectedCopyPosts, 0, 'A rejected clipboard write never stores a copy receipt');
  page.off('request', countCopy);
  await page.evaluate(() => { window.fixtureClipboard.fail = false; });
  report.cases.push('Clipboard rejection remains actionable without a false success or copy receipt');

  // A response saved for A must not affect B, or return feedback to a later visit.
  const copyGate = deferred(), copyStarted = deferred();
  const heldCopy = async (route) => { const response = await route.fetch(); copyStarted.resolve(); await copyGate.promise; await route.fulfill({ response }); };
  await page.route('**/suggestions/*/copied', heldCopy);
  const oldCopy = page.waitForResponse((r) => r.url().endsWith('/copied'));
  await page.locator('#copy-reply').click(); await copyStarted.promise;
  await page.locator('#counterpart-select').selectOption(other.id);
  await page.waitForFunction((value) => document.querySelector('.message-bubble')?.textContent === value, '我周末喜欢拍照，你呢？');
  await reply(page, '对象 B 的独立建议');
  const bDraft = await page.locator('#suggestion-text').inputValue();
  copyGate.resolve(); assert.equal((await oldCopy).status(), 200);
  await page.unroute('**/suggestions/*/copied', heldCopy);
  assert.equal(await page.locator('#suggestion-text').inputValue(), bDraft);
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复');
  assert.equal(await page.locator('#notice').isVisible(), false);
  await page.locator('#counterpart-select').selectOption(id);
  await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复', 'A new visit never inherits old copy feedback');
  report.cases.push('Delayed clipboard/edit and cross-conversation receipt results remain isolated');

  const rejectedBefore = await page.evaluate(() => window.fixtureClipboard.rejected || 0);
  await page.evaluate(() => { window.fixtureClipboard.hold = true; window.fixtureClipboard.fail = true; window.fixtureClipboard.release = null; });
  await page.locator('#copy-reply').click();
  await page.waitForFunction(() => typeof window.fixtureClipboard.release === 'function');
  await page.locator('#counterpart-select').selectOption(other.id);
  await page.waitForFunction((value) => document.querySelector('.message-bubble')?.textContent === value, '我周末喜欢拍照，你呢？');
  await page.evaluate(() => { window.fixtureClipboard.hold = false; window.fixtureClipboard.release(); });
  await page.waitForFunction((before) => window.fixtureClipboard.rejected === before + 1, rejectedBefore);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#notice').isVisible(), false, 'A delayed clipboard rejection from A cannot report against B');
  assert.equal(await page.locator('#copy-reply').textContent(), '复制回复');
  await page.evaluate(() => { window.fixtureClipboard.fail = false; });
  await page.locator('#counterpart-select').selectOption(id);
  await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
  report.cases.push('Delayed clipboard denial does not leak an error into another conversation');

  // A normal save produces success; its timer must not erase a later failure.
  async function saveAnnotation(text) {
    const annotation = page.locator('.message-annotation').first();
    await annotation.evaluate((node) => { node.open = true; });
    await annotation.locator('textarea').fill(text);
    const response = page.waitForResponse((r) => r.url().endsWith('/annotation') && r.request().method() === 'PATCH');
    await annotation.locator('button[type=submit]').click(); assert.equal((await response).status(), 200);
    await page.locator('#notice.success').filter({ hasText: '背景批注已保存' }).waitFor();
  }
  await saveAnnotation('虚构批注：这是我们线下提过的小事。');
  await page.clock.fastForward(5100);
  assert.equal(await page.locator('#notice').isVisible(), false, 'Ordinary success automatically disappears');
  await saveAnnotation('虚构批注：这是另一条线下背景。');
  await page.locator('#message-image-file').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic non-image') });
  await page.locator('#notice.error').filter({ hasText: '请选择小于' }).waitFor();
  await page.clock.fastForward(6000);
  assert.equal(await page.locator('#notice.error').isVisible(), true, 'The previous success timer cannot erase a newer error');
  report.cases.push('Success clears after five seconds while newer errors remain');
  await context.close();

  const progressContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const gate = deferred(), started = deferred();
  await progressContext.route(`${origin}/api/demo/session`, async (route) => { started.resolve(); await gate.promise; await route.continue(); });
  const progressPage = await progressContext.newPage();
  await progressPage.clock.install();
  await progressPage.goto(origin); await started.promise;
  assert.match(await progressPage.locator('#notice.progress').textContent(), /正在打开/);
  await progressPage.clock.fastForward(6000);
  assert.match(await progressPage.locator('#notice.progress').textContent(), /正在打开/, 'Active progress does not expire like a success notice');
  gate.resolve(); await progressPage.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await progressContext.close();
  report.cases.push('Active loading notice is not automatically expired');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  assert.equal(report.modelCalls.classify, 0, 'No incidental classifications during reading, copying or annotations');
  report.passed = true;
} finally {
  await writeFile(join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  await browser?.close();
  if (server) { await new Promise((resolve) => server.close(resolve)); await server.storeClosed; }
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
