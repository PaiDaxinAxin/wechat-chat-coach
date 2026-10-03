import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Isolated fictional records and full copied knowledge. All provider entry
// points are injected and requests cannot leave the ephemeral loopback origin.
// No rest-affordance exclusions: even selected directory rows have a boundary.
// Closed menu rows are not visible; their borderless Menu tier is checked when
// opening the annotation menu, separately from the seeded-page control audit.
process.umask(0o077);
const temporary = await mkdtemp(join(tmpdir(), 'coach-affordance-'));
const report = { passed: false, synthetic: true, actualProviderCalls: 0, mockReplies: 0,
  cases: [], controls: [], tokens: [], composers: [], screenshots: [], pageErrors: [], externalRequests: [], exclusions: [] };
let server, browser, replyGate;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

// Measure composited pixels, including alpha overlays and the 32px menu-circle
// pseudo-element inside its 44px hit area. Transparent ancestors do not become
// false white backgrounds, and select's overlay gradient is measured too.
function measureControl(node) {
  const rgb = (value) => {
    if (value.startsWith('#')) {
      const raw = value.slice(1), hex = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1);
    }
    const channels = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
    if (value.includes('%')) channels[3] /= 100;
    return [...channels.slice(0, 3), channels[3] ?? 1];
  };
  const composite = (front, back) => front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])).concat(1);
  const luminance = (color) => color.slice(0, 3).map((v) => v / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const background = (element) => {
    const ancestors = []; for (let parent = element; parent; parent = parent.parentElement) ancestors.unshift(parent);
    return ancestors.reduce((color, parent) => composite(rgb(getComputedStyle(parent).backgroundColor), color), [255, 255, 255, 1]);
  };
  const root = getComputedStyle(document.documentElement), style = getComputedStyle(node);
  const circle = node.matches('.message-menu > summary'), pseudo = getComputedStyle(node, '::before');
  const visual = circle ? pseudo : style, parent = background(node.parentElement);
  let fill = composite(rgb(visual.backgroundColor), parent);
  const overlay = visual.backgroundImage.match(/rgba?\([^)]+\)/)?.[0];
  if (overlay) fill = composite(rgb(overlay), fill);
  const accent = rgb(root.getPropertyValue('--color-accent').trim());
  const disclosure = node.tagName === 'SUMMARY' && !node.matches('.chat-menu > summary');
  const chevron = disclosure && pseudo.content !== 'none' && pseudo.content !== 'normal'
    && parseFloat(pseudo.width) > 0 && parseFloat(pseudo.borderRightWidth) > 0 && pseudo.borderRightStyle === 'solid';
  const rect = node.getBoundingClientRect();
  return {
    label: node.id || `${node.className}:${node.textContent.trim().slice(0, 35)}`,
    border: visual.borderTopColor, background: visual.backgroundColor, image: visual.backgroundImage,
    borderContrast: parseFloat(visual.borderTopWidth) > 0 && !['none', 'hidden'].includes(visual.borderTopStyle)
      ? contrast(composite(rgb(visual.borderTopColor), parent), parent) : 0,
    fillContrast: contrast(fill, parent), textContrast: contrast(composite(rgb(style.color), fill), fill),
    disclosure: chevron && rgb(style.color).slice(0, 3).every((v, i) => v === accent[i]),
    opacity: Number(style.opacity), width: rect.width, height: rect.height, fontSize: parseFloat(style.fontSize),
    onCoach: Boolean(node.closest('.coach-card')),
    coachContrast: contrast(fill, rgb(root.getPropertyValue('--color-coach').trim())),
    outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineOffset: parseFloat(style.outlineOffset),
    transform: style.transform,
    tokens: Object.fromEntries(['control-line', 'hover', 'press', 'accent-strong', 'disabled-text'].map((key) => [key, root.getPropertyValue(`--color-${key}`).trim()])),
    contrasts: Object.fromEntries(['surface', 'bg', 'canvas', 'coach'].map((key) => {
      const bg = rgb(root.getPropertyValue(`--color-${key}`).trim());
      return [key, { controlLine: contrast(rgb(root.getPropertyValue('--color-control-line').trim()), bg),
        disabledText: contrast(rgb(root.getPropertyValue('--color-disabled-text').trim()), bg),
        accent: contrast(accent, bg), accentStrong: contrast(rgb(root.getPropertyValue('--color-accent-strong').trim()), bg),
        hover: contrast(composite(rgb(root.getPropertyValue('--color-hover').trim()), bg), bg),
        press: contrast(composite(rgb(root.getPropertyValue('--color-press').trim()), bg), bg) }];
    })),
  };
}

try {
  const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8'), knowledgePath = join(temporary, 'knowledge.md');
  await writeFile(knowledgePath, knowledgeText);
  const webDir = join(temporary, 'public'); await mkdir(webDir);
  const stylesheet = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.ok(!stylesheet.includes('color-mix('), 'All derived colors are explicit tokens');
  for (const name of ['index.html', 'app.js', 'styles.css']) await writeFile(join(webDir, name), await readFile(new URL(`../web/${name}`, import.meta.url)));
  server = await createBetaServer({ dataDir: join(temporary, 'data'), knowledgePath, webDir, providerEnv: {}, localDemoMode: true, paidProviderDailyLimit: 40,
    classifyFn: async () => { throw new Error('Affordance/readback must not classify'); },
    replyFn: async ({ context }, options) => {
      assert.equal(options.knowledgeText, knowledgeText); report.mockReplies++;
      await replyGate?.promise;
      return { reply: '你最近走过哪条路线？', action: 'reply', reason: '接住已记录的徒步话题。', styleNote: '简短自然。',
        workingFocus: { stage: 'emotion', reason: '先承接原话。', evidenceIds: [context.messages.at(-1).id] },
        guidance: { topicMove: null, relationMove: 'receive', ownWordsGuide: '换成自己会说的话。', reentryWhen: '对方有新内容时继续。' } };
    },
    planFn: async () => { throw new Error('No plan inference requested'); }, imageFn: async () => { throw new Error('No image inference requested'); },
  });
  const seed = await server.ensureDemoSeed();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  for (const theme of ['day', 'night']) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const label = `${theme}-${viewport.width}x${viewport.height}`, touch = viewport.width === 390;
    const blank = server.betaStore.putCounterpart(seed.user.id, { alias: `未开始-${label}`, channel: 'other', background: '', appProfile: '', offlineScene: '', rounds: null });
    const person = server.betaStore.putCounterpart(seed.user.id, { alias: `徒步-${label}`, channel: 'other', background: '仅用于隔离验收的虚构对象。', appProfile: '', offlineScene: '', rounds: null });
    const messages = [server.betaStore.putMessage(seed.user.id, person.id, { speaker: 'self', text: '我也喜欢周末散步。' }),
      server.betaStore.putMessage(seed.user.id, person.id, { speaker: 'other', text: '我周末去徒步了。' })];
    const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
    await context.addInitScript((mode) => localStorage.setItem('chat-coach-theme', mode), theme);
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      report.externalRequests.push(new URL(route.request().url()).origin); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    async function select(id) {
      await page.locator('#counterpart-select').selectOption(id);
      await page.waitForFunction((selected) => document.getElementById('counterpart-select').value === selected
        && !document.getElementById('counterpart-workspace').hidden && !document.getElementById('message-text').disabled, id);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function step(action, hint) {
      await page.waitForFunction(({ action, hint }) => {
        const next = [...document.querySelectorAll('.step-action.is-next')];
        return next.length === (action ? 1 : 0) && (!action || next[0].id === action) && document.getElementById('next-step').textContent === hint;
      }, { action, hint });
      assert.equal(await page.locator('#message-form > #next-step').count(), 1, 'Hint stays outside the scrolling thread');
    }
    async function post(suffix, action) {
      const pending = page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === 'POST');
      await action(); const response = await pending; assert.equal(response.status(), 200); return (await response.json()).data;
    }
    const repliesBefore = report.mockReplies;
    await page.goto(origin); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('startup-status').hidden);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches), !touch);
    await select(blank.id);
    await step('save-message', '下一步：把对方的一句原话贴到下方');
    assert.equal(await page.locator('#direct-reply').isDisabled(), true);
    const disabled = await page.locator('#direct-reply').evaluate(measureControl);
    assert.equal(disabled.opacity, 1); assert.ok(disabled.textContrast >= 3, JSON.stringify(disabled));
    assert.equal(await page.locator('#direct-reply').evaluate((node) => getComputedStyle(node).borderTopStyle), 'dashed');
    if (!touch) {
      report.tokens.push({ theme, values: disabled.tokens, backgrounds: disabled.contrasts });
      for (const [bg, values] of Object.entries(disabled.contrasts)) assert.ok(values.controlLine >= 3, `${theme} control border / ${bg}`);
      for (const bg of ['surface', 'coach']) assert.ok(disabled.contrasts[bg].disabledText >= 3, `${theme} disabled label / ${bg}`);
    }
    await select(person.id);
    await step('direct-reply', '下一步：点「给我建议」拿一句回复；想换方向点「换个话题」');
    if (!touch) {
      const geometry = await page.locator('#message-form').evaluate((form) => {
        const style = getComputedStyle(form), help = getComputedStyle(form.querySelector('.composer-hint'));
        const meaning = form.querySelector('.composer-meaning'), meaningStyle = getComputedStyle(meaning);
        // Reconstruct the previous closed composer from unchanged controls,
        // input/padding and its two original single-line muted hint blocks.
        const previousHeight = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth)
          + form.querySelector('.composer-controls').getBoundingClientRect().height
          + meaning.getBoundingClientRect().height + parseFloat(meaningStyle.marginTop) + parseFloat(meaningStyle.marginBottom)
          + form.querySelector('.composer-input-row').getBoundingClientRect().height
          + 2 * (parseFloat(help.lineHeight) + parseFloat(help.marginTop));
        return { currentHeight: form.getBoundingClientRect().height, previousHeight };
      });
      assert.ok(geometry.currentHeight <= geometry.previousHeight + .5, `${label}: composer must not grow: ${JSON.stringify(geometry)}`);
      report.composers.push({ theme, ...geometry });
    }
    assert.equal(await page.locator('.message-annotation:visible').count(), 0, 'Messages without annotation have no disclosure row');
    const controls = (await page.locator('main button, main summary, main select, main [role=button]').elementHandles());
    for (const control of controls) {
      if (!await control.evaluate((node) => node.checkVisibility())) continue;
      await control.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
      const rest = await control.evaluate(measureControl);
      assert.ok(rest.borderContrast >= 3 || rest.fillContrast >= 3 || rest.disclosure, `${label} rest affordance: ${JSON.stringify(rest)}`);
      assert.ok(rest.height >= 44 && rest.fontSize >= 12, `${label} target/text size: ${JSON.stringify(rest)}`);
      if (!touch) {
        await control.hover(); const hover = await control.evaluate(measureControl);
        assert.ok(hover.background !== rest.background || hover.border !== rest.border || hover.image !== rest.image, `${label} hover missing: ${rest.label}`);
        if (hover.onCoach) assert.ok(hover.coachContrast >= 1.1, `${label} AI-card hover: ${JSON.stringify(hover)}`);
      } else {
        await control.hover(); const hover = await control.evaluate(measureControl);
        assert.equal(hover.background, rest.background); assert.equal(hover.border, rest.border); assert.equal(hover.image, rest.image);
      }
      report.controls.push({ state: label, label: rest.label, borderContrast: rest.borderContrast, fillContrast: rest.fillContrast, disclosure: rest.disclosure });
    }
    await page.mouse.move(0, 0);
    if (!touch) {
      const selected = page.locator(`.counterpart-item[data-counterpart-id="${person.id}"]`);
      assert.equal(await selected.getAttribute('aria-current'), 'true');
      assert.equal(await selected.evaluate((node) => getComputedStyle(node).borderInlineStartWidth), '3px');
      const advice = page.locator('#direct-reply'); await advice.focus();
      const focused = await advice.evaluate(measureControl);
      assert.equal(focused.outline, 'solid'); assert.equal(focused.outlineWidth, 2); assert.ok(focused.outlineOffset >= 2);
      await advice.hover(); const beforePress = await advice.evaluate(measureControl);
      await page.mouse.down(); const pressed = await advice.evaluate(measureControl);
      assert.equal(pressed.transform, 'none', 'Reduced motion suppresses the press translation');
      assert.equal(pressed.background, beforePress.background);
      // Release away from the button: this visual check must not invoke a model.
      await page.mouse.move(0, 0); await page.mouse.up();
    }
    await page.locator('#message-text').fill('新输入的对方原话');
    await step('save-message', '下一步：点「记录消息」或按 Enter');
    await page.locator('#message-speaker').selectOption('self');
    await step('save-message', '下一步：点「记录已发送」或按 Enter');
    await page.locator('#message-text').fill(''); await page.locator('#message-speaker').selectOption('other');
    await step('direct-reply', '下一步：点「给我建议」拿一句回复；想换方向点「换个话题」');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64');
    await page.locator('#message-image-file').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: image });
    await step('save-message', '下一步：点「识读图片」或按 Enter');
    await page.locator('#remove-message-image').click();
    await step('direct-reply', '下一步：点「给我建议」拿一句回复；想换方向点「换个话题」');
    assert.equal(report.mockReplies, repliesBefore, 'Affordances, input, images and readback have no model side effects');
    const row = page.locator(`[data-message-id="${messages[0].id}"]`), note = row.locator('.message-annotation');
    await row.locator('.message-menu > summary').click();
    const item = row.getByRole('button', { name: '添加批注', exact: true });
    assert.equal(await item.evaluate((node) => getComputedStyle(node).borderTopWidth), '0px', 'Menu items are borderless rows');
    for (const menuItem of await row.locator('.chat-menu-items button').elementHandles()) {
      await page.mouse.move(0, 0);
      const rest = await menuItem.evaluate(measureControl);
      assert.equal(rest.borderContrast, 0, 'Menu items keep their borderless tier');
      assert.ok(rest.height >= 44 && rest.fontSize >= 12, `${label} menu target/text size: ${rest.label}`);
      await menuItem.hover();
      const hover = await menuItem.evaluate(measureControl);
      if (touch) assert.equal(hover.background, rest.background, `${label} touch menu has no hover fill`);
      else assert.notEqual(hover.background, rest.background, `${label} menu hover: ${rest.label}`);
    }
    if (touch) await item.click();
    else {
      await item.hover();
      const hover = await item.evaluate(measureControl);
      await page.mouse.down();
      const press = await item.evaluate(measureControl);
      assert.notEqual(press.background, hover.background, `${label} menu press is stronger than hover`);
      await page.mouse.up(); // invokes the intended annotation action
    }
    assert.equal(await note.evaluate((node) => node.open && !node.hidden), true);
    assert.equal(await note.locator('textarea').evaluate((node) => node === document.activeElement), true);
    await note.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await note.isVisible(), false);
    assert.equal(await row.locator('.message-menu > summary').evaluate((node) => node === document.activeElement), true);
    await row.locator('.message-menu > summary').click(); await item.click();
    await note.locator('textarea').fill('虚构背景：这是上次徒步话题的延续。');
    const saved = page.waitForResponse((r) => r.url().endsWith('/annotation') && r.request().method() === 'PATCH');
    await note.locator('button[type=submit]').click(); assert.equal((await saved).status(), 200);
    await page.waitForFunction(() => [...document.querySelectorAll('.message-annotation button[type=submit]')].every((button) => !button.disabled));
    await note.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await note.locator('summary').textContent(), '批注 · 已补背景');
    assert.equal(await note.locator('summary').isVisible(), true);
    assert.equal(await page.locator('.message-annotation:visible').count(), 1);
    await post('/reply', () => page.locator('#direct-reply').click());
    await step('copy-reply', '下一步：改成你的说法，点「复制回复」后发到微信');
    await post('/copied', () => page.locator('#copy-reply').click());
    await step('save-message', '下一步：发到微信后，等对方回复，把原话贴到下方');
    await page.waitForFunction(() => document.getElementById('copy-reply').textContent === '复制回复');
    await step('save-message', '下一步：发到微信后，等对方回复，把原话贴到下方');
    await page.locator('#suggestion-text').fill('刚改写，还没有复制的新版本。');
    await step('copy-reply', '下一步：改成你的说法，点「复制回复」后发到微信');
    const intent = page.locator('#intent'); await intent.evaluate((node) => { node.closest('details').open = true; });
    await intent.fill('合成慢响应：换一种表达。');
    replyGate = deferred();
    const slow = post('/reply', () => page.locator('#direct-reply').click());
    await step(null, 'AI 正在准备，完成后这里会提示下一步');
    await page.locator('#message-text').fill('AI 准备期间也可以录入原话');
    await step('save-message', '下一步：点「记录消息」或按 Enter');
    await page.locator('#message-text').fill('');
    await step(null, 'AI 正在准备，完成后这里会提示下一步');
    replyGate.resolve(); await slow; replyGate = null;
    await step('copy-reply', '下一步：改成你的说法，点「复制回复」后发到微信');
    await intent.evaluate((node) => { node.closest('details').open = false; });
    await select(blank.id); await select(person.id); // remove transient arrival/update cues
    await step('copy-reply', '下一步：改成你的说法，点「复制回复」后发到微信');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No horizontal overflow');
    assert.equal(await page.locator('[style], style').count(), 0, 'CSP: no inline styles');
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), ['chat-coach-theme'], 'No added storage keys');
    const screenshot = join(temporary, `${label}.png`); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    report.cases.push(`${label}: rest, hover/touch, disabled, focus, record/advice/copy/busy loop and annotation menu/save`);

    // Force exhausted quota through the existing readback injection pattern;
    // the store seeds only fictional messages, with no additional provider calls.
    const repliesBeforeQuota = report.mockReplies;
    await page.route('**/api/me', async (route) => {
      const response = await route.fetch(), body = await response.json();
      body.data.user.plan = 'free'; body.data.quota.dailyReplyRemaining = 0;
      await route.fulfill({ response, json: body });
    });
    server.betaStore.putMessage(seed.user.id, blank.id, { speaker: 'other', text: '虚构原话：你周末打算去哪儿？' });
    await page.reload(); await page.locator('#counterpart-workspace').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('startup-status').hidden);
    await select(blank.id);
    assert.ok((await page.locator('#daily-reply-quota').textContent()).includes('0 / 3'));
    assert.equal(await page.locator('#direct-reply').isDisabled(), true);
    assert.equal(await page.locator('#suggestion-panel').isVisible(), false);
    await step('save-message', '下一步：今日免费建议已用完；自己回复后，把发出的话记为「我已发送的消息」');
    server.betaStore.putMessage(seed.user.id, blank.id, { speaker: 'self', text: '虚构已发送：我想去江边走走。' });
    await select(person.id); await select(blank.id);
    await step('save-message', '下一步：等对方回复，把原话贴到下方（今日免费建议已用完）');
    assert.equal(report.mockReplies, repliesBeforeQuota, 'Quota guidance and seeded self/other messages add no model calls');
    report.cases.push(`${label}: exhausted quota with no suggestion, other/self next-step text and record highlighted without model calls`);
    await context.close();
  }
  assert.equal(report.mockReplies, 8, 'Exactly two deliberate injected replies per viewport/theme');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  report.passed = true;
} finally {
  replyGate?.resolve(); await browser?.close();
  if (server) { await new Promise((resolve) => server.close(resolve)); await server.storeClosed; }
  await writeFile(join(temporary, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  // Keep only synthetic screenshots/report for review; remove runtime fixtures.
  for (const name of ['data', 'knowledge.md', 'public']) await rm(join(temporary, name), { recursive: true, force: true });
}
for (const path of report.screenshots) console.log(`Screenshot: ${path}`);
console.log(JSON.stringify(report));
