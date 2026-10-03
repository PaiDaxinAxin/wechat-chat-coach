import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axe from 'axe-core';
import { chromium } from 'playwright';
import { createBetaServer, seedOwner } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Fictional contacts, private temporary storage, injected models and a local
// ephemeral server only. Never use the owner's running demo or provider keys.
process.umask(0o077);
const temporary = await mkdtemp(join(tmpdir(), 'coach-directory-'));
const evidenceDir = join(process.cwd(), 'runs/directory');
const DAY = 86_400_000;
const evaluation = Date.parse('2026-10-08T12:00:00.000Z');
let clock = evaluation, server, browser, releaseHeldRead;
const report = { passed: false, synthetic: true, actualProviderCalls: 0, cases: [],
  scans: [], pageErrors: [], externalRequests: [], mockCalls: { classification: 0, reply: 0, plan: 0, image: 0 } };
const aliases = { high: '林微', recent: '周宁', low: '陈晴', unknown: '宋雨' };
const dimensions = ['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough'];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000); })]); }
  finally { clearTimeout(timer); }
}

function classification(context) {
  const alias = JSON.parse(context.counterpartProfile).alias;
  const ids = context.messages.filter(({ speaker }) => speaker === 'other').map(({ id }) => id);
  return {
    status: 'ready', confidence: 'moderate', phase: 'ordinary',
    workingFocus: { stage: 'value_display', reason: '沿虚构日常继续了解。', evidenceIds: [ids.at(-1)] },
    topicDecision: { mode: 'stay', reason: '当前话题仍在展开。' },
    obstacle: { type: 'none', evidenceIds: [], reason: '没有记录明确拒绝。' },
    heat: Object.fromEntries(dimensions.map((name, index) => [name, {
      level: alias === aliases.high ? 'repeated_positive' : alias === aliases.low ? 'passive' : index < 3 ? 'positive' : 'unknown',
      evidenceIds: alias === aliases.recent && index >= 3 ? [] : [ids[index % ids.length]],
    }])),
    options: [], uncertainties: ['实际关系效果未经评估。'], recommendationKind: 'uncalibrated',
    fieldCoach: { currentTopic: '日常与兴趣', topicStatus: 'developing', topicMessageIds: ids,
      initiative: '沿已经说过的日常继续。', nextAction: '分享一点真实经历。', pitfall: '不要把参考指数当成功率。',
      warmingLayer: 'none', reason: '这里只用虚构消息检查界面。' },
  };
}

try {
  await mkdir(evidenceDir, { recursive: true });
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8'), knowledgePath = join(temporary, 'knowledge.md');
  await writeFile(knowledgePath, knowledgeText);
  const webDir = join(temporary, 'public'); await mkdir(webDir);
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  server = await createBetaServer({ dataDir: join(temporary, 'data'), knowledgePath, webDir, providerEnv: {}, now: () => clock,
    paidProviderDailyLimit: 30,
    classifyFn: async (context, options) => { report.mockCalls.classification++; assert.equal(options.knowledgeText, knowledgeText); return classification(context); },
    replyFn: async () => { report.mockCalls.reply++; throw new Error('Directory readback must not request a reply'); },
    planFn: async () => { report.mockCalls.plan++; throw new Error('Directory readback must not request a plan'); },
    imageFn: async () => { report.mockCalls.image++; throw new Error('Directory readback must not inspect an image'); },
  });
  const password = 'SyntheticDirectory2026';
  const owner = await seedOwner(server.betaStore, { username: 'directory-owner', password });
  const account = async (username) => {
    const invite = (await server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' })).invite;
    return server.betaStore.register({ invite, username, password });
  };
  const primary = await account('directory-primary'), emptyAccount = await account('directory-empty');
  const people = {};
  for (const [kind, days] of [['high', 3], ['recent', 0], ['low', 1], ['unknown', null]]) {
    clock = evaluation;
    people[kind] = await server.betaStore.putCounterpart(primary.id, {
      alias: aliases[kind], remark: kind === 'high' ? '咖啡同好' : kind === 'unknown' ? '远行<span>同学</span>' : '',
      channel: 'other', appProfile: '', offlineScene: '', background: '完全虚构的目录验收对象。', rounds: null,
    });
    if (days === null) continue;
    for (const [index, text] of ['最近在读书。', '也喜欢散步。', `${aliases[kind]}的最后一条虚构回复。`].entries()) {
      clock = evaluation - days * DAY - (2 - index) * 60_000;
      await server.betaStore.putMessage(primary.id, people[kind].id, { speaker: 'other', text });
    }
    // Newer self wording must not replace a counterpart's last-reply snippet or
    // refresh the heat's counterpart-evidence anchor.
    clock = evaluation;
    await server.betaStore.putMessage(primary.id, people[kind].id, { speaker: 'self', text: '本人最近的记录，不是对方回复。' });
    await server.invokeForAccount({ accountId: primary.id, method: 'POST', path: `/api/counterparts/${people[kind].id}/classify`, body: { requestId: `directory_seed_${kind}` } });
  }
  clock = evaluation;
  const session = await server.betaStore.createSession(primary.id);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'chat_coach_session', value: session.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  await context.addInitScript({ content: axe.source });
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.externalRequests.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  await page.clock.install({ time: new Date(evaluation) });
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  const modelBaseline = { ...report.mockCalls };
  const listPath = '/api/counterparts';
  const rows = () => page.locator('#counterpart-list > li > button[data-counterpart-id]');
  const row = (kind) => page.locator(`#counterpart-list > li > button[data-counterpart-id="${people[kind].id}"]`);
  const ids = () => rows().evaluateAll((buttons) => buttons.map((button) => button.dataset.counterpartId));
  const assertNoInference = () => assert.deepEqual(report.mockCalls, modelBaseline, 'Directory UI and polling invoke no model');
  async function getDirectory() {
    const response = await context.request.get(origin + listPath); assert.equal(response.status(), 200);
    return (await response.json()).data.counterparts;
  }
  async function waitResponse(path, method, action) {
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
    await action(); const response = await pending, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); return body.data;
  }
  async function menu(selector) {
    if (!await page.locator(selector).isVisible()) await page.locator('#chat-menu > summary').click();
    await page.locator(selector).click();
  }
  async function poll() {
    await waitResponse(listPath, 'GET', () => page.clock.runFor(60_000));
    await page.waitForFunction(() => document.querySelector('#counterpart-list > li > button[aria-current=true]'));
  }
  async function scan(label) {
    const result = await page.evaluate(() => window.axe.run({ include: [['#counterpart-directory']] }));
    report.scans.push({ label, engine: axe.version, scope: '#counterpart-directory',
      violations: result.violations.map(({ id, impact, help, nodes }) => ({ id, impact, help, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) })),
      incomplete: result.incomplete.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })) });
    assert.deepEqual(result.violations.map(({ id }) => id), [], `${label}: default axe rules on the added sidebar`);
  }
  async function layout(width, theme) {
    await page.setViewportSize({ width, height: 950 });
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${theme} page width`);
    assert.ok(await page.locator('#counterpart-directory').isVisible());
    const geometry = await rows().evaluateAll((buttons) => buttons.map((button) => ({ id: button.dataset.counterpartId, height: button.getBoundingClientRect().height })));
    assert.ok(geometry.every(({ height }) => height >= 44), JSON.stringify(geometry));
    await scan(`${width}-${theme}`);
    await page.screenshot({ path: join(evidenceDir, `${width}-${theme}.png`), fullPage: true });
  }

  await page.goto(origin); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await page.waitForFunction((id) => document.querySelector('#counterpart-select').value === id, people.recent.id);
  assert.deepEqual(await ids(), [people.recent.id, people.low.id, people.high.id, people.unknown.id]);
  assert.equal(await row('high').locator('.directory-name').textContent(), '咖啡同好');
  assert.equal(await row('high').locator('.directory-preview').textContent(), '林微 · 林微的最后一条虚构回复。');
  assert.equal(await row('recent').locator('.directory-preview').textContent(), '周宁的最后一条虚构回复。');
  assert.equal(await row('unknown').locator('.directory-heat').textContent(), '—');
  assert.equal(await row('unknown').locator('.directory-name').textContent(), '远行<span>同学</span>');
  assert.equal(await row('unknown').locator('img,script').count(), 0, 'Remark strings remain text');
  report.cases.push('Fictional names, independent remarks, last-counterpart previews and unknown heat render faithfully');

  const initialDirectory = await getDirectory();
  const highHeat = initialDirectory.find(({ id }) => id === people.high.id).directory.heat;
  assert.equal(highHeat.baseValue, 100); assert.equal(highHeat.value, 97); assert.equal(highHeat.inactiveDays, 3); assert.equal(highHeat.decayPerDay, 1);
  assert.equal(initialDirectory.find(({ id }) => id === people.unknown.id).directory.heat.value, null);
  await page.locator('#message-text').fill('保留当前对话的未提交草稿');
  await page.locator('#message-speaker').selectOption('self');
  await page.locator('#directory-sort').selectOption('heat_desc');
  assert.deepEqual(await ids(), [people.high.id, people.recent.id, people.low.id, people.unknown.id]);
  assert.equal(await page.locator('#counterpart-select').inputValue(), people.recent.id);
  assert.equal(await page.locator('#message-text').inputValue(), '保留当前对话的未提交草稿');
  assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
  await page.locator('#directory-sort').selectOption('recent');
  assert.deepEqual(await ids(), [people.recent.id, people.low.id, people.high.id, people.unknown.id]);
  assertNoInference(); report.cases.push('Both sort modes retain the active contact, composer text and speaker without inference');

  for (const width of [1280, 1440]) for (const theme of ['day', 'night']) await layout(width, theme);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#counterpart-directory').isVisible(), false);
  assert.ok(await page.locator('#counterpart-select').isVisible());
  assert.equal(await page.locator('#counterpart-select').evaluate((element) => element.tagName), 'SELECT');
  await page.locator('#chat-menu > summary').click();
  await page.locator('#directory-sort-compact').selectOption('heat_desc');
  assert.equal(await page.locator('#counterpart-select').inputValue(), people.recent.id);
  assert.equal(await page.locator('#message-text').inputValue(), '保留当前对话的未提交草稿');
  assert.equal(await page.locator('#directory-sort').inputValue(), 'heat_desc');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.closest('details')?.id), 'chat-menu');
  for (const theme of ['day', 'night']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(evidenceDir, `390-${theme}.png`), fullPage: true });
  }
  await page.locator('#counterpart-select').selectOption(people.high.id);
  await page.waitForFunction(() => !document.querySelector('#message-text').disabled && document.querySelector('#counterpart-title').textContent === '咖啡同好');
  await page.locator('#counterpart-select').selectOption(people.recent.id);
  await page.waitForFunction((id) => document.querySelector('#counterpart-select').value === id && !document.querySelector('#message-text').disabled, people.recent.id);
  assert.equal(await page.locator('#message-text').inputValue(), '保留当前对话的未提交草稿');
  assertNoInference(); report.cases.push('Mobile retains the native selector and compact sorting, with contact-specific drafts');

  await page.setViewportSize({ width: 1280, height: 950 });
  const focusRow = row('recent'); await focusRow.focus();
  clock += DAY; await poll();
  const decayed = await getDirectory();
  for (const before of initialDirectory) {
    const after = decayed.find(({ id }) => id === before.id).directory.heat;
    assert.equal(after.baseValue, before.directory.heat.baseValue);
    assert.equal(after.value, before.directory.heat.value === null ? null : Math.max(0, before.directory.heat.value - 1));
  }
  assert.equal(await page.evaluate(() => document.activeElement.dataset.counterpartId), people.recent.id);
  assert.equal(await page.locator('#message-text').inputValue(), '保留当前对话的未提交草稿');
  await poll(); assert.deepEqual(await getDirectory(), decayed, 'Polling does not compound decay or mutate records');
  assertNoInference(); report.cases.push('60-second GET-only polling uses one-degree-per-full-day decay without compounding or stealing focus');

  async function holdNextDirectory() {
    const held = deferred(), release = deferred(), settled = deferred();
    releaseHeldRead = release.resolve;
    const handler = async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); const body = await response.json(); held.resolve();
      await release.promise; await route.fulfill({ response, json: body }); settled.resolve();
    };
    await page.route(origin + listPath, handler, { times: 1 });
    await page.clock.runFor(60_000); await bounded(held.promise, 'Held directory poll');
    return async () => { release.resolve(); await bounded(settled.promise, 'Released directory read'); releaseHeldRead = null; };
  }
  const releaseStaleRemark = await holdNextDirectory();
  await menu('#edit-counterpart'); assert.equal(await page.locator('#intake-alias').inputValue(), aliases.recent);
  await page.locator('#intake-remark').fill('最近认识的书友');
  await waitResponse(`/api/counterparts/${people.recent.id}`, 'PUT', () => page.locator('#counterpart-form button[type=submit]').click());
  await page.waitForFunction(() => document.querySelector('#counterpart-title').textContent === '最近认识的书友');
  await releaseStaleRemark();
  assert.equal(await row('recent').locator('.directory-name').textContent(), '最近认识的书友');
  assert.ok((await row('recent').locator('.directory-preview').textContent()).startsWith('周宁 · '));
  assert.equal(await page.locator('#message-text').inputValue(), '保留当前对话的未提交草稿');
  assertNoInference(); report.cases.push('Remark editing preserves the original name and an obsolete directory GET cannot undo the newer read');

  const releasePreviousAccount = await holdNextDirectory();
  await menu('#logout'); await page.locator('#auth').waitFor({ state: 'visible' });
  await page.locator('#username').fill(emptyAccount.username); await page.locator('#password').fill(password);
  await waitResponse('/api/login', 'POST', () => page.locator('#auth-submit').click());
  await page.locator('#workspace').waitFor({ state: 'visible' }); await page.locator('#directory-empty').waitFor({ state: 'visible' });
  await releasePreviousAccount();
  assert.equal(await rows().count(), 0); assert.equal(await page.locator('#counterpart-select').inputValue(), '');
  assert.ok(!(await page.locator('#counterpart-directory').textContent()).includes('咖啡同好'));
  assert.equal(await page.locator('#message-text').inputValue(), '');
  await scan('empty-account'); await page.screenshot({ path: join(evidenceDir, 'empty-1280.png'), fullPage: true });
  assertNoInference(); report.cases.push('An empty account remains empty after another account’s delayed directory response');

  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  assert.equal(await readFile(knowledgePath, 'utf8'), knowledgeText, 'The fixture never promotes data into knowledge');
  report.passed = true;
  console.log(`Directory browser: ${report.cases.length} journeys passed; zero actual provider calls.`);
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  releaseHeldRead?.();
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await server?.storeClosed;
  await rm(temporary, { recursive: true, force: true });
}
