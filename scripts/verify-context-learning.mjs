import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer, seedOwner } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// All people, conversations and providers are isolated synthetic fixtures.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-context-learning-'));
const evidenceDir = join(process.cwd(), 'runs/context-learning');
const report = { passed: false, synthetic: true, actualProviderCalls: 0, cases: [], pageErrors: [], externalRequests: [] };
let server, browser, classifications = 0, replies = 0, replyGate, releaseDetailRead;
const otherBackground = '我在杭州做产品，周末喜欢逛书店。';
const selfBackground = '我在上海做设计。';
const invitation = '周六 19:00 一起去湖畔咖啡见面？';
const acceptance = '好，周六 19:00 湖畔咖啡见。';
const ev = (message) => ({ messageId: message.id, quote: message.text, source: 'text' });

function extracted(context) {
  const find = (text) => context.messages.find((message) => message.text === text);
  const other = find(otherBackground), self = find(selfBackground), proposed = find(invitation), accepted = find(acceptance);
  const facts = [];
  if (other) facts.push({ subject: 'other', field: 'work', value: '在杭州做产品', evidence: [ev(other)] }, { subject: 'other', field: 'interests', value: '周末喜欢逛书店', evidence: [ev(other)] });
  if (self) facts.push({ subject: 'self', field: 'work', value: '在上海做设计', evidence: [ev(self)] });
  return { facts, meeting: proposed ? { status: accepted ? 'confirmed' : 'proposed', time: '周六 19:00', place: '湖畔咖啡', note: '', evidence: [ev(proposed), ...(accepted ? [ev(accepted)] : [])] } : null };
}
function classified(context) {
  const id = context.messages.findLast((message) => message.speaker === 'other').id;
  return {
    status: 'ready', confidence: 'limited', phase: 'ordinary',
    workingFocus: { stage: 'value_display', reason: '沿记录里的兴趣继续了解。', evidenceIds: [id] },
    topicDecision: { mode: 'stay', reason: '当前话题还可以继续。' },
    obstacle: { type: 'none', evidenceIds: [], reason: '记录中没有明确拒绝。' },
    heat: Object.fromEntries(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'].map((name) => [name, { level: name === 'responseEngagement' ? 'positive' : 'unknown', evidenceIds: name === 'responseEngagement' ? [id] : [] }])),
    options: [], uncertainties: [], recommendationKind: 'uncalibrated',
    fieldCoach: { currentTopic: '生活与兴趣', topicStatus: 'developing', topicMessageIds: [id], warmingLayer: 'none', initiative: '聊彼此日常喜欢做的事。', nextAction: '沿已有内容分享一个细节。', reason: '仅使用已记录的虚构消息。' },
    contextUpdates: extracted(context),
  };
}

try {
  await mkdir(evidenceDir, { recursive: true });
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8'), knowledgePath = join(directory, 'knowledge.md');
  await writeFile(knowledgePath, knowledgeText);
  const webDir = join(directory, 'public'); await mkdir(webDir);
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, webDir, providerEnv: {}, paidProviderDailyLimit: 100,
    classifyFn: async (context, options) => { classifications++; assert.equal(options.knowledgeText, knowledgeText); return classified(context); },
    replyFn: async ({ context }, options) => {
      replies++; assert.equal(options.knowledgeText, knowledgeText); await replyGate?.();
      return { reply: '你最近逛过哪家书店？', action: 'reply', reason: '接住她已经提到的兴趣。', styleNote: '简短自然。',
        workingFocus: { stage: 'value_display', reason: '继续了解。', evidenceIds: [context.messages.at(-1).id] },
        guidance: { topicMove: null, relationMove: 'continue', ownWordsGuide: '聊她喜欢的书店。', reentryWhen: '对方展开时继续。' }, contextUpdates: extracted(context) };
    },
    imageFn: async () => { throw new Error('Image inference is outside this fixture'); },
    planFn: async () => { throw new Error('Plan inference is outside this fixture'); },
  });
  const owner = await seedOwner(server.betaStore, { username: 'context-learning-owner', password: 'SyntheticContext2026' });
  const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' }).invite;
  const user = await server.betaStore.register({ invite, username: 'context-learning-user', password: 'SyntheticContext2026' });
  const session = server.betaStore.createSession(user.id);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await browserContext.addCookies([{ name: 'chat_coach_session', value: session.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  await browserContext.route('**/*', (route) => { if (new URL(route.request().url()).origin === origin) return route.continue(); report.externalRequests.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient'); });
  const page = await browserContext.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => report.pageErrors.push(error.message));
  const waitRequest = async (suffix, method, action) => {
    const response = page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === method);
    await action(); const received = await response, payload = await received.json(); assert.equal(received.status(), 200, JSON.stringify(payload)); return payload.data;
  };
  const menu = async (selector) => { if (!await page.locator(selector).isVisible()) await page.locator('#chat-menu > summary').click(); await page.locator(selector).click(); };
  const idle = () => page.waitForFunction(() => document.getElementById('coach-panel').getAttribute('aria-busy') === 'false');
  const record = async (speaker, text) => {
    await page.locator('#message-speaker').selectOption(speaker); await page.locator('#message-text').fill(text);
    const analysis = page.waitForResponse((r) => r.url().endsWith('/classify') && r.request().method() === 'POST');
    await page.locator('#save-message').click(); const response = await analysis; assert.equal(response.status(), 200, JSON.stringify(await response.json())); await idle();
  };
  await page.goto(origin); await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#profile-view').isVisible(), false, 'Blank profile does not block entry');
  await page.locator('#add-counterpart').click(); await page.locator('#intake-alias').fill('虚构对象');
  const created = await waitRequest('/api/counterparts', 'POST', () => page.locator('#counterpart-form button[type=submit]').click());
  const id = created.counterpart.id;
  assert.equal(created.counterpart.rounds, null, 'Unfilled prior topic counts remain unknown');
  await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(server.betaStore.getProfile(user.id), null);
  report.cases.push('Alias-only intake and null profile enter the chat');

  await record('other', otherBackground);
  await menu('#edit-counterpart');
  assert.match(await page.locator('#counterpart-chat-facts').textContent(), /在杭州做产品/);
  assert.match(await page.locator('#counterpart-chat-facts').textContent(), /周末喜欢逛书店/);
  assert.equal(await page.locator('#intake-background').inputValue(), '', 'Derived facts do not get resaved as manual facts');
  await page.screenshot({ path: join(evidenceDir, 'automatic-background-desktop.png') });
  await page.locator('#close-counterpart-dialog').click();
  report.cases.push('Recorded counterpart background appears without duplicate entry');

  await record('self', selfBackground);
  await menu('[data-view=profile]');
  assert.match(await page.locator('#profile-chat-facts').textContent(), /在上海做设计/);
  assert.equal(await page.locator('#profile-background').inputValue(), '');
  assert.equal(server.betaStore.getProfile(user.id), null, 'Private conversation facts do not overwrite account identity');
  await page.locator('[data-close=profile-view]').click();
  report.cases.push('Self background is organized within the current conversation');

  await record('self', invitation); await menu('#open-meeting');
  assert.equal(await page.locator('#meeting-kind').inputValue(), 'proposed');
  assert.equal(await page.locator('#meeting-time').inputValue(), '周六 19:00');
  assert.equal(await page.locator('#meeting-place').inputValue(), '湖畔咖啡');
  assert.equal(server.betaStore.getMeeting(user.id, id).status, 'none');
  await page.locator('[data-close=meeting-panel]').click();
  await record('other', acceptance); await menu('#open-meeting');
  assert.equal(await page.locator('#meeting-kind').inputValue(), 'confirmed');
  report.cases.push('Invitation and explicit acceptance update the existing arrangement automatically');

  const callsBeforeReload = classifications; await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' }); await idle();
  await menu('#open-meeting'); assert.equal(await page.locator('#meeting-kind').inputValue(), 'confirmed');
  assert.equal(classifications, callsBeforeReload, 'Projection readback cannot create a paid inference loop');
  report.cases.push('Reload restores the arrangement with no extra provider attempt');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidenceDir, 'automatic-meeting-mobile-day.png') });
  await page.locator('#theme-toggle').click();
  await page.screenshot({ path: join(evidenceDir, 'automatic-meeting-mobile-night.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  report.cases.push('Day/night mobile arrangement has no horizontal overflow');

  await page.locator('#meeting-time').fill('周六 20:00');
  await page.locator('[data-close=meeting-panel]').click();
  let releaseReply; replyGate = () => new Promise((resolve) => { releaseReply = resolve; });
  const replyResponse = page.waitForResponse((r) => r.url().endsWith('/reply') && r.request().method() === 'POST');
  await page.locator('#direct-reply').click();
  await page.waitForFunction(() => document.getElementById('coach-panel').getAttribute('aria-busy') === 'true');
  // Server event-loop work is awaited via a bounded poll, not an external provider.
  for (let attempt = 0; !releaseReply && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseReply); releaseReply(); assert.equal((await replyResponse).status(), 200); await idle();
  await menu('#open-meeting'); assert.equal(await page.locator('#meeting-time').inputValue(), '周六 20:00');
  await waitRequest('/meeting', 'PUT', () => page.locator('#meeting-form button[type=submit]').click());
  await page.waitForFunction(() => !document.querySelector('#meeting-form button[type=submit]').disabled);
  assert.equal(server.betaStore.getMeeting(user.id, id).time, '周六 20:00');
  report.cases.push('A typed manual correction survives a concurrent reply and can be saved');

  await page.locator('[data-close=meeting-panel]').click(); await menu('[data-view=profile]');
  await page.locator('.questionnaire-details > summary').click();
  const question = page.locator('#questionnaire select').first(); await question.selectOption('4');
  const callsBeforeProfileSave = { classifications, replies };
  await waitRequest('/api/profile', 'PUT', () => page.locator('#profile-form button[type=submit]').click());
  await page.locator('#profile-view').waitFor({ state: 'hidden' });
  const profile = server.betaStore.getProfile(user.id);
  assert.deepEqual(profile.questionnaire.answers, { s01: 4 }); assert.equal(profile.background, '');
  assert.equal(profile.questionnaireHypotheses.dimensions.warmth.mean, null);
  assert.deepEqual({ classifications, replies }, callsBeforeProfileSave, 'Saving optional intake does not silently spend another inference');
  report.cases.push('A partial questionnaire saves only the real answer, not neutral defaults');

  // A profile save starts a real detail read. Hold its already-fetched snapshot,
  // then accept a new classification before that old response reaches the UI.
  let detailReads = 0, snapshotFetched;
  const snapshotReady = new Promise((resolve) => { snapshotFetched = resolve; });
  const holdDetailRead = async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (++detailReads > 1) return route.continue();
    const response = await route.fetch();
    assert.equal((await response.json()).data.backgroundContext.facts.length, 0, 'Profile changes withdraw the older projection');
    await new Promise((resolve) => { releaseDetailRead = resolve; snapshotFetched(); });
    await route.fulfill({ response });
  };
  await page.route(`${origin}/api/counterparts/${id}`, holdDetailRead);
  await menu('[data-view=profile]');
  await page.locator('#profile-background').fill('平时做设计，愿意聊自己的真实经历。');
  await waitRequest('/api/profile', 'PUT', () => page.locator('#profile-form button[type=submit]').click());
  await snapshotReady;
  await page.locator('[data-close=profile-view]').click();
  const classifiedAgain = await waitRequest('/classify', 'POST', () => page.locator('#change-topic').click());
  await idle();
  assert.equal(classifiedAgain.backgroundContext.facts.length, 3);
  await menu('#edit-counterpart');
  assert.match(await page.locator('#counterpart-chat-facts').textContent(), /在杭州做产品/);
  const callsBeforeOldRead = { classifications, replies };
  releaseDetailRead(); releaseDetailRead = null;
  await page.waitForFunction(() => !document.querySelector('#profile-form button[type=submit]').disabled);
  assert.equal(detailReads, 2, 'The obsolete detail snapshot is replaced by one fresh read');
  assert.match(await page.locator('#counterpart-chat-facts').textContent(), /在杭州做产品/);
  await page.unroute(`${origin}/api/counterparts/${id}`, holdDetailRead);
  await menu('#open-meeting');
  assert.equal(await page.locator('#meeting-time').inputValue(), '周六 20:00', 'Fresh projections preserve the saved manual correction');
  assert.deepEqual({ classifications, replies }, callsBeforeOldRead, 'Recovering an obsolete detail read invokes no provider');
  report.cases.push('A delayed detail read cannot undo newer background or arrangement projections');

  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  report.passed = true; report.classifications = classifications; report.replies = replies;
  console.log(`Context learning browser: ${report.cases.length} journeys passed; zero actual provider calls.`);
} finally {
  releaseDetailRead?.();
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await server?.dispose?.();
  await rm(directory, { recursive: true, force: true });
}
