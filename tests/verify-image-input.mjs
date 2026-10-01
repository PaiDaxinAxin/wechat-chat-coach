import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5p8AAAAASUVORK5CYII=', 'base64');
const output = { description: '一只猫的表情，文字不能确认。', kind: 'sticker', uncertainty: '不能直接判断是调侃还是拒绝。' };
const directory = await mkdtemp(join(tmpdir(), 'coach-image-browser-'));
let server, browser, hold = false, release, entered, started;
let reads = 0; const inputs = [], errors = [];
let imageOutput = output;
const report = { firstImage: false, sources: false, emoji: false, paste: false, lateTyping: false, lateObject: false, editing: false, screenshotNoInferredSelf: false, smallScreens: [], paidCalls: 0 };
try {
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md'); await writeFile(knowledgePath, knowledgeText);
  const webDir = join(directory, 'public'); await mkdir(webDir);
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, webDir, localDemoMode: true, paidProviderDailyLimit: 100,
    imageFn: async (input, options) => { reads++; inputs.push(input); assert.equal(options.knowledgeText, knowledgeText); if (hold) { entered(); await new Promise((resolve) => { release = resolve; }); } return imageOutput; },
    classifyFn: async (context) => { const ids = context.messages.filter(({ speaker }) => speaker === 'other').map(({ id }) => id).slice(-1); return { status: 'ready', confidence: 'limited', phase: 'ordinary', obstacle: { type: 'none', evidenceIds: [], reason: 'Synthetic.' }, heat: Object.fromEntries(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'].map((name) => [name, { level: 'unknown', evidenceIds: [] }])), options: ['up', 'down', 'sideways'].map((topicMove, index) => ({ topicMove, relationAction: 'continue', weight: index === 0 ? .6 : .2, reason: 'Synthetic.', evidenceIds: ids })), uncertainties: [], recommendationKind: 'uncalibrated' }; },
    replyFn: async () => ({ reply: '你觉得哪一点有意思？', reason: 'Synthetic.', action: 'reply', styleNote: 'Synthetic.' }) });
  const seed = await server.ensureDemoSeed();
  const empty = server.betaStore.putCounterpart(seed.user.id, { alias: '首图对象', channel: 'app', appProfile: 'Synthetic.', offlineScene: '', background: 'Synthetic.', rounds: 0 });
  const peer = server.betaStore.putCounterpart(seed.user.id, { alias: '另一对象', channel: 'app', appProfile: 'Synthetic.', offlineScene: '', background: 'Synthetic.', rounds: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } }); page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(15000);
  await page.goto(origin); await page.locator('#startup-status').waitFor({ state: 'hidden' }); await page.locator('#counterpart-select').selectOption(empty.id); await page.waitForFunction(() => !document.getElementById('message-text').disabled && !document.querySelector('#transcript .message'));
  const upload = () => page.locator('#message-image-file').setInputFiles({ name: 'fictional.png', mimeType: 'image/png', buffer: png });
  const ready = () => page.waitForFunction(() => !document.getElementById('save-message').disabled);
  await upload(); await page.locator('#message-meaning').fill('我理解这张图是在开玩笑。');
  assert.equal(await page.locator('#save-message').textContent(), '识读图片'); await page.locator('#save-message').click();
  await page.waitForFunction((text) => document.getElementById('message-text').value === text, output.description); await ready();
  assert.equal(server.betaStore.listMessages(seed.user.id, empty.id).length, 0); assert.equal(inputs[0].context.messages.length, 0); assert.equal(inputs[0].explanation, '我理解这张图是在开玩笑。'); report.firstImage = true;
  await page.locator('#message-text').fill('只看到一只猫，文字看不清。'); await page.locator('#message-meaning').fill('这是我的理解，不是她的原话。');
  const recorded = page.waitForResponse((r) => r.url().endsWith('/followup') && r.request().method() === 'POST'); await page.locator('#save-message').click(); assert.equal((await recorded).status(), 200); await ready();
  const message = server.betaStore.listMessages(seed.user.id, empty.id).find(({ speaker }) => speaker === 'other').text;
  assert.ok(message.includes('AI识读后可修改，不是准确原文') && message.includes('AI初次描述') && message.includes('用户补充意思·非对方原文') && !message.includes('data:image')); report.sources = true;
  await page.locator('#message-text').fill('😂'); await page.locator('#message-meaning-details').evaluate((element) => { element.open = true; }); await page.locator('#message-meaning').fill('我理解为轻松的笑，不确定是否认同。');
  const emojiSaved = page.waitForResponse((r) => r.url().endsWith('/followup') && r.request().method() === 'POST'); await page.locator('#save-message').click(); assert.equal((await emojiSaved).status(), 200); await ready();
  assert.ok(server.betaStore.listMessages(seed.user.id, empty.id).at(-1).text.includes('😂')); assert.equal(reads, 1); report.emoji = true;
  await page.locator('#message-text').evaluate((element, bytes) => { const clipboardData = new DataTransfer(); clipboardData.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })); }, [...png]);
  await page.locator('#message-image-preview').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.getElementById('save-message').textContent === '识读图片'); report.paste = true;
  hold = true; started = new Promise((resolve) => { entered = resolve; }); await page.locator('#save-message').click(); await started;
  await page.locator('#message-text').fill('识读期间新写的文字必须保留。'); await page.locator('#counterpart-select').selectOption(peer.id); await page.waitForFunction(() => !document.getElementById('message-text').disabled); await page.locator('#message-text').fill('另一对象自己的草稿。'); release(); hold = false;
  await page.waitForResponse((r) => r.url().endsWith('/image-read')); await page.waitForFunction(() => document.getElementById('save-message').textContent === '记录消息'); assert.equal(await page.locator('#message-text').inputValue(), '另一对象自己的草稿。'); report.lateObject = true;
  await page.locator('#counterpart-select').selectOption(empty.id); await page.waitForFunction(() => document.getElementById('message-text').value === '识读期间新写的文字必须保留。'); await ready(); assert.equal(await page.locator('#message-image-result').isVisible(), true); report.lateTyping = true;
  await page.locator('#remove-message-image').click(); await upload(); await page.locator('#message-meaning').fill('这次按新的补充意思识读。'); hold = true; started = new Promise((resolve) => { entered = resolve; }); await page.locator('#save-message').click(); await started;
  const firstMessage = page.locator('#transcript .message').first(); await firstMessage.locator('summary').click(); await firstMessage.getByRole('button', { name: '编辑对方的消息' }).click(); await page.locator('#message-text').fill('本人正在编辑已有记录。');
  release(); hold = false; await page.waitForResponse((r) => r.url().endsWith('/image-read')); await ready(); assert.equal(await page.locator('#message-text').inputValue(), '本人正在编辑已有记录。'); assert.equal(await page.locator('#message-image-preview').isVisible(), false); await page.locator('#cancel-message-edit').click(); report.editing = true;
  await page.waitForFunction(() => !document.getElementById('direct-reply').disabled); await page.locator('#direct-reply').click();
  await page.waitForFunction(() => document.getElementById('suggestion-text').value.trim() && !document.getElementById('copy-reply').disabled);
  const selfBefore = server.betaStore.listMessages(seed.user.id, empty.id).filter(({ speaker }) => speaker === 'self').length;
  imageOutput = { ...output, kind: 'screenshot', description: '截图可能同时有我说的B与对方说的C，说话人不能确认。' };
  await page.locator('#message-meaning').fill('截图包含双方内容，不能推定我使用了上一草稿。'); await page.locator('#save-message').click(); await page.waitForFunction(() => document.getElementById('save-message').textContent === '记录消息');
  await page.locator('#message-text').fill('截图里是双方聊天，不是单句对方原文。');
  const screenshotSaved = page.waitForResponse((r) => r.url().endsWith('/followup') && r.request().method() === 'POST'); await page.locator('#save-message').click(); const screenshotRequest = (await screenshotSaved).request().postDataJSON(); await ready();
  assert.equal(screenshotRequest.previousSuggestionId, undefined); assert.equal(server.betaStore.listMessages(seed.user.id, empty.id).filter(({ speaker }) => speaker === 'self').length, selfBefore); assert.ok(server.betaStore.listMessages(seed.user.id, empty.id).at(-1).text.includes('可能包含双方内容')); report.screenshotNoInferredSelf = true;
  await upload();
  await mkdir('runs/image-input', { recursive: true });
  for (const theme of ['day', 'night']) { await page.setViewportSize({ width: 320, height: 740 }); await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme); await page.locator('#message-meaning-details').evaluate((element) => { element.open = true; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.locator('#save-message').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#save-message').isVisible(), true); await page.screenshot({ path: `runs/image-input/320-${theme}.png` }); report.smallScreens.push(theme); }
  await page.setViewportSize({ width: 1280, height: 950 }); await page.screenshot({ path: 'runs/image-input/1280-image-draft.png' });
  assert.deepEqual(errors, []); report.reads = reads; await writeFile('runs/image-input/result.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } await rm(directory, { recursive: true, force: true }); }
