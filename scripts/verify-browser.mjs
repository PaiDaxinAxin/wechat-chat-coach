import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { seedOwner } from '../src/beta-store.mjs';
import { SOURCE_START, SOURCE_END, DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every((arg) => arg === '--https-proxy'), 'Usage: node scripts/verify-browser.mjs [--https-proxy]');
const httpsProxyMode = args.includes('--https-proxy');
process.umask(0o077);

async function listenLocal(server) {
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done); });
}
async function closeLocal(server) {
  if (server?.listening) await new Promise((done) => server.close(done));
}
async function localHttpsProxy(directory) {
  const keyPath = join(directory, 'localhost.key');
  const certPath = join(directory, 'localhost.crt');
  const configPath = join(directory, 'localhost.cnf');
  await writeFile(configPath, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', configPath, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  assert.equal(generated.status, 0, 'LOCAL_SELF_SIGNED_CERTIFICATE_GENERATION_FAILED');
  let upstreamPort;
  const server = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    if (!upstreamPort) { res.writeHead(503); return res.end('LOCAL_PROXY_NOT_READY'); }
    // The upstream is fixed loopback state, never a caller-provided URL or Host.
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, connection: 'close' } }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('LOCAL_PROXY_UPSTREAM_UNAVAILABLE'); });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  await listenLocal(server);
  return { server, origin: `https://127.0.0.1:${server.address().port}`, setUpstream(port) { upstreamPort = port; } };
}

async function rawLocalRequest(origin, headers) {
  const target = new URL(origin);
  assert.equal(target.hostname, '127.0.0.1', 'Security probes must stay on loopback');
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((done, failed) => {
    const req = request({ hostname: target.hostname, port: target.port, path: '/api/health', method: 'GET', headers, ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => done({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.once('error', failed);
    req.end();
  });
}

// Isolated synthetic fixture: no real identities, no provider credentials or paid calls.
const directory = await mkdtemp(join(tmpdir(), 'coach-browser-'));
const knowledgePath = join(directory, 'knowledge.md');
let server, proxy, browser;
try {
const originalKnowledge = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
await writeFile(knowledgePath, originalKnowledge);
if (httpsProxyMode) proxy = await localHttpsProxy(directory);
let classifications = 0, replies = 0;
const seenContexts = [];
server = await createBetaServer({
  dataDir: join(directory, 'data'), knowledgePath,
  ...(proxy ? { publicOrigin: proxy.origin } : {}),
  classifyFn: async (context, options) => {
    classifications++;
    assert.equal(options.knowledgeText, originalKnowledge);
    seenContexts.push(context);
    const ids = context.messages.map(({ id }) => id);
    const observed = { level: 'positive', evidenceIds: [ids.at(-1)] };
    return {
      status: 'ready', confidence: 'moderate', phase: 'ordinary',
      obstacle: { type: 'none', evidenceIds: [], reason: '双方在接同一个话题。' },
      heat: { activeInteraction: observed, responseEngagement: { level: 'positive', evidenceIds: [ids[0], ids.at(-1)] }, personalInterest: observed, reciprocalFlirting: { level: 'unknown', evidenceIds: [] }, actionFollowThrough: { level: 'unknown', evidenceIds: [] } },
      options: [['up', 0.6], ['down', 0.1], ['sideways', 0.3]].map(([topicMove, weight]) => ({ topicMove, weight, relationAction: 'continue', reason: '结合工作话题继续了解。', evidenceIds: [ids.at(-1)] })),
      uncertainties: ['没有线下安排的证据。'], recommendationKind: 'uncalibrated',
    };
  },
  replyFn: async ({ context, direction }, options) => {
    replies++;
    assert.ok(options.knowledgeText.startsWith(originalKnowledge));
    assert.equal(JSON.parse(context.userProfile).questionnaire.answers.length, 10);
    assert.equal(direction, 'down');
    return { reply: '最近哪个项目，让你最有成就感？', reason: '继续了解她已经展开的具体经历。', action: 'reply', styleNote: '保留直接简短的表达。' };
  },
});
const owner = await seedOwner(server.betaStore, { username: 'test-owner', password: 'SyntheticPassword2026' });
const paidInvite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'paid' }).invite;
await listenLocal(server);
proxy?.setUpstream(server.address().port);
const origin = proxy?.origin ?? `http://127.0.0.1:${server.address().port}`;
browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, ignoreHTTPSErrors: httpsProxyMode });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const evidenceDir = join(process.cwd(), httpsProxyMode ? 'runs/browser-beta-https' : 'runs/browser-beta');
await mkdir(evidenceDir, { recursive: true });
async function waitRequest(suffix, method, action) {
  const response = page.waitForResponse((response) => response.url().endsWith(suffix) && response.request().method() === method);
  await action();
  const value = await response;
  const payload = await value.json();
  assert.equal(value.status(), 200, JSON.stringify(payload));
  return payload.data;
}
async function menuAction(selector) {
  if (!await page.locator(selector).isVisible()) await page.locator('#chat-menu > summary').click();
  await page.locator(selector).click();
}
async function login(username, password) {
  await page.locator('#login-tab').click();
  await page.locator('#username').fill(username); await page.locator('#password').fill(password);
  await waitRequest('/api/login', 'POST', () => page.locator('#auth-submit').click());
  await page.locator('#workspace').waitFor({ state: 'visible' });
}
async function register(username, invite) {
  await page.locator('#register-tab').click();
  await page.locator('#invite').fill(invite);
  await page.locator('#username').fill(username); await page.locator('#password').fill('SyntheticPassword2026');
  await waitRequest('/api/register', 'POST', () => page.locator('#auth-submit').click());
  await page.locator('#profile-view').waitFor({ state: 'visible' });
}
async function verifySessionBoundaries() {
  const cookie = (await context.cookies(origin)).find(({ name }) => name === 'chat_coach_session');
  assert.ok(cookie, 'Browser has an actual session cookie');
  assert.equal(cookie.secure, httpsProxyMode, 'HTTPS proxy must issue a Secure cookie');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  const me = await context.request.get(`${origin}/api/me`);
  assert.equal(me.status(), 200, 'Browser cookie authenticates through the selected transport');
  const { data } = await me.json();
  assert.equal(data.user.username, 'test-owner');
  const cases = [
    [{ origin }, 'CSRF_INVALID'],
    [{ origin, 'x-csrf-token': 'wrong-token' }, 'CSRF_INVALID'],
    [{ origin: 'https://cross-origin.invalid', 'x-csrf-token': data.csrfToken }, 'ORIGIN_FORBIDDEN'],
    [{ 'x-csrf-token': data.csrfToken }, 'ORIGIN_FORBIDDEN'],
  ];
  for (const [headers, code] of cases) {
    const response = await context.request.post(`${origin}/api/logout`, { headers, data: {} });
    assert.equal(response.status(), 403);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal((await context.request.get(`${origin}/api/me`)).status(), 200, 'Rejected mutations preserve the session');
  const hostileHost = await rawLocalRequest(origin, { host: 'outside.invalid', origin });
  assert.equal(hostileHost.status, 403);
  assert.equal(hostileHost.body.error.code, 'HOST_FORBIDDEN');
  for (const path of ['/knowledge/game-system.md', '/package.json', '/src/coach.mjs', '/data/beta/beta.sqlite', '/data/beta/owner-access.json', '/.env']) {
    const response = await context.request.get(`${origin}${path}`);
    assert.equal(response.status(), 404, `Private path cannot be served: ${path}`);
    assert.equal((await response.text()).includes(SOURCE_START), false);
  }
}
async function profile(kind) {
  await page.locator('#profile-background').fill('匿名内测：普通设计工作，喜欢散步。');
  await page.locator('#profile-style').fill('说话直接、简短，不用夸张油腻的句子。');
  await page.locator('#profile-growth').fill('想练习自然地接话和表达兴趣。');
  await page.locator('#profile-goal').fill('先了解彼此，有共同兴趣再协商见面。');
  if (!await page.locator('#questionnaire-kind').isVisible()) await page.locator('.questionnaire-details > summary').click();
  await page.locator('#questionnaire-kind').selectOption(kind);
  const questions = page.locator('#questionnaire select');
  assert.equal(await questions.count(), kind === 'short' ? 10 : 30);
  for (const question of await questions.all()) await question.selectOption('4');
  await waitRequest('/api/profile', 'PUT', () => page.locator('#profile-form button[type=submit]').click());
  await page.locator('#profile-view').waitFor({ state: 'hidden' });
}
try {
  await page.goto(origin);
  await login('test-owner', 'SyntheticPassword2026');
  await verifySessionBoundaries();
  await menuAction('#admin-nav');
  await page.locator('#admin-view > details > summary').click();
  await waitRequest('/api/admin/invites', 'POST', () => page.locator('#invite-form button[type=submit]').click());
  await page.waitForFunction(() => document.getElementById('generated-invite').value.length > 10);
  const invite = await page.locator('#generated-invite').inputValue();
  await menuAction('#logout');
  await page.locator('#auth').waitFor({ state: 'visible' });
  await register('test-free', invite);
  const fullOption = await page.locator('#questionnaire-kind option[value=full]').evaluate((option) => ({ disabled: option.disabled, markup: option.outerHTML }));
  assert.equal(fullOption.disabled, true, JSON.stringify(fullOption));
  await profile('short');
  await page.locator('#add-counterpart').click();
  await page.locator('#intake-alias').fill('对象 A');
  await page.locator('#intake-app').fill('资料提到设计工作、城市散步和咖啡。');
  await page.locator('#intake-background').fill('交友软件认识，聊过两轮，未见面。');
  await page.locator('#intake-rounds').fill('2');
  const created = await waitRequest('/api/counterparts', 'POST', () => page.locator('#counterpart-form button[type=submit]').click());
  const id = created.counterpart.id;
  await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  for (const [speaker, text] of [['other', '最近一直在忙工作。'], ['self', '你是做设计方面的吗？'], ['other', '对，最近在做新项目。你平时下班喜欢做什么？']]) {
    await page.locator('#message-speaker').selectOption(speaker);
    await page.locator('#message-text').fill(text);
    await waitRequest(`/api/counterparts/${id}/messages`, 'POST', () => page.locator('#save-message').click());
    await page.locator('.message-bubble').filter({ hasText: text }).waitFor();
  }
  await waitRequest(`/api/counterparts/${id}/classify`, 'POST', () => page.locator('#classify').click());
  await page.locator('[data-direction=down]').waitFor();
  assert.equal(await page.locator('#direction-options button').count(), 3);
  assert.equal(classifications, 1);
  await waitRequest(`/api/counterparts/${id}/classify`, 'POST', () => page.locator('#classify').click());
  assert.equal(classifications, 1, 'replay must not invoke classifier');
  await page.locator('[data-direction=down]').click();
  await waitRequest(`/api/counterparts/${id}/reply`, 'POST', () => page.locator('#chosen-reply').click());
  await page.locator('#suggestion-panel').waitFor({ state: 'visible' });
  assert.equal(replies, 1);
  const sent = '最近哪个项目，让你挺有成就感的？';
  await page.locator('#suggestion-text').fill(sent);
  await waitRequest(`/api/counterparts/${id}/sent`, 'POST', () => page.locator('#record-sent').click());
  await page.locator('#sent-state').filter({ hasText: '已记录' }).waitFor();
  await page.locator('#reply-feedback').click();
  await page.locator('#feedback-kind').selectOption('positive');
  await page.locator('#feedback-reply').fill('上次做的店铺设计，花了不少心思。');
  await page.locator('#feedback-observation').fill('她展开了具体经历。这是匿名流程测试，不能证明真实效果。');
  await page.locator('#feedback-consent').check();
  await waitRequest(`/api/counterparts/${id}/feedback`, 'POST', () => page.locator('#feedback-form button[type=submit]').click());
  await page.locator('#feedback-state').filter({ hasText: '未清洗' }).waitFor();
  assert.equal(await readFile(knowledgePath, 'utf8'), originalKnowledge, 'raw feedback cannot update knowledge');
  await menuAction('#open-meeting');
  await page.locator('#meeting-kind').selectOption('confirmed');
  await page.locator('#meeting-time').fill('2026-10-03 19:00'); await page.locator('#meeting-place').fill('双方确认的示例咖啡店');
  await waitRequest(`/api/counterparts/${id}/meeting`, 'PUT', () => page.locator('#meeting-form button[type=submit]').click());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidenceDir, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mobile horizontal overflow');
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '320px horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidenceDir, 'desktop.png'), fullPage: true });
  await page.reload();
  await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#record-sent').isDisabled(), true, 'sent version persists after reload');
  await menuAction('#logout'); await page.locator('#auth').waitFor({ state: 'visible' });
  await register('test-paid', paidInvite); await profile('full');
  assert.equal(await page.locator('#counterpart-select option:not([value=""])').count(), 0, 'second account cannot see first account object');
  await menuAction('#logout'); await page.locator('#auth').waitFor({ state: 'visible' });
  await login('test-owner', 'SyntheticPassword2026');
  await menuAction('#admin-nav');
  await page.locator('.feedback-review').waitFor();
  await waitRequest('/clean', 'POST', () => page.getByRole('button', { name: '清洗这条反馈' }).click());
  const review = page.locator('.feedback-review');
  await review.getByPlaceholder('这条经验适用于什么情境？').fill('双方围绕工作互相提问的匿名流程测试。');
  await review.getByPlaceholder('证据局限、例外或不适用情况').fill('仅为内测流程样例，不代表真实聊天效果，不构成因果证据。');
  await waitRequest('/review', 'POST', () => page.getByRole('button', { name: '批准指定用途' }).click());
  const updatedKnowledge = await readFile(knowledgePath, 'utf8');
  assert.ok(updatedKnowledge.startsWith(originalKnowledge));
  assert.ok(updatedKnowledge.includes('Reviewed feedback candidate'));
  const sourceBody = (text) => text.split(SOURCE_START)[1].split(SOURCE_END)[0];
  assert.equal(sourceBody(updatedKnowledge), sourceBody(originalKnowledge));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(JSON.parse(seenContexts[0].userProfile).questionnaire.answers.length, 10);
  await menuAction('#logout'); await page.locator('#auth').waitFor({ state: 'visible' });
  await login('test-free', 'SyntheticPassword2026');
  await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
  await menuAction('#edit-counterpart');
  page.once('dialog', (dialog) => dialog.accept());
  await waitRequest(`/api/counterparts/${id}`, 'DELETE', () => page.locator('#delete-counterpart').click());
  await page.locator('#counterpart-workspace').waitFor({ state: 'hidden' });
  assert.equal(server.betaStore.listCounterparts(server.betaStore.listUsers(owner.id).find(({ username }) => username === 'test-free').id).length, 0);
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ passed: true, synthetic: true, actualProviderCalls: 0, transport: httpsProxyMode ? 'local-self-signed-https-proxy' : 'local-http', publicAccessVerified: false, browser: browser.version(), checks: ['session cookie attributes and authenticated transport', 'same-origin and CSRF rejection', 'Host rejection', 'private paths unavailable', 'invite registration', 'short/full questionnaires', 'counterpart intake', 'conversation', 'classification replay', 'lower-weight choice', 'editable reply', 'manual sent persistence', 'raw isolation', 'meeting confirmation', 'mobile layout at 390px and 320px', 'account isolation', 'clean-review-knowledge append', 'source preservation', 'counterpart deletion'], classifications, replies, pageErrors }, null, 2) + '\n');
  console.log(`Browser beta journey passed (${httpsProxyMode ? 'local self-signed HTTPS proxy' : 'local HTTP'}): registration → profile → conversation → direction → edited sent version → feedback → owner review, including cookie/origin/CSRF/Host/private-path checks. Zero paid model calls; public access is not verified.`);
} catch (error) {
  await page.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
}
} finally {
  await browser?.close();
  await closeLocal(proxy?.server);
  await closeLocal(server);
  await rm(directory, { recursive: true, force: true });
}
