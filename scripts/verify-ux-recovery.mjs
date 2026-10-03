import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { seedOwner } from '../src/beta-store.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Real UI and persistence, held local responses, synthetic identities/providers.
// No credentials, paid provider calls or operator demo data are used.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-ux-recovery-'));
let server, browser;
const report = { checks: [], paidProviderCalls: 0 };
try {
  const knowledgePath = join(directory, 'knowledge.md');
  await writeFile(knowledgePath, await readFile(DEFAULT_KNOWLEDGE_PATH));
  let replies = 0, otherModelCalls = 0;
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, webDir: join(process.cwd(), 'web'),
    replyFn: async () => { replies++; return { action: 'reply', reply: '合成回复原文。', reason: 'Synthetic.', styleNote: 'Synthetic.' }; },
    classifyFn: async () => { otherModelCalls++; throw new Error('Unexpected automatic classification'); },
  });
  const password = 'SyntheticPassword2026';
  const owner = await seedOwner(server.betaStore, { username: 'ux-owner', password });
  const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' }).invite;
  const otherUser = await server.betaStore.register({ username: 'ux-second', password, invite });
  function seedPerson(user, alias, count = 3) {
    const person = server.betaStore.putCounterpart(user.id, { alias, remark: '', channel: 'other', appProfile: '', offlineScene: '', background: '', rounds: null });
    for (let index = 0; index < count; index++) server.betaStore.putMessage(user.id, person.id, { speaker: 'other', text: `${alias}的合成消息${index + 1}` });
    return person;
  }
  const a = seedPerson(owner, '对象 A'), b = seedPerson(owner, '对象 B'), c = seedPerson(owner, '对象 C');
  const secondPerson = seedPerson(otherUser, '第二账号对象');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  const readDetail = (id) => page.waitForResponse((response) => response.url() === `${origin}/api/counterparts/${id}` && response.request().method() === 'GET');
  async function ready(id) { await page.waitForFunction((id) => document.getElementById('counterpart-select').value === id && !document.getElementById('message-text').disabled, id); }
  async function select(id) { const response = readDetail(id); await page.locator('#counterpart-select').selectOption(id); await response; await ready(id); }
  async function menu(selector) { if (!await page.locator(selector).isVisible()) await page.locator('#chat-menu > summary').click(); await page.locator(selector).click(); }
  async function login(user) {
    await page.locator('#username').fill(user.username); await page.locator('#password').fill(password); await page.locator('#auth-submit').click();
    await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  }
  async function switchAccount(user) { await menu('#logout'); await page.locator('#auth').waitFor({ state: 'visible' }); await login(user); }
  async function editFirst() {
    const message = page.locator('.message').first(); const id = await message.getAttribute('data-message-id');
    await message.locator('.message-menu > summary').click(); await message.getByRole('button', { name: /^编辑/ }).click();
    return id;
  }
  async function deleteMessage(id) {
    const message = page.locator(`[data-message-id="${id}"]`);
    await message.locator('.message-menu > summary').click(); await message.getByRole('button', { name: '删除这条消息' }).click();
  }
  async function holdDelete(id, messageId, { fail = false, beforeWrite = false } = {}) {
    const url = `${origin}/api/counterparts/${id}${messageId ? `/messages/${messageId}` : ''}`;
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const handler = async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      let response;
      if (!fail && !beforeWrite) response = await route.fetch();
      entered(); await gate;
      if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_DELETE_FAILED', message: '合成删除失败' } }) });
      response ||= await route.fetch();
      await route.fulfill({ response });
    };
    await page.route(url, handler);
    return { started, async finish() { const response = page.waitForResponse((r) => r.url() === url && r.request().method() === 'DELETE'); release(); await response; await page.unroute(url, handler); } };
  }

  await page.goto(origin); await login(owner); await select(a.id);
  await page.locator('#message-text').fill('编辑前的新消息草稿。');
  const first = await editFirst();
  const deleted = page.waitForResponse((response) => response.url().endsWith(`/messages/${first}`) && response.request().method() === 'DELETE');
  await deleteMessage(first); await deleted;
  await page.locator(`[data-message-id="${first}"]`).waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.getElementById('message-text').value === '编辑前的新消息草稿。' && document.getElementById('cancel-message-edit').hidden);
  assert.equal(await page.locator('#save-message').textContent(), '记录消息');
  assert.equal(server.betaStore.listMessages(owner.id, a.id).some(({ id }) => id === first), false);
  report.checks.push('deleting edited message restores the pre-edit draft');

  const second = await editFirst(); await page.locator('#message-text').fill('未保存的编辑。');
  const heldMessage = await holdDelete(a.id, second); await deleteMessage(second); await heldMessage.started;
  await select(b.id); await page.locator('#message-text').fill('B 的新草稿。');
  await heldMessage.finish();
  assert.equal(await page.locator('#counterpart-select').inputValue(), b.id);
  assert.equal(await page.locator('#message-text').inputValue(), 'B 的新草稿。');
  await select(a.id);
  assert.equal(await page.locator('#message-text').inputValue(), '编辑前的新消息草稿。');
  assert.equal(await page.locator('#cancel-message-edit').isVisible(), false);
  report.checks.push('late message deletion preserves B and clears A edit state on return');

  const remaining = await editFirst(); await page.locator('#message-text').fill('删除失败时保留的修改。');
  const failedMessage = await holdDelete(a.id, remaining, { fail: true }); await deleteMessage(remaining); await failedMessage.started; await failedMessage.finish();
  await page.waitForFunction(() => document.getElementById('notice').textContent === '合成删除失败');
  assert.equal(await page.locator('#message-text').inputValue(), '删除失败时保留的修改。');
  assert.equal(await page.locator('#save-message').textContent(), '保存修改');
  assert.ok(server.betaStore.listMessages(owner.id, a.id).some(({ id }) => id === remaining));
  await page.locator('#cancel-message-edit').click();
  report.checks.push('failed deletion keeps the message and edit draft');

  await select(b.id); await page.locator('#direct-reply').click();
  await page.waitForFunction(() => document.getElementById('suggestion-text').value === '合成回复原文。' && !document.getElementById('copy-reply').disabled);
  await page.locator('#suggestion-text').fill('B 的 AI 改写草稿。');
  await select(a.id); await menu('#edit-counterpart');
  const heldPerson = await holdDelete(a.id); await page.locator('#delete-counterpart').click(); await heldPerson.started;
  await select(b.id); await menu('#edit-counterpart'); await page.locator('#intake-background').fill('B 的背景草稿。');
  await heldPerson.finish();
  await page.waitForFunction((id) => !document.querySelector(`#counterpart-select option[value="${id}"]`), a.id);
  assert.equal(await page.locator('#counterpart-select').inputValue(), b.id);
  assert.equal(await page.locator('#counterpart-dialog').isVisible(), true);
  assert.equal(await page.locator('#intake-background').inputValue(), 'B 的背景草稿。');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'intake-background');
  await page.locator('#close-counterpart-dialog').click();
  assert.equal(await page.locator('#suggestion-text').inputValue(), 'B 的 AI 改写草稿。');
  await select(c.id); await select(b.id);
  assert.equal(await page.locator('#suggestion-text').inputValue(), 'B 的 AI 改写草稿。');
  assert.equal(await page.locator('#message-text').inputValue(), 'B 的新草稿。');
  assert.throws(() => server.betaStore.getCounterpart(owner.id, a.id), /NOT_FOUND/);
  report.checks.push('late counterpart deletion preserves B form, focus, message and AI drafts');

  // A detail response captured before DELETE must not resurrect a deleted object.
  await select(c.id); await menu('#edit-counterpart');
  const heldThird = await holdDelete(c.id, null, { beforeWrite: true }); await page.locator('#delete-counterpart').click(); await heldThird.started;
  await select(b.id);
  let releaseDetail, detailEntered;
  const detailGate = new Promise((resolve) => { releaseDetail = resolve; });
  const detailStarted = new Promise((resolve) => { detailEntered = resolve; });
  const detailUrl = `${origin}/api/counterparts/${c.id}`;
  const holdDetail = async (route) => { if (route.request().method() !== 'GET') return route.fallback(); const response = await route.fetch(); detailEntered(); await detailGate; await route.fulfill({ response }); };
  await page.route(detailUrl, holdDetail); await page.locator('#counterpart-select').selectOption(c.id); await detailStarted;
  await heldThird.finish(); await ready(b.id);
  const lateDetail = readDetail(c.id); releaseDetail(); await lateDetail; await page.unroute(detailUrl, holdDetail);
  assert.equal(await page.locator('#counterpart-select').inputValue(), b.id);
  assert.equal(await page.locator('#message-text').inputValue(), 'B 的新草稿。');
  assert.equal(await page.locator(`#counterpart-select option[value="${c.id}"]`).count(), 0);
  report.checks.push('pre-delete detail response cannot resurrect a removed counterpart');

  // Responses from the previous account must not alter the new account.
  const accountCases = [['message', true], ['counterpart', true], ['message', false], ['counterpart', false]];
  for (const [index, [operation, fail]] of accountCases.entries()) {
    const messageId = operation === 'message' ? await editFirst() : null;
    const held = await holdDelete(b.id, messageId, { fail });
    if (messageId) await deleteMessage(messageId);
    else { await menu('#edit-counterpart'); await page.locator('#delete-counterpart').click(); }
    await held.started; await switchAccount(otherUser); await ready(secondPerson.id);
    await page.locator('#message-text').fill(`第二账号草稿-${operation}`);
    await held.finish();
    assert.equal(await page.locator('#counterpart-select').inputValue(), secondPerson.id);
    assert.equal(await page.locator('#message-text').inputValue(), `第二账号草稿-${operation}`);
    assert.equal(await page.getByText('合成删除失败', { exact: true }).isVisible(), false);
    if (index < accountCases.length - 1) { await switchAccount(owner); await ready(b.id); }
  }
  report.checks.push('late deletion successes and failures do not alter another account or display its errors');
  assert.equal(replies, 1); assert.equal(otherModelCalls, 0); assert.deepEqual(errors, []);
  report.syntheticReplyCalls = replies; report.passed = true;
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
