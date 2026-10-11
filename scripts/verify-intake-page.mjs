import { switchConversation, openNewConversation, returnToConversation } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import axe from 'axe-core';
import { createBetaServer, seedOwner } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// The full-page intake journey uses fictional accounts, copied knowledge and
// temporary storage. Any model request fails the fixture without using a key.
process.umask(0o077);
const temporary = await mkdtemp(join(tmpdir(), 'coach-intake-page-'));
const evidenceDir = join(process.cwd(), 'runs/intake-page');
const report = { passed: false, synthetic: true, actualProviderCalls: 0, cases: [], scans: [], pageErrors: [], externalRequests: [], modelRequests: [] };
let server, browser, releaseHeldRead;
try {
  await mkdir(evidenceDir, { recursive: true });
  const knowledgePath = join(temporary, 'knowledge.md');
  await writeFile(knowledgePath, await readFile(DEFAULT_KNOWLEDGE_PATH));
  const unexpectedModel = async () => { report.modelRequests.push('unexpected'); throw new Error('Intake navigation must not invoke a model'); };
  server = await createBetaServer({ dataDir: join(temporary, 'data'), knowledgePath, webDir: join(process.cwd(), 'web'), providerEnv: {},
    classifyFn: unexpectedModel, replyFn: unexpectedModel, imageFn: unexpectedModel, planFn: unexpectedModel });
  const owner = await seedOwner(server.betaStore, { username: 'intake-owner', password: 'SyntheticIntake2026' });
  const original = await server.betaStore.putCounterpart(owner.id, { alias: '原有虚构对象', remark: '', channel: 'other', appProfile: '', offlineScene: '', background: '仅用于独立页面验收。', rounds: null });
  await server.betaStore.putMessage(owner.id, original.id, { speaker: 'other', text: '今天看了一本很有趣的书。' });
  const invite = (await server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' })).invite;
  const emptyAccount = await server.betaStore.register({ username: 'intake-empty', password: 'SyntheticIntake2026', invite });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
  const session = await server.betaStore.createSession(owner.id);
  await context.addCookies([{ name: 'chat_coach_session', value: session.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  await context.addInitScript({ content: axe.source });
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.externalRequests.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  const submit = () => page.locator('#counterpart-form button[type=submit]');
  async function ready(id) {
    await page.waitForFunction((id) => document.getElementById('workspace').checkVisibility() && document.getElementById('counterpart-select').value === id && !document.getElementById('message-text').disabled, id);
  }
  async function select(id) { await switchConversation(page, id); await ready(id); }
  async function menu(selector) { if (!await page.locator(selector).isVisible()) await page.locator('#chat-menu > summary').click(); await page.locator(selector).click(); }
  async function saved(path, method, action) {
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
    await action(); const response = await pending; assert.equal(response.status(), 200); return (await response.json()).data;
  }
  async function assertPage(label) {
    await page.locator('#counterpart-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#workspace').isVisible(), false, `${label}: conversation is not behind or alongside the intake`);
    assert.equal(await page.locator('#counterpart-directory').isVisible(), false, `${label}: directory is hidden`);
    assert.equal(await page.locator('#field-coach').isVisible(), false, `${label}: coach is hidden`);
    assert.equal(await page.locator('#counterpart-dialog').evaluate((element) => element.parentElement.id), 'main', `${label}: intake is a main page, not a chat-thread card`);
    assert.equal(await page.locator('#counterpart-dialog').getAttribute('aria-modal'), null);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'intake-alias');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no horizontal overflow`);
    const scan = await page.evaluate(() => window.axe.run());
    report.scans.push({ label, violations: scan.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) })) });
    assert.deepEqual(scan.violations.map(({ id }) => id), [], `${label}: accessibility`);
    await page.screenshot({ path: join(evidenceDir, `${label}.png`), fullPage: true });
  }
  await page.goto(origin); await ready(original.id);
  const chatDraft = '打开新页面之前没有提交的聊天草稿。';
  await page.locator('#message-text').fill(chatDraft);
  await page.locator('#message-speaker').selectOption('self');

  for (const [width, height] of [[1280, 720], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['day', 'night']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
      const opener = width === 1280 ? '#directory-add' : '#add-counterpart';
      await page.locator(opener).click(); await assertPage(`${width}-${theme}`);
      await page.locator('#intake-alias').fill(`草稿-${width}-${theme}`);
      await page.locator('#intake-channel').selectOption('offline');
      await page.locator('#intake-offline').fill('在虚构的读书活动上认识。');
      assert.equal(await page.locator('#intake-app').isVisible(), false);
      await page.locator('#close-counterpart-dialog').click(); await ready(original.id);
      assert.equal(await page.evaluate(() => document.activeElement.id), opener.slice(1), 'Back restores its entry point');
      assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
      assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
      await page.locator(opener).click();
      assert.equal(await page.locator('#intake-alias').inputValue(), `草稿-${width}-${theme}`, 'Back keeps unfinished intake details');
      assert.equal(await page.locator('#intake-offline').inputValue(), '在虚构的读书活动上认识。');
      await page.locator('#cancel-counterpart-dialog').click(); await ready(original.id);
      assert.equal(await page.locator('#message-text').inputValue(), chatDraft, 'Cancel never discards a chat draft');
      await page.locator(opener).click();
      assert.equal(await page.locator('#intake-alias').inputValue(), '', 'Cancel discards only the intake draft');
      await page.locator('#close-counterpart-dialog').click();
    }
  }
  report.cases.push('Desktop, 390px and 320px day/night intake pages replace chat, directory and coach; back retains intake and chat drafts, cancel clears only intake');

  await page.setViewportSize({ width: 1280, height: 720 });
  await openNewConversation(page);
  await page.locator('#intake-alias').fill('保存失败后重试的虚构对象');
  await page.locator('#intake-remark').fill('读书同好');
  await page.locator('#intake-channel').selectOption('app');
  await page.locator('#intake-app').fill('虚构资料：喜欢读书和散步。');
  await page.route(`${origin}/api/counterparts`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 503, json: { error: { code: 'TEST_INTAKE_FAILURE', message: '这次保存没有成功，请再试一次。' } } });
  });
  await submit().click(); await page.locator('#counterpart-form .form-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#counterpart-dialog').isVisible(), true);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#intake-alias').inputValue(), '保存失败后重试的虚构对象');
  assert.equal(await page.locator('#intake-app').inputValue(), '虚构资料：喜欢读书和散步。');
  assert.equal((await server.betaStore.listCounterparts(owner.id)).length, 1, 'Failed save creates no record');
  await page.unroute(`${origin}/api/counterparts`);
  const created = (await saved('/api/counterparts', 'POST', () => submit().click())).counterpart;
  await ready(created.id); assert.equal(await page.locator('#counterpart-dialog').isVisible(), false);
  assert.equal(await page.locator('#counterpart-title').textContent(), '读书同好');
  assert.equal(await page.locator('#message-text').inputValue(), '', 'A newly added conversation has its own composer');
  await select(original.id); assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
  report.cases.push('Save failure stays on the page with all fields; successful retry creates once and opens the new chat while retaining the prior chat draft');

  await menu('#edit-counterpart'); await assertPage('edit-existing');
  assert.equal(await page.locator('#intake-alias').inputValue(), original.alias);
  await page.locator('#intake-remark').fill('原对象的新备注');
  await saved(`/api/counterparts/${original.id}`, 'PUT', () => submit().click()); await ready(original.id);
  await page.waitForFunction(() => document.getElementById('counterpart-title').textContent === '原对象的新备注');
  assert.equal(await page.locator('#counterpart-title').textContent(), '原对象的新备注');
  assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
  report.cases.push('Editing background uses the same standalone page and returns to the same conversation without clearing its draft');

  await menu('#edit-counterpart');
  await page.locator('#intake-remark').fill('详情刷新失败仍已保存的备注');
  const originalPath = `${origin}/api/counterparts/${original.id}`;
  let editWrites = 0;
  const trackEdits = (request) => { if (request.url() === originalPath && request.method() === 'PUT') editWrites++; };
  page.on('request', trackEdits);
  await page.route(originalPath, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 503, json: { error: { code: 'TEST_DETAIL_FAILURE', message: '合成详情刷新失败' } } });
  });
  await saved(`/api/counterparts/${original.id}`, 'PUT', () => submit().click());
  await page.locator('#retry-counterpart').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#counterpart-dialog').isVisible(), false);
  assert.equal((await server.betaStore.getCounterpart(owner.id, original.id)).remark, '详情刷新失败仍已保存的备注');
  await page.unroute(originalPath);
  await saved(`/api/counterparts/${original.id}`, 'GET', () => page.locator('#retry-counterpart').click());
  await ready(original.id);
  assert.equal(await page.locator('#counterpart-title').textContent(), '详情刷新失败仍已保存的备注');
  assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
  assert.equal(editWrites, 1, 'Retry only rereads the conversation, without repeating the successful update');
  page.off('request', trackEdits);
  report.cases.push('A successful edit followed by failed detail read shows retry and recovers without a second write or losing the chat draft');

  await openNewConversation(page);
  await page.locator('#intake-alias').fill('目录刷新失败但已保存的对象');
  let failedDirectoryReads = 0;
  await page.route(`${origin}/api/counterparts`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    failedDirectoryReads++;
    await route.fulfill({ status: 503, json: { error: { code: 'TEST_DIRECTORY_FAILURE', message: '合成目录刷新失败' } } });
  });
  const directoryFailure = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/counterparts' && response.request().method() === 'GET' && response.status() === 503);
  const savedDespiteDirectoryFailure = (await saved('/api/counterparts', 'POST', () => submit().click())).counterpart;
  await directoryFailure; await ready(savedDespiteDirectoryFailure.id);
  assert.equal(await page.locator('#counterpart-dialog').isVisible(), false);
  assert.equal(await page.locator('#counterpart-title').textContent(), '目录刷新失败但已保存的对象');
  assert.equal((await server.betaStore.listCounterparts(owner.id)).filter(({ alias }) => alias === '目录刷新失败但已保存的对象').length, 1);
  assert.ok(failedDirectoryReads > 0, 'The fixture exercised the failed follow-up directory read');
  assert.equal(await page.locator('#notice').filter({ hasText: '合成目录刷新失败' }).isVisible(), false, 'An auxiliary read cannot relabel a successful save as a failure');
  await page.unroute(`${origin}/api/counterparts`);
  report.cases.push('A successful write opens the new conversation even when the follow-up directory GET fails, without duplicate creation');

  await openNewConversation(page);
  await page.locator('#intake-alias').fill('读取挂起的已保存对象');
  const readGate = new Promise((resolve) => { releaseHeldRead = resolve; });
  const heldPath = `${origin}/api/counterparts/*`;
  await page.route(heldPath, async (route) => {
    if (route.request().method() !== 'GET' || !/^\/api\/counterparts\/[^/]+$/.test(new URL(route.request().url()).pathname)) return route.fallback();
    const received = await route.fetch(); await readGate; await route.fulfill({ response: received });
  });
  const pendingRead = page.waitForRequest((request) => request.method() === 'GET' && /^\/api\/counterparts\/[^/]+$/.test(new URL(request.url()).pathname));
  const savedBeforeRead = (await saved('/api/counterparts', 'POST', () => submit().click())).counterpart;
  await pendingRead;
  await openNewConversation(page);
  await page.locator('#intake-alias').fill('后来打开的新对象草稿');
  await page.locator('#intake-background').fill('旧对象读取完成后也必须保留这段内容。');
  const completedRead = page.waitForResponse((response) => response.url() === `${origin}/api/counterparts/${savedBeforeRead.id}` && response.request().method() === 'GET');
  releaseHeldRead(); releaseHeldRead = null; await completedRead;
  await page.waitForFunction(() => !document.querySelector('#counterpart-form button[type=submit]').disabled);
  assert.equal(await page.locator('#counterpart-dialog').isVisible(), true);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#intake-alias').inputValue(), '后来打开的新对象草稿');
  assert.equal(await page.locator('#intake-background').inputValue(), '旧对象读取完成后也必须保留这段内容。');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'intake-background', 'A late detail read never focuses the hidden composer');
  assert.equal(await page.locator('#delete-counterpart').isVisible(), false, 'The newer add page never becomes an editor for the previous saved object');
  await page.unroute(heldPath);
  await page.locator('#cancel-counterpart-dialog').click();
  await select(original.id); assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
  report.cases.push('A delayed post-save detail response cannot replace or steal focus from a reopened add page');

  // All account/background forms replace the chat. None may share its scroll
  // region or leave an invisible chat control as the keyboard target.
  const auxiliaryEntries = [
    { id: 'profile-view', entry: '[data-view=profile]', focus: 'profile-background' },
    { id: 'meeting-panel', entry: '#open-meeting', focus: 'meeting-kind' },
    { id: 'heat-panel', entry: '#open-heat', focus: 'heat-title' },
    { id: 'admin-view', entry: '#admin-nav', focus: 'admin-title' },
  ];
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    for (const theme of ['day', 'night']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
      for (const entry of auxiliaryEntries) {
        await menu(entry.entry);
        await page.locator(`#${entry.id}`).waitFor({ state: 'visible' });
        assert.equal(await page.locator(`#${entry.id}`).evaluate((node) => node.parentElement.id), 'main');
        assert.equal(await page.locator('#workspace').isVisible(), false, `${entry.id}: chat is replaced`);
        assert.equal(await page.locator('#counterpart-directory').isVisible(), false);
        assert.equal(await page.locator('#field-coach').isVisible(), false);
        assert.equal(await page.locator('#chat-thread').locator(`#${entry.id}`).count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.id), entry.focus);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${entry.id}/${width}/${theme}: no overflow`);
        if (entry.id === 'profile-view') await page.locator('#profile-background').fill('尚未保存的个人背景草稿');
        if (entry.id === 'meeting-panel') {
          await page.locator('#meeting-kind').selectOption('proposed');
          await page.locator('#meeting-time').fill('周六 19:00');
          await page.locator('#meeting-place').fill('虚构读书咖啡馆');
        }
        const scan = await page.evaluate(() => window.axe.run());
        report.scans.push({ label: `${entry.id}-${width}-${theme}`, violations: scan.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) })) });
        assert.deepEqual(scan.violations.map(({ id }) => id), [], `${entry.id}/${width}/${theme}: accessibility`);
        if (width !== 320) await page.screenshot({ path: join(evidenceDir, `${entry.id}-${width}-${theme}.png`), fullPage: true });
        await page.locator(`[data-close=${entry.id}]`).click(); await ready(original.id);
        assert.equal(await page.evaluate(() => document.activeElement.matches('#chat-menu > summary')), true, 'Back restores the visible menu entry');
        assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
        assert.equal(await page.locator('#message-speaker').inputValue(), 'self');
      }
      await menu('[data-view=profile]');
      assert.equal(await page.locator('#profile-background').inputValue(), '尚未保存的个人背景草稿');
      await returnToConversation(page);
      await menu('#open-meeting');
      assert.equal(await page.locator('#meeting-time').inputValue(), '周六 19:00');
      assert.equal(await page.locator('#meeting-place').inputValue(), '虚构读书咖啡馆');
      await returnToConversation(page);
    }
  }
  report.cases.push('Profile, meeting, heat and administration use standalone pages in 1280/390/320 day/night layouts; return restores menu focus and retains form/chat drafts');

  await page.setViewportSize({ width: 1280, height: 900 });
  const profileSubmit = () => page.locator('#profile-form > button[type=submit]').click();
  const meetingSubmit = () => page.locator('#meeting-form > button[type=submit]').click();
  for (const form of [
    { entry: '[data-view=profile]', pageId: 'profile-view', formId: 'profile-form', path: '/api/profile', input: '#profile-background', value: '资料失败后保留的修正', submit: profileSubmit },
    { entry: '#open-meeting', pageId: 'meeting-panel', formId: 'meeting-form', path: `/api/counterparts/${original.id}/meeting`, input: '#meeting-time', value: '周六 20:00', submit: meetingSubmit },
  ]) {
    await menu(form.entry); await page.locator(form.input).fill(form.value);
    const url = origin + form.path;
    await page.route(url, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      await route.fulfill({ status: 503, json: { error: { code: 'TEST_FORM_FAILURE', message: '这次保存没有成功，请再试一次。' } } });
    });
    await form.submit(); await page.locator(`#${form.formId} .form-error`).waitFor({ state: 'visible' });
    assert.equal(await page.locator(`#${form.pageId}`).isVisible(), true);
    assert.equal(await page.locator(form.input).inputValue(), form.value);
    assert.equal(await page.locator('#workspace').isVisible(), false);
    await page.unroute(url);
    await saved(form.path, 'PUT', form.submit); await ready(original.id);
    assert.equal(await page.locator(`#${form.pageId}`).isVisible(), false, 'A completed save returns to chat');
    assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
  }
  assert.equal((await server.betaStore.getProfile(owner.id)).background, '资料失败后保留的修正');
  assert.equal((await server.betaStore.getMeeting(owner.id, original.id)).time, '周六 20:00');
  report.cases.push('Profile and meeting failed saves retain editable pages; retry persists the correction once and returns to the untouched chat draft');

  // A completed request is not navigation authority after the user has left.
  for (const delayed of [
    { entry: '[data-view=profile]', path: '/api/profile', input: '#profile-background', value: '迟到保存的个人背景', submit: profileSubmit, nextEntry: '#open-meeting', nextPage: 'meeting-panel', nextInput: '#meeting-note' },
    { entry: '#open-meeting', path: `/api/counterparts/${original.id}/meeting`, input: '#meeting-time', value: '周六 21:00', submit: meetingSubmit, nextEntry: '[data-view=profile]', nextPage: 'profile-view', nextInput: '#profile-growth' },
  ]) {
    await menu(delayed.entry); await page.locator(delayed.input).fill(delayed.value);
    let acceptedResolve;
    const accepted = new Promise((resolve) => { acceptedResolve = resolve; });
    const gate = new Promise((resolve) => { releaseHeldRead = resolve; });
    const url = origin + delayed.path;
    await page.route(url, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const response = await route.fetch(); acceptedResolve(); await gate; await route.fulfill({ response });
    });
    await delayed.submit(); await accepted;
    await returnToConversation(page); await menu(delayed.nextEntry);
    await page.locator(delayed.nextInput).fill('后打开页面正在写的草稿');
    const completed = page.waitForResponse((response) => response.url() === url && response.request().method() === 'PUT');
    releaseHeldRead(); releaseHeldRead = null; await completed;
    await page.waitForFunction(() => ![...document.querySelectorAll('#profile-form > button[type=submit], #meeting-form > button[type=submit]')].some((button) => button.disabled));
    assert.equal(await page.locator(`#${delayed.nextPage}`).isVisible(), true);
    assert.equal(await page.locator(delayed.nextInput).inputValue(), '后打开页面正在写的草稿');
    assert.equal(await page.evaluate(() => document.activeElement.id), delayed.nextInput.slice(1));
    assert.equal(await page.locator('#workspace').isVisible(), false);
    await page.unroute(url); await returnToConversation(page); await ready(original.id);
    assert.equal(await page.locator('#message-text').inputValue(), chatDraft);
  }
  report.cases.push('Delayed profile and meeting saves cannot close a newly opened form, steal focus or erase its draft');

  // Administrative results are sensitive even when their source page is
  // hidden: a response from the previous session must not refill that DOM.
  await menu('#admin-nav');
  await page.locator('#admin-view .auxiliary-page-body > details > summary').click();
  let inviteAcceptedResolve;
  const inviteAccepted = new Promise((resolve) => { inviteAcceptedResolve = resolve; });
  const inviteGate = new Promise((resolve) => { releaseHeldRead = resolve; });
  const inviteUrl = `${origin}/api/admin/invites`;
  await page.route(inviteUrl, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch(); inviteAcceptedResolve(); await inviteGate; await route.fulfill({ response });
  });
  await page.locator('#invite-form button[type=submit]').click(); await inviteAccepted;
  await returnToConversation(page); await menu('#logout');
  await page.locator('#auth').waitFor({ state: 'visible' });
  await page.locator('#username').fill('intake-empty'); await page.locator('#password').fill('SyntheticIntake2026');
  await saved('/api/login', 'POST', () => page.locator('#auth-submit').click());
  await page.locator('#empty-add').waitFor({ state: 'visible' });
  const inviteDelivered = page.waitForResponse((response) => response.url() === inviteUrl && response.request().method() === 'POST');
  releaseHeldRead(); releaseHeldRead = null; await inviteDelivered;
  await page.waitForFunction(() => !document.querySelector('#invite-form button[type=submit]').disabled);
  assert.equal(await page.locator('#generated-invite').inputValue(), '');
  assert.equal(await page.locator('#invite-result').isVisible(), false);
  assert.equal(await page.locator('#admin-view').isVisible(), false);
  assert.equal(await page.locator('#admin-nav').isVisible(), false);
  await page.unroute(inviteUrl);
  report.cases.push('A late administrative invite result cannot repopulate hidden owner data after switching accounts');

  const emptySession = await server.betaStore.createSession(emptyAccount.id);
  await context.addCookies([{ name: 'chat_coach_session', value: emptySession.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  await page.reload(); await page.locator('#empty-add').waitFor({ state: 'visible' });
  await page.locator('#empty-add').click(); await assertPage('first-counterpart');
  await page.locator('#intake-alias').fill('第一位虚构对象');
  const first = (await saved('/api/counterparts', 'POST', () => submit().click())).counterpart;
  await ready(first.id); assert.equal(await page.locator('#empty-state').isVisible(), false);
  report.cases.push('The empty-state entry also opens the standalone page and starts the first conversation');

  assert.deepEqual(report.modelRequests, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  report.passed = true; report.browser = browser.version();
  await writeFile(join(evidenceDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  releaseHeldRead?.();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true });
}
