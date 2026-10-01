import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Entirely synthetic browser acceptance: fresh private DB/full KB copy, no API keys.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-reply-guidance-'));
let server, browser;
try {
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md'); await writeFile(knowledgePath, knowledgeText);
  const webDir = join(directory, 'public'); await mkdir(webDir);
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  let classifications = 0, replies = 0;
  const responses = [
    { reply: '感觉你对这件事挺认真。哪个部分最有意思？', reason: '先真诚回应，再轻度表达欣赏。', action: 'reply', styleNote: '用自己的说法，不必照抄。', guidance: { topicMove: 'down', relationMove: 'light_approach', ownWordsGuide: '先说一个真实欣赏的点，再问具体细节。', reentryWhen: '她继续展开时，顺着新内容接话。' } },
    { reply: '', reason: '这个话题已经自然收住，单句表情不等于低兴趣。', action: 'wait', styleNote: '不用为了维持聊天硬续一句。', guidance: { topicMove: null, relationMove: 'wait', ownWordsGuide: '本轮先不发送，保留自然留白。', reentryWhen: '她有新内容，或你有真实新话题时再判断。' } },
    { reply: '你平时怎么放松？', reason: '顺着生活话题自然了解。', action: 'reply', styleNote: '保持你的自然表达。' },
    { reply: '', reason: '对方已经明确拒绝，不继续同类推进。', action: 'pause', styleNote: '尊重边界。', guidance: { topicMove: null, relationMove: 'pause', ownWordsGuide: '停止这类推进，不再追问。', reentryWhen: '对方明确愿意恢复交流时，再判断是否接话。' } },
  ];
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, webDir, localDemoMode: true, paidProviderDailyLimit: 20,
    classifyFn: async (context, options) => {
      classifications++; assert.equal(options.knowledgeText, knowledgeText);
      const id = context.messages.findLast(({ speaker }) => speaker === 'other').id;
      const unknown = { level: 'unknown', evidenceIds: [] };
      return { status: 'ready', confidence: 'limited', phase: 'ordinary', obstacle: { type: 'none', evidenceIds: [], reason: '当前没有明确阻力。' }, heat: Object.fromEntries(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'].map((name) => [name, unknown])), options: ['up', 'down', 'sideways'].map((topicMove, index) => ({ topicMove, weight: index === 0 ? .6 : .2, relationAction: 'continue', reason: '自然了解当前话题。', evidenceIds: [id] })), uncertainties: ['仅作合成测试。'], recommendationKind: 'uncalibrated' };
    },
    replyFn: async (_input, options) => { assert.equal(options.knowledgeText, knowledgeText); return responses[replies++]; },
  });
  await server.ensureDemoSeed(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  // Synthetic clipboard success records a server copy receipt without touching
  // the operator's real clipboard.
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true }));
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  async function perform(suffix, action) {
    const response = page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === 'POST');
    await action(); const received = await response, body = await received.json(); assert.equal(received.status(), 200);
    if (body.data.suggestion) await page.waitForFunction((id) => [...document.querySelectorAll('[data-suggestion-id]')].some((button) => button.dataset.suggestionId === id), body.data.suggestion.id);
    return body.data;
  }
  async function detail() {
    const response = await context.request.get(`${origin}/api/counterparts/${id}`);
    assert.equal(response.status(), 200, 'Saved context must be readable before inspecting private fixture data');
    return (await response.json()).data;
  }
  async function ready() { await page.waitForFunction(() => [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled)); }
  await page.goto(origin); await ready();
  const id = await page.locator('#counterpart-select').inputValue();
  await perform('/reply', () => page.locator('[data-direction=down]').click());
  assert.equal(await page.locator('#reply-guidance').isVisible(), true);
  assert.equal(await page.locator('#suggestion-direction').textContent(), '下切');
  assert.equal(await page.locator('#reply-relation').textContent(), '轻度靠近');
  assert.equal(await page.locator('#reply-own-words').textContent(), responses[0].guidance.ownWordsGuide);
  assert.equal(await page.locator('#reply-reentry').textContent(), responses[0].guidance.reentryWhen);
  await page.locator('#suggestion-text').fill(' '); assert.equal(await page.locator('#copy-reply').isDisabled(), true);
  await page.locator('#suggestion-text').fill('本人改写，不表示已发送。'); assert.equal(await page.locator('#copy-reply').isDisabled(), false);
  await perform('/copied', () => page.locator('#copy-reply').click());
  await ready(); await perform('/reply', () => page.locator('[data-direction=up]').click());
  assert.equal(await page.locator('#suggestion-editor').isVisible(), false);
  assert.equal(await page.locator('#copy-reply').isDisabled(), true);
  assert.equal(await page.locator('#suggestion-direction').isVisible(), false);
  assert.equal(await page.locator('#reply-wait-reason').isVisible(), true);
  assert.ok((await page.locator('#reply-wait-reason').textContent()).includes('单句表情不等于低兴趣'));
  assert.equal(await page.locator('#reply-reentry').textContent(), responses[1].guidance.reentryWhen);
  await page.reload(); await ready();
  assert.equal(await page.locator('#suggestion-panel').isVisible(), true);
  assert.equal(await page.locator('#suggestion-title').textContent(), 'AI 建议 · 暂时不回');
  assert.equal(await page.locator('#copy-reply').isDisabled(), true);
  assert.equal(replies, 2); assert.equal(classifications, 1, 'Reload uses durable attempts, not another model call');
  const before = await detail();
  await page.locator('#message-text').fill('合成下一句：刚忙完。');
  const followed = await perform('/followup', () => page.locator('#save-message').click());
  assert.equal(followed.previousMessage, null); assert.equal(followed.feedback, null, 'No-reply suggestions cannot become inferred sent messages');
  await page.getByText('合成下一句：刚忙完。', { exact: true }).waitFor({ state: 'visible' });
  await ready();
  const after = await detail();
  assert.equal(after.messages.length, before.messages.length + 1);
  await perform('/reply', () => page.locator('[data-direction=sideways]').click());
  assert.equal(await page.locator('#reply-relation').textContent(), '这条旧建议未保存关系动作');
  assert.ok((await page.locator('#reply-own-words').textContent()).includes('旧建议未保存'));
  assert.equal(await page.locator('#suggestion-text').isVisible(), true); assert.equal(await page.locator('#copy-reply').isDisabled(), false);
  await perform('/copied', () => page.locator('#copy-reply').click());
  await ready(); await perform('/reply', () => page.locator('[data-direction=down]').click());
  assert.equal(await page.locator('#reply-relation').textContent(), '停止当前推进');
  assert.equal(await page.locator('#copy-reply').isDisabled(), true);
  assert.equal(await page.locator('#suggestion-editor').isVisible(), false);
  assert.equal(await page.locator('#reply-reentry').textContent(), responses[3].guidance.reentryWhen);
  await page.reload(); await ready();
  assert.equal(await page.locator('#suggestion-title').textContent(), 'AI 建议 · 先停止当前推进');
  assert.equal(await page.locator('#copy-reply').isDisabled(), true);
  assert.equal(replies, 4, 'Copied history cannot replace a later pause after reload');
  const beforePause = await detail();
  await page.locator('#message-text').fill('合成下一句：暂停后新的内容。');
  const pauseFollowup = await perform('/followup', () => page.locator('#save-message').click());
  assert.equal(pauseFollowup.previousMessage, null); assert.equal(pauseFollowup.feedback, null);
  await page.getByText('合成下一句：暂停后新的内容。', { exact: true }).waitFor({ state: 'visible' });
  const afterPause = await detail();
  assert.equal(afterPause.messages.length, beforePause.messages.length + 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []); assert.equal(replies, 4);
  console.log(JSON.stringify({ status: 'passed', guidedReply: true, legacyFallback: true, copiedThenWaitAndPauseSurviveReload: true, copyDisabledForWaitAndPause: true, noInferredMessageFromWaitOrPause: true, mockReplies: replies, mockClassifications: classifications, paidCalls: 0 }));
} finally {
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
