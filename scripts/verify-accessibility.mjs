import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axe from 'axe-core';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// First-party browser scans use only fictional data, injected mock models and
// an empty provider environment. The owner's local demo and credentials are not read.
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-accessibility-'));
const evidenceDir = join(process.cwd(), 'runs/accessibility');
const report = { passed: false, synthetic: true, actualProviderCalls: 0, emailCalls: 0,
  engine: { name: 'axe-core', version: axe.version, rules: 'all default rules; no exclusions or disabled rules' },
  scans: [], keyboardChecks: [], iconContrast: [], pageErrors: [], externalRequests: [],
  mockCalls: { classification: 0, reply: 0, plan: 0 } };
let server, browser;

function summarizeRule(rule) {
  return { id: rule.id, impact: rule.impact, description: rule.description, help: rule.help, helpUrl: rule.helpUrl,
    tags: rule.tags, nodes: rule.nodes.map(({ target, html, failureSummary, any, all, none }) => ({ target, html, failureSummary,
      checks: [...any, ...all, ...none].map(({ id, message, data }) => ({ id, message, data })) })) };
}
function deferred() {
  let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve };
}

try {
  await mkdir(evidenceDir, { recursive: true });
  const knowledge = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md'); await writeFile(knowledgePath, knowledge);
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, localDemoMode: true, providerEnv: {},
    classifyFn: async (context, options) => {
      report.mockCalls.classification++; assert.equal(options.knowledgeText, knowledge);
      const id = context.messages.at(-1).id;
      const observed = { level: 'positive', evidenceIds: [...new Set([context.messages.find(({ speaker }) => speaker === 'other').id, id])] };
      return { status: 'ready', confidence: 'moderate', phase: 'ordinary',
        obstacle: { type: 'none', evidenceIds: [], reason: '虚构对方主动延续项目话题。' },
        heat: { activeInteraction: observed, responseEngagement: observed, personalInterest: observed,
          reciprocalFlirting: { level: 'unknown', evidenceIds: [] }, actionFollowThrough: { level: 'unknown', evidenceIds: [] } },
        topicDecision: { mode: 'change', reason: '合成换题局面，用于三方向与并发回归。' },
        options: [['up', .6], ['down', .1], ['sideways', .3]].map(([topicMove, weight]) => ({ topicMove, weight,
          relationAction: 'continue', reason: '顺着虚构项目了解一处细节。', evidenceIds: [id] })),
        uncertainties: ['对方是否愿意见面未知。'], recommendationKind: 'uncalibrated',
        fieldCoach: { currentTopic: '工作与新项目', topicStatus: 'developing', topicMessageIds: [id],
          initiative: '先接住新项目，再分享自己的真实经历。', nextAction: '了解一处具体细节。',
          warmingLayer: 'none', pitfall: '不要把未知意愿当成已经同意。', reason: '虚构对方仍在自然展开话题。' } };
    },
    replyFn: async ({ context }, options) => {
      report.mockCalls.reply++; assert.equal(options.knowledgeText, knowledge);
      assert.equal(JSON.parse(context.userProfile).questionnaire.answers.length, 10);
      return { reply: '我做产品设计。你这个项目具体在做什么？', reason: '回答问题，再了解项目细节。', action: 'reply', styleNote: '简短、自然的虚构回复。' };
    },
    planFn: async ({ context }, options) => {
      report.mockCalls.plan++; assert.equal(options.knowledgeText, knowledge);
      return { verdict: 'suitable', reason: '先分享经历，再提问一处细节。',
        timingSuggestion: { status: 'after_response', guidance: '等对方展开当前话题后，再分享自己的经历。', evidenceIds: [context.messages.at(-1).id] },
        nextAction: '先承接对方当前回应，再考虑自然升温。' };
    },
  });
  await server.ensureDemoSeed();
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  report.browser = browser.version();

  for (const width of [1280, 320]) for (const theme of ['day', 'night']) {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 844 : 950 }, reducedMotion: 'reduce' });
    await context.addInitScript({ content: axe.source });
    await context.addInitScript((chosen) => localStorage.setItem('chat-coach-theme', chosen), theme);
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      report.externalRequests.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    let modelRequests = 0;
    page.on('request', (request) => { if (request.method() === 'POST' && /\/(classify|reply|coach-plan)$/.test(new URL(request.url()).pathname)) modelRequests++; });
    const stateName = (name) => `${width}-${theme}-${name}`;
    async function scan(name) {
      const result = await page.evaluate(() => window.axe.run(document));
      const entry = { state: stateName(name), viewport: { width, height: width === 320 ? 844 : 950 }, theme,
        violations: result.violations.map(summarizeRule), incomplete: result.incomplete.map(summarizeRule),
        passes: result.passes.length, inapplicable: result.inapplicable.length };
      report.scans.push(entry);
      await writeFile(join(evidenceDir, `${entry.state}.json`), JSON.stringify(entry, null, 2) + '\n');
      if (entry.violations.length) await page.screenshot({ path: join(evidenceDir, `${entry.state}.png`), fullPage: true });
      if (name === 'coach-dialog') await page.screenshot({ path: join(evidenceDir, `${entry.state}-current.png`), fullPage: true });
      console.log(`${entry.state}: ${entry.violations.length} violations, ${entry.incomplete.length} manual-review rules`);
    }
    async function response(path, action) {
      const pending = page.waitForResponse((received) => new URL(received.url()).pathname === path && received.request().method() === 'POST');
      pending.catch(() => {});
      await action(); const received = await pending; assert.equal(received.status(), 200); return (await received.json()).data;
    }
    async function openCoach() { if (!await page.locator('#field-coach').isVisible()) await page.locator('#toggle-field-coach').click(); }
    async function menuItem(selector) { await page.locator('#chat-menu > summary').click(); await page.locator(selector).click(); }
    async function assertCoachClosed(step) {
      await page.waitForFunction(() => document.activeElement.id === 'toggle-field-coach')
        .catch(() => { throw new Error(`${step}: coach trigger focus did not settle`); });
      assert.equal(await page.locator('#field-coach').isVisible(), false);
      assert.equal(await page.locator('#workspace').evaluate((node) => node.inert), false);
      assert.equal(await page.locator('.skip-link').evaluate((node) => node.inert), false);
      assert.equal(await page.locator('#field-coach').getAttribute('aria-modal'), null);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle-field-coach', `${step} restores the visible coach trigger`);
    }
    try {
      await page.goto(origin); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
      await page.locator('#classify').evaluate((node) => { node.closest('details').open = true; });
      await page.locator('#classify').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-direction]').length === 3 && [...document.querySelectorAll('[data-direction]')].every((button) => !button.disabled));
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      await scan('conversation');
      const note = page.locator('.message-annotation').first();
      const beforeNoteRequests = modelRequests;
      await note.locator('summary').click();
      await note.locator('textarea').fill('合成线下背景，属于本人补充，不是原话。');
      await scan('message-annotation');
      await note.getByRole('button', { name: '收起', exact: true }).click();
      assert.equal(modelRequests, beforeNoteRequests, 'Reading and editing a note never invokes a model');
      const icons = await page.locator('.message-menu > summary').evaluateAll((nodes) => nodes.map((node) => {
        const rgb = (color) => color.match(/[\d.]+/g).map(Number);
        const luminance = (channels) => channels.slice(0, 3).map((value) => value / 255)
          .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        let parent = node, background;
        while (parent) {
          background = getComputedStyle(parent).backgroundColor;
          const channels = rgb(background);
          if (channels.length === 3 || channels[3] === 1) break;
          parent = parent.parentElement;
        }
        const style = getComputedStyle(node), foreground = style.color;
        const a = luminance(rgb(foreground)), b = luminance(rgb(background));
        return { label: node.getAttribute('aria-label'), glyph: node.textContent, foreground, background,
          opacity: style.opacity, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      }));
      assert.ok(icons.length > 0);
      for (const icon of icons) { assert.equal(icon.opacity, '1'); assert.ok(icon.ratio >= 4.5, `Message icon contrast ${icon.ratio.toFixed(2)}:1`); }
      report.iconContrast.push({ state: stateName('conversation'), icons });
      if (width === 1280) await page.locator('#transcript').screenshot({ path: join(evidenceDir, `${width}-${theme}-message-icons.png`) });
      const id = await page.locator('#counterpart-select').inputValue();
      const arrived = deferred(), release = deferred();
      await page.route(`**/api/counterparts/${id}/reply`, async (route) => {
        arrived.resolve(); await release.promise; await route.continue();
      });
      const pendingReply = page.waitForResponse((received) => received.url().endsWith(`/api/counterparts/${id}/reply`) && received.request().method() === 'POST');
      pendingReply.catch(() => {});
      await page.locator('[data-direction=down]').click(); await arrived.promise;
      try { await scan('reply-loading'); } finally { release.resolve(); }
      assert.equal((await pendingReply).status(), 200);
      await page.locator('#suggestion-panel[aria-busy=false]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.getElementById('suggestion-panel').classList.contains('reply-updated'));
      await page.unroute(`**/api/counterparts/${id}/reply`);
      await scan('reply-ready');
      assert.equal(await page.locator('#suggestion-history,#suggestion-list').count(), 0, 'Current advice has no archive entry');
      await page.locator('.suggestion-details > summary').click();
      await scan('reply-reason');
      await openCoach();
      if (width === 320) {
        assert.equal(await page.evaluate(() => document.activeElement.id), 'field-coach-title');
        assert.equal(await page.locator('#field-coach').getAttribute('role'), 'dialog');
        assert.equal(await page.locator('#field-coach').getAttribute('aria-modal'), 'true');
        assert.equal(await page.locator('#workspace').evaluate((node) => node.inert), true);
        assert.equal(await page.locator('.skip-link').evaluate((node) => node.inert), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'close-field-coach');
        const targets = await page.locator('#field-coach').evaluate((coach) => [...coach.querySelectorAll('button,a[href],input,textarea,select,summary,[tabindex]')]
          .filter((node) => !node.disabled && node.tabIndex >= 0 && node.checkVisibility()).length);
        for (let index = 0; index < targets + 1; index++) {
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.getElementById('field-coach').contains(document.activeElement)), true, 'Tab stays inside the mobile dialog');
        }
        await page.locator('#close-field-coach').focus(); await page.keyboard.press('Shift+Tab');
        assert.notEqual(await page.evaluate(() => document.activeElement.id), 'close-field-coach');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'close-field-coach', 'Reverse Tab reaches the final control and wraps back');
        await scan('coach-dialog');
        await page.keyboard.press('Escape'); await assertCoachClosed('Escape');
        await openCoach(); await page.locator('#close-field-coach').focus();
        await page.setViewportSize({ width: 1280, height: 950 });
        await page.waitForFunction(() => !document.getElementById('workspace').inert && !document.getElementById('field-coach').hasAttribute('aria-modal'));
        assert.equal(await page.evaluate(() => document.activeElement.id), 'field-coach-title');
        await page.setViewportSize({ width: 320, height: 844 });
        await page.waitForFunction(() => !document.getElementById('field-coach').checkVisibility());
        await assertCoachClosed('Returning to the narrow viewport'); await openCoach();
        report.keyboardChecks.push({ state: stateName('coach-dialog'), checks: ['initial title focus', 'Tab enters the close button', 'forward and reverse focus wrap', 'Escape restores trigger focus', 'breakpoint transition removes inert and dialog semantics'] });
      }
      await page.locator('#field-coach-details > summary').click();
      assert.equal(await page.locator('#coach-glossary-toggle,.coach-glossary').count(), 0);
      const coachNote = page.locator('#coach-glossary-terms [data-coach-term=up]');
      await coachNote.locator('summary').focus(); await page.keyboard.press('Enter');
      assert.equal(await coachNote.locator('summary').textContent(), '注 · 上切');
      assert.equal(await coachNote.locator('p').first().isVisible(), true, 'A currently mentioned term opens from the keyboard');
      await page.locator('#field-coach-plan').fill('先分享自己的项目，再了解对方的经历。');
      await response(`/api/counterparts/${id}/coach-plan`, () => page.locator('#field-coach-plan-submit').click());
      await page.locator('#field-coach-plan-result').filter({ hasText: '先分享经历' }).waitFor();
      const planNote = page.locator('#field-coach-plan-notes [data-coach-term=warming]');
      await planNote.waitFor();
      assert.equal(await planNote.getAttribute('open'), null, 'Generated plan footnotes start collapsed');
      assert.equal(await planNote.locator('summary').textContent(), '注 · 升温');
      await planNote.locator('summary').click();
      assert.equal(await planNote.locator('p').count(), 4, 'The full A/B/C explanation remains reachable');
      assert.equal(await planNote.locator('p').first().isVisible(), true);
      assert.equal(await page.locator('#coach-glossary-terms [data-coach-term=warming]').count(), 0, 'Plan advice has its own footnotes');
      await scan('coach-footnotes-and-plan');
      await page.locator('.style-entry > summary').click();
      await page.locator('#open-style-preferences').click();
      await page.locator('#style-rule-text').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#workspace').evaluate((node) => node.inert), false, 'Expression learning remains reachable after closing the mobile modal');
      assert.equal(await page.locator('#field-coach').getAttribute('aria-modal'), null);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'style-own-version');
      await page.locator('.questionnaire-details > summary').click();
      await scan('profile-and-expression-learning');
      await page.locator('[data-close=profile-view]').click();
      if (width === 320 && await page.locator('#field-coach').isVisible()) await page.locator('#close-field-coach').click();
      await menuItem('#open-meeting'); await page.locator('#meeting-panel').waitFor({ state: 'visible' });
      await page.locator('#meeting-kind').selectOption('confirmed'); await scan('meeting-form');
      await page.locator('[data-close=meeting-panel]').click();
      await page.locator('#add-counterpart').click(); await page.locator('#counterpart-form').waitFor({ state: 'visible' });
      await scan('counterpart-form');
      await page.locator('#intake-alias').fill(`虚构空聊-${width}-${theme}`);
      await page.locator('#intake-channel').selectOption('app');
      await page.locator('#intake-app').fill('仅供隔离可访问性验收的虚构资料。');
      await page.locator('#intake-background').fill('尚未录入对方消息。');
      const requestsBeforeEmpty = modelRequests, callsBeforeEmpty = { ...report.mockCalls };
      const empty = await response('/api/counterparts', () => page.locator('#counterpart-form button[type=submit]').click());
      await page.waitForFunction((id) => document.getElementById('counterpart-select').value === id &&
        !document.getElementById('message-text').disabled && document.getElementById('classification-summary').textContent.includes('粘贴对方'), empty.counterpart.id);
      assert.ok((await page.locator('#classification-summary').textContent()).includes('粘贴对方'));
      assert.equal(await page.locator('#classify').isDisabled(), true); assert.equal(await page.locator('#direct-reply').isDisabled(), true);
      for (const button of await page.locator('[data-direction]').all()) assert.equal(await button.isDisabled(), true);
      await scan('empty-conversation');
      assert.equal(modelRequests, requestsBeforeEmpty); assert.deepEqual(report.mockCalls, callsBeforeEmpty);
      await page.locator('#counterpart-select').selectOption(id);
      await page.waitForFunction(() => !document.getElementById('message-text').disabled);
      await page.route('**/api/me', async (route) => {
        const received = await route.fetch(); const body = await received.json(); body.data.profile.background = '';
        await route.fulfill({ response: received, json: body });
      });
      const requestsBeforeProfileGap = modelRequests;
      await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.getElementById('coach-panel').getAttribute('aria-busy') === 'false');
      if (!await page.locator('#profile-background').isVisible()) await menuItem('[data-view=profile]');
      assert.equal(await page.locator('#profile-background').inputValue(), '');
      assert.equal(await page.locator('#profile-background').evaluate((node) => node.required), false);
      assert.equal(await page.locator('#classify').isDisabled(), false); assert.equal(await page.locator('#direct-reply').isDisabled(), false);
      await scan('optional-profile');
      assert.equal(modelRequests, requestsBeforeProfileGap, 'Viewing incomplete intake reuses the existing analysis');
      await page.unroute('**/api/me');
    } finally { await context.close(); }
  }
  assert.equal(await readFile(knowledgePath, 'utf8'), knowledge);
  report.passed = report.scans.every(({ violations }) => violations.length === 0) && !report.pageErrors.length && !report.externalRequests.length;
} catch (error) {
  report.automationFailure = { name: error.name, message: error.message };
  console.error(`Accessibility journey failed: ${error.message}`);
} finally {
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  await rm(directory, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
  const failures = report.scans.flatMap(({ state, violations }) => violations.flatMap(({ id, nodes }) => nodes.map(({ target, failureSummary }) => `- ${state}: ${id}; ${target.join(' ')}\n  ${failureSummary?.replaceAll('\n', '\n  ') || ''}`)));
  const manual = new Map();
  for (const { state, incomplete } of report.scans) for (const rule of incomplete) for (const node of rule.nodes) {
    const key = JSON.stringify([rule.id, node.target]);
    if (!manual.has(key)) manual.set(key, { id: rule.id, target: node.target, states: [], messages: node.checks.map(({ message }) => message) });
    manual.get(key).states.push(state);
  }
  report.manualReview = [...manual.values()];
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  const manualNotes = report.manualReview.map(({ id, target, states, messages }) => `- ${id}; ${target.join(' ')}\n  ${messages.join(' ')}\n  States: ${states.join(', ')}.`);
  const contrastNotes = report.iconContrast.map(({ state, icons }) => `- ${state}: message-menu glyph contrast ${Math.min(...icons.map(({ ratio }) => ratio)).toFixed(2)}:1 minimum; ${icons.length} controls, opacity 1. All measured ratios meet 4.5:1.`);
  await writeFile(join(evidenceDir, 'report.md'), `# Automated accessibility acceptance\n\nAutomated rule verdict: ${report.passed ? 'pass' : 'fail'}. Engine: axe-core ${axe.version}. Synthetic provider calls only; paid model calls: 0; email calls: 0.\n\nScans: ${report.scans.length}. Every default axe rule runs on the full document. No rules or page regions are excluded. A clean automated scan does not establish complete accessibility conformance.\n\n## Automatic violations\n\n${failures.length ? failures.join('\n\n') : 'No automatic violations found.'}\n\n## Supplemental contrast checks\n\n${contrastNotes.join('\n')}\n\nThe transcript screenshots 1280-day-message-icons.png and 1280-night-message-icons.png retain visual evidence. Computed-color checks supplement axe's non-text glyph incomplete result; they do not resolve other incomplete nodes.\n\n## Manual review\n\n${manualNotes.length ? manualNotes.join('\n\n') : 'No incomplete rules returned.'}${report.automationFailure ? `\n\nAutomation failure: ${report.automationFailure.message}` : ''}\n`, 'utf8');
  if (!report.passed) process.exitCode = 1;
  console.log(`Automated accessibility rules ${report.passed ? 'passed' : 'failed'}; ${report.scans.length} scans; ${report.manualReview.length} incomplete selectors retained for review; zero paid model or email calls. See runs/accessibility/report.md.`);
}
