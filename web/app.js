const $ = (id) => document.getElementById(id);
const state = {
  meta: null, me: null, csrf: '', authMode: 'login', localDemo: false, counterparts: [], topThree: [],
  selectedId: null, detail: null, selectedDirection: null, suggestion: null,
  editingMessageId: null, editingCounterpartId: null, requestIds: new Map(),
  questionnaireAnswers: {}, suggestionDrafts: new Map(),
  intentDrafts: new Map(), planDrafts: new Map(), planResults: new Map(), planCalls: new Map(), copyReceipts: new Map(), autoAttempts: new Set(), modelCalls: new Map(), detailRequestSerial: 0,
  activeInlineCard: null, inlineTrigger: null, bootLoading: false,
  styleLearning: null, styleReadSerial: 0, styleCase: null, styleReviewDirty: false, styleSupersedesId: null, profileDraftVersion: 0,
};
const directionNames = { up: '上切 · 看更大的类别', down: '下切 · 深入具体细节', sideways: '平移 · 关联另一个话题' };
const actionNames = { continue: '继续了解', warm: '自然升温', handle_obstacle: '承接阻力', clarify: '澄清', invite: '协商邀约', pause: '暂停投入', reply: '建议回复', wait: '先等待' };
const dimensionNames = { activeInteraction: '主动互动', responseEngagement: '回复参与', personalInterest: '对我的兴趣', reciprocalFlirting: '双向暧昧', actionFollowThrough: '行动兑现' };
const levelNames = { unknown: '未知', negative: '有负向信号', passive: '被动回应', positive: '积极参与', repeated_positive: '持续积极' };
const heatNames = { pause: '建议暂停', insufficient_evidence: '信息不足', too_low: '当前投入较低', potential: '可以继续建设', high_invite: '可协商见面' };
const confidenceNames = { limited: '证据有限', moderate: '证据中等', strong: '证据较充分' };
const channelNames = { app: '交友软件认识', offline: '线下认识', other: '其他渠道' };
const topicStatusNames = { developing: '话题正在展开', repetitive: '话题有重复迹象', closing: '可以自然收尾', unknown: '话题阶段待判断' };
const planVerdictNames = { suitable: '这个方向合适', adjust: '建议调整', wait: '先等一等', needs_context: '还需要背景' };
const planTimingNames = { now: '现在可以考虑', after_response: '等对方回应后', after_topic: '当前话题自然结束后', wait: '先等待', unknown: '时机尚不确定' };
const meetingNames = { none: '尚无安排', proposed: '已提出邀约', alternative: '协商其他时间', confirmed: '双方已确认', declined: '本次未接受' };

// Every data value becomes a text node or a form value, never HTML.
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'disabled') node.disabled = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function announce(message, kind = 'success') {
  const notice = $('notice');
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = !message;
  $('auth-status').textContent = message;
  $('auth-status').className = kind === 'error' ? 'form-error' : 'helper';
  $('auth-status').hidden = $('auth').hidden || !message;
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && state.csrf && !['/api/login', '/api/register'].includes(path)) headers['x-csrf-token'] = state.csrf;
  let response;
  try { response = await fetch(path, { method, headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new Error('连接中断，请检查网络后重试；未收到结果时不要假定操作已经失败。'); }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('服务暂时没有返回有效结果，请稍后重试。'); }
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || '操作未完成，请稍后重试。');
    error.code = payload.error?.code;
    error.status = response.status;
    if (response.status === 401 && state.me) {
      clearSessionUI();
      if (state.localDemo) showStartup('演示会话已结束，请重新打开聊天后继续。不会自动调用模型。', { failed: true });
    }
    throw error;
  }
  return payload.data;
}
async function perform(button, label, callback, scope) {
  if (button?.disabled) return;
  const original = button?.textContent;
  const form = button?.closest('form');
  let localError = form?.querySelector('.form-error');
  if (localError) localError.hidden = true;
  if (button) { button.disabled = true; button.textContent = label; }
  try { return await callback(); }
  catch (error) {
    if (scope && (state.me?.user.id !== scope.userId || state.selectedId !== scope.counterpartId)) return;
    const message = error.message || '操作未完成，请重试。';
    announce(message, 'error');
    if (form?.isConnected) {
      if (!localError) { localError = el('p', { class: 'form-error', role: 'alert' }); form.append(localError); }
      localError.textContent = message; localError.hidden = false;
      localError.scrollIntoView({ block: 'nearest' });
    }
  }
  finally { if (button?.isConnected) { button.disabled = button.dataset.locked === 'true'; button.textContent = original; if (button.id === 'save-message') updateComposer(); } }
}
function post(path, body) { return api(path, { method: 'POST', body }); }
function put(path, body) { return api(path, { method: 'PUT', body }); }
function counterpartPath(id = state.selectedId) { return `/api/counterparts/${encodeURIComponent(id)}`; }
const inlineCards = ['profile-view', 'counterpart-dialog', 'heat-panel', 'meeting-panel', 'admin-view'];
function closeInlineCards({ restoreFocus = false } = {}) {
  const focusedInCard = state.activeInlineCard && $(state.activeInlineCard).contains(document.activeElement);
  const trigger = state.inlineTrigger;
  for (const id of inlineCards) $(id).hidden = true;
  state.activeInlineCard = null; state.inlineTrigger = null;
  if (restoreFocus && focusedInCard) {
    const triggerMenu = trigger?.closest('.chat-menu');
    const menuSummary = triggerMenu?.querySelector(':scope > summary');
    const insideClosedMenu = triggerMenu && !triggerMenu.open && trigger !== menuSummary;
    const visibleTrigger = !insideClosedMenu && trigger?.isConnected && trigger.matches('button,input,textarea,select,a[href],summary,[tabindex]') && trigger.checkVisibility() ? trigger : trigger?.closest('#field-coach') && $('toggle-field-coach').checkVisibility() ? $('toggle-field-coach') : menuSummary || $('chat-menu').querySelector('summary');
    visibleTrigger?.focus({ preventScroll: true });
  }
}
function openInlineCard(id) {
  if (!inlineCards.includes(id)) return;
  const trigger = document.activeElement;
  closeInlineCards();
  $(id).hidden = false;
  state.activeInlineCard = id; state.inlineTrigger = trigger;
  $('chat-menu').open = false;
  $(id).tabIndex = -1;
  $(id).scrollIntoView({ block: 'start', behavior: 'auto' });
  const firstField = $(id).querySelector('input:not([hidden]):not([disabled]),textarea:not([disabled]),select:not([disabled])');
  (firstField?.getClientRects().length ? firstField : $(id)).focus({ preventScroll: true });
}
function closeMenu(menu, { restoreFocus = false } = {}) {
  const focusedInside = menu.contains(document.activeElement);
  menu.open = false;
  if (restoreFocus && focusedInside) menu.querySelector('summary')?.focus({ preventScroll: true });
}
function scrollToLatest() {
  requestAnimationFrame(() => { $('chat-thread').scrollTop = $('chat-thread').scrollHeight; });
}
function updateComposer() {
  const ready = Boolean(state.selectedId && state.detail);
  $('message-text').disabled = !ready;
  $('message-speaker').disabled = !ready;
  $('save-message').disabled = !ready;
  $('save-message').dataset.locked = String(!ready);
  $('save-message').textContent = state.editingMessageId ? '保存修改' : $('message-speaker').value === 'self' ? '记录已发送' : '记录消息';
  $('message-text').placeholder = $('message-speaker').value === 'self' ? '填写你已经发出的原话…' : '粘贴对方刚说的话…';
  for (const id of ['edit-counterpart', 'open-heat', 'open-meeting']) $(id).disabled = !ready;
}
function initializeTheme() {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let chosen = null;
  try { const saved = localStorage.getItem('chat-coach-theme'); if (saved === 'day' || saved === 'night') chosen = saved; } catch { /* Theme storage is optional. */ }
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme-toggle').textContent = theme === 'night' ? '日间' : '夜间';
    $('theme-toggle').setAttribute('aria-label', theme === 'night' ? '切换日间主题' : '切换夜间主题');
  }
  apply(chosen || (system.matches ? 'night' : 'day'));
  $('theme-toggle').addEventListener('click', () => {
    chosen = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
    apply(chosen);
    try { localStorage.setItem('chat-coach-theme', chosen); } catch { /* Keep the selected theme for this page. */ }
  });
  system.addEventListener('change', (event) => { if (!chosen) apply(event.matches ? 'night' : 'day'); });
}
function applyDemoMode() {
  state.localDemo = state.meta?.localDemo?.enabled === true && state.meta.localDemo.synthetic === true;
  $('demo-banner').hidden = !state.localDemo;
  $('logout').hidden = state.localDemo;
  if (state.localDemo) {
    $('auth').hidden = true;
    $('admin-nav').hidden = true;
    $('admin-view').hidden = true;
    $('profile-title').textContent = '演示画像：表达风格与练习目标';
    $('profile-intro').textContent = '以下是预置的虚构背景，可修改后观察建议如何变化。这份演示画像不代表你的真实情况。';
  }
}
function setAuthMode(mode) {
  if (state.localDemo) return;
  state.authMode = mode;
  const register = mode === 'register';
  $('invite-field').hidden = !register;
  $('invite').required = register;
  $('password-help').hidden = !register;
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-submit').textContent = register ? '注册并建立画像' : '登录';
  for (const [id, active] of [['login-tab', !register], ['register-tab', register]]) {
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
}
function showView(view) {
  if (view === 'admin' && (state.localDemo || state.me?.user.role !== 'owner')) return;
  if (view === 'coach') { closeInlineCards({ restoreFocus: true }); scrollToLatest(); }
  if (view === 'profile') openInlineCard('profile-view');
  if (view === 'admin') openInlineCard('admin-view');
  if (view === 'admin') void perform($('reload-admin'), '读取中…', loadAdmin);
}
function updateQuota(quota = state.me?.quota) {
  if (!quota || !state.me) return;
  state.me.quota = quota;
  const remaining = quota.classificationRemaining;
  $('quota-summary').textContent = `${remaining === null ? state.localDemo ? 'Demo 方向分析' : '付费内测方向分析' : `方向分析试用剩余 ${remaining ?? '—'} / 3 次`} · 今日模型调用剩余 ${quota.providerRemaining ?? '—'} 次`;
  const unavailable = state.me.user.plan !== 'paid' && remaining === 0;
  $('classify').hidden = unavailable;
  $('classify-availability').textContent = unavailable
    ? '三次方向分析试用已用完。你仍可直接生成回复；本轮不调用分类器，也不展示虚构权重。'
    : '方向分析依据已保存的双方背景与当前对话；一次完整分析计一次，同一上下文或切换方向不重复计次。权重不是成功率。';
  updateComposer();
}
async function reloadMe({ expectedUserId } = {}) {
  const me = await api('/api/me');
  if (expectedUserId && (state.me?.user.id !== expectedUserId || me.user.id !== expectedUserId)) return null;
  state.me = me;
  state.csrf = me.csrfToken;
  $('account-name').textContent = state.localDemo ? '虚构演示账号' : me.user.username;
  $('plan-badge').textContent = state.localDemo ? '本机 Demo' : me.user.plan === 'paid' ? '付费内测' : '免费内测';
  $('admin-nav').hidden = state.localDemo || me.user.role !== 'owner';
  $('questionnaire-kind').querySelector('[value="full"]').disabled = me.user.plan !== 'paid';
  updateQuota();
  return me;
}
function fillProfile() {
  const profile = state.me?.profile || {};
  for (const [id, key] of [['profile-background', 'background'], ['profile-style', 'style'], ['profile-growth', 'growthGoals'], ['profile-goal', 'relationshipGoal']]) $(id).value = profile[key] || '';
  state.questionnaireAnswers = { ...(profile.questionnaire?.answers || {}) };
  const kind = profile.questionnaire?.kind === 'full' && state.me.user.plan === 'paid' ? 'full' : 'short';
  $('questionnaire-kind').value = kind;
  renderQuestionnaire(kind);
  $('profile-saved').textContent = state.localDemo ? '这是虚构演示画像。修改只影响本机 Demo，后续 AI 会使用更新后的内容。' : profile.background ? '已保存的画像可随时修改。' : '完成画像后开始：当前风格和成长目标会分别进入辅助背景。';
}
function captureAnswers() {
  $('questionnaire').querySelectorAll('select[data-question-id]').forEach((select) => {
    if (select.value) state.questionnaireAnswers[select.dataset.questionId] = Number(select.value);
  });
}
function renderQuestionnaire(kind) {
  const questions = state.meta?.questionnaires?.[kind] || [];
  $('questionnaire').replaceChildren(...questions.map((question, index) => {
    const select = el('select', { required: '', 'data-question-id': question.id, 'aria-label': question.text });
    select.append(el('option', { value: '' }, '请选择'));
    for (let score = 1; score <= 5; score++) select.append(el('option', { value: score }, `${score} · ${['很不符合', '不太符合', '中间 / 视情境', '比较符合', '很符合'][score - 1]}`));
    select.value = state.questionnaireAnswers[question.id] ? String(state.questionnaireAnswers[question.id]) : '';
    return el('label', { class: 'question' }, el('span', {}, el('span', { class: 'question-number' }, String(index + 1).padStart(2, '0')), question.text), select);
  }));
}
async function enterWorkspace() {
  await reloadMe();
  $('auth').hidden = true;
  $('workspace').hidden = false;
  $('account-bar').hidden = false;
  fillProfile();
  await loadStyleLearning();
  await loadCounterparts();
  const requiresUpdate = state.me.requiresQuestionnaireUpdate || state.me.profile?.requiresQuestionnaireUpdate;
  showView(state.me.profile?.background && !requiresUpdate ? 'coach' : 'profile');
  if (requiresUpdate) announce('当前账号已改为免费内测。请补全并保存精简问卷后继续辅助，原完整版答案在后台保留。', 'error');
}
const styleStatusNames = { candidate: '候选 · 尚未应用', adopted: '已采用 · 私有辅助规则', revoked: '已停用' };
const styleTargetNames = { current_preference: '当前表达偏好', growth_goal: '愿意练习的方向' };
const styleFitNames = { like: '像我', mixed: '部分像我', unlike: '不像我', unknown: '暂不判断' };
const styleWillingnessNames = { try: '愿意练习', avoid: '暂不想使用', undecided: '暂未决定' };
function renderStyleLearning() {
  const data = state.styleLearning;
  $('style-rule-list').replaceChildren(); $('style-review-list').replaceChildren();
  if (!data) { $('style-status').textContent = '规则尚未读取，请重新读取后保存。'; return; }
  $('style-status').textContent = '这些规则仅属于当前账号；候选不会进入辅助背景，采用后跨自己的聊天对象使用。';
  if (!data.rules.length) $('style-rule-list').append(el('p', { class: 'helper' }, '还没有表达规则。可以先保存候选，再决定是否采用。'));
  for (const rule of [...data.rules].reverse()) {
    const card = el('article', { class: 'style-rule', 'data-rule-id': rule.id, 'data-rule-status': rule.status },
      el('div', { class: 'section-heading' }, el('strong', {}, styleTargetNames[rule.target] || '表达规则'), el('span', { class: 'badge' }, styleStatusNames[rule.status] || '状态待读取')),
      el('p', { class: 'style-source' }, rule.text));
    if (rule.conditions) card.append(el('p', {}, `适用条件：${rule.conditions}`));
    if (rule.limits) card.append(el('p', {}, `限制：${rule.limits}`));
    const buttons = el('div', { class: 'button-row' });
    if (rule.status === 'candidate') buttons.append(el('button', { type: 'button', class: 'primary', 'data-rule-action': 'adopt', onclick: (event) => void saveRuleAction(event.currentTarget, { type: 'adopt', candidateId: rule.id }) }, '采用这条规则'));
    if (rule.status === 'adopted') buttons.append(el('button', { type: 'button', class: 'quiet-button', 'data-rule-action': 'revoke', onclick: (event) => void saveRuleAction(event.currentTarget, { type: 'revoke', ruleId: rule.id }) }, '停用'));
    if (rule.status !== 'revoked') buttons.append(el('button', { type: 'button', class: 'quiet-button', 'data-rule-action': 'edit', onclick: () => {
      $('style-rule-text').value = rule.text; $('style-rule-target').value = rule.target;
      $('style-rule-conditions').value = rule.conditions || ''; $('style-rule-limits').value = rule.limits || '';
      $('style-apply').checked = false; state.styleSupersedesId = rule.id; state.profileDraftVersion++;
      $('style-replacement').textContent = '正在起草这条规则的新版本。明确采用并保存后，旧版本才会停用。'; $('style-replacement').hidden = false;
      $('style-rule-text').focus();
    } }, '改写新版本'));
    card.append(buttons); $('style-rule-list').append(card);
  }
  $('style-review-history').hidden = !data.reviews.length;
  for (const review of data.reviews) {
    const observation = review.replyObservation?.status === 'recorded' ? '已录入对方回应；效果尚未评估。' : '对方结果未知；效果尚未评估。';
    $('style-review-list').append(el('article', { class: 'style-review', 'data-review-id': review.id },
      el('p', { class: 'small muted' }, '原 AI 建议 · 保存的原文'), el('p', { class: 'style-source' }, review.originalSuggestion?.reply || '旧记录缺少完整来源'),
      el('p', { class: 'small muted' }, '我的改写 · 自述草稿，发送未确认'), el('p', { class: 'style-source' }, review.ownVersion),
      el('p', {}, `原建议风格：${styleFitNames[review.styleFit] || '暂不判断'} · 对这种表达或方向：${styleWillingnessNames[review.willingness] || '暂未决定'}`),
      ...(review.why ? [el('p', {}, `自述原因：${review.why}`)] : []), el('p', { class: 'helper' }, observation)));
  }
}
async function loadStyleLearning() {
  const userId = state.me?.user.id, serial = ++state.styleReadSerial;
  if (!userId) return;
  const data = await api('/api/style-learning');
  if (state.me?.user.id !== userId || serial !== state.styleReadSerial) return;
  if (state.styleLearning && data.revision < state.styleLearning.revision) return;
  state.styleLearning = data; renderStyleLearning();
}
function resetStyleDraft() {
  state.styleCase = null; state.styleReviewDirty = false; state.styleSupersedesId = null;
  for (const id of ['style-own-version', 'style-why', 'style-rule-text', 'style-rule-conditions', 'style-rule-limits']) $(id).value = '';
  $('style-fit').value = 'unknown'; $('style-willingness').value = 'undecided'; $('style-reason-kind').value = 'unknown'; $('style-rule-target').value = 'current_preference'; $('style-apply').checked = false;
  $('style-case').hidden = true; $('style-case-empty').hidden = false; $('style-original').textContent = ''; $('style-replacement').hidden = true;
}
function openStylePreferences() {
  if (!state.me) return;
  if (!state.styleCase && state.suggestion) {
    state.styleCase = { userId: state.me.user.id, counterpartId: state.selectedId, suggestionId: state.suggestion.id, original: state.suggestion.reply || '' };
    $('style-original-label').textContent = `原 AI 建议 · ${state.detail?.counterpart.alias || '本次案例'} · 保存的原文`;
    $('style-original').textContent = state.styleCase.original;
    $('style-own-version').value = $('suggestion-text').value;
    renderStyleObservation();
    $('style-case').hidden = false; $('style-case-empty').hidden = true;
  }
  openInlineCard('profile-view'); $('style-preferences').open = true;
  // The entry lives in a narrow overlay; close it so the inline editor is reachable.
  closeFieldCoach();
  $('style-preferences').scrollIntoView({ block: 'start', behavior: 'auto' });
  (state.styleCase ? $('style-own-version') : $('style-rule-text')).focus({ preventScroll: true });
}
function renderStyleObservation() {
  const previous = state.styleLearning?.reviews.find((review) => review.suggestionId === state.styleCase?.suggestionId && review.ownVersion === $('style-own-version').value.trim());
  $('style-observation').textContent = previous?.replyObservation?.status === 'recorded'
    ? '已录入对方回应；效果尚未评估。自己的偏好与对方回应分别记录。'
    : '对方结果：未知；尚未评估效果。自己的偏好与对方回应分别记录。';
}
function profileInput() {
  captureAnswers();
  const kind = $('questionnaire-kind').value;
  return { background: $('profile-background').value.trim(), style: $('profile-style').value.trim(), growthGoals: $('profile-growth').value.trim(), relationshipGoal: $('profile-goal').value.trim(), questionnaire: { kind, answers: Object.fromEntries((state.meta.questionnaires[kind] || []).map((question) => [question.id, state.questionnaireAnswers[question.id]])) } };
}
function styleDraftInput() {
  const learning = {};
  const text = $('style-rule-text').value.trim();
  if (!text && ($('style-apply').checked || $('style-rule-conditions').value.trim() || $('style-rule-limits').value.trim() || state.styleSupersedesId)) throw new Error('新增或改写规则时，请先填写表达规则；未保存的内容仍保留。');
  if (state.styleCase && (state.styleReviewDirty || text)) learning.review = { counterpartId: state.styleCase.counterpartId, suggestionId: state.styleCase.suggestionId, ownVersion: $('style-own-version').value.trim(), why: $('style-why').value.trim(), reasonKind: $('style-reason-kind').value, styleFit: $('style-fit').value, willingness: $('style-willingness').value };
  if (text) learning.ruleChange = { type: $('style-apply').checked ? 'adopt_new' : 'propose', rule: { target: $('style-rule-target').value, text, conditions: $('style-rule-conditions').value.trim(), limits: $('style-rule-limits').value.trim() }, ...(state.styleSupersedesId ? { supersedesId: state.styleSupersedesId } : {}) };
  return learning;
}
async function saveProfile(button, { ruleChange, includeDraft = false } = {}) {
  if (!$('profile-form').reportValidity()) return;
  const userId = state.me?.user.id, counterpartId = state.selectedId, draftVersion = state.profileDraftVersion, hadProfile = Boolean(state.me?.profile?.background), actionHadFocus = document.activeElement === button;
  const scope = { userId, counterpartId };
  await perform(button, '保存画像…', async () => {
    if (!state.styleLearning) throw new Error('请先重新读取规则，再保存画像。你的草稿仍保留。');
    const expectedRevision = state.styleLearning.revision;
    const changes = includeDraft ? styleDraftInput() : { ...(ruleChange ? { ruleChange } : {}) };
    const input = profileInput();
    const key = JSON.stringify(['style-save', userId, expectedRevision, input, changes]);
    if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID());
    let data;
    try { data = await put('/api/profile', { ...input, styleLearning: { requestId: state.requestIds.get(key), expectedRevision, ...changes } }); }
    catch (error) {
      if (error.code === 'STYLE_REVISION_CONFLICT' || error.code === 'STYLE_RULE_STATE_INVALID') throw new Error('画像或规则版本已变化。你的草稿仍保留；请点「重新读取规则」，检查最新内容后手动保存，不会自动重试。');
      throw error;
    }
    state.requestIds.delete(key);
    if (state.me?.user.id !== userId) return;
    state.styleLearning = data.styleLearning; renderStyleLearning();
    if (state.selectedId !== counterpartId) return;
    await reloadMe({ expectedUserId: userId });
    if (state.me?.user.id !== userId || state.selectedId !== counterpartId) return;
    if (counterpartId) await loadCounterpart(counterpartId, { autoAnalyze: !hadProfile && !changes.review && !changes.ruleChange, preserveComposer: true });
    if (state.me?.user.id !== userId || state.selectedId !== counterpartId) return;
    if (includeDraft && state.profileDraftVersion === draftVersion) resetStyleDraft();
    if (!includeDraft && actionHadFocus && document.activeElement === document.body) {
      const ruleId = changes.ruleChange?.candidateId || changes.ruleChange?.ruleId;
      const card = ruleId ? $('style-rule-list').querySelector(`[data-rule-id="${CSS.escape(ruleId)}"]`) : null;
      if (card) card.tabIndex = -1;
      (card?.querySelector('button') || card || $('style-preferences').querySelector('summary')).focus({ preventScroll: true });
    }
    const adopted = changes.ruleChange?.type === 'adopt' || changes.ruleChange?.type === 'adopt_new';
    announce(adopted ? '表达规则已采用。后续辅助会使用你的私有规则；本次保存没有调用模型，可自主重新分析。' : changes.ruleChange?.type === 'revoke' ? '规则已停用，后续辅助不再使用。本次保存没有调用模型。' : changes.ruleChange?.type === 'propose' ? '候选规则已保存，尚未应用；本次保存没有调用模型。' : '画像与自述评价已保存。本次保存没有调用模型。');
    if (includeDraft && state.profileDraftVersion === draftVersion && !changes.review && !changes.ruleChange) showView('coach');
  }, scope);
}
function saveRuleAction(button, ruleChange) { return saveProfile(button, { ruleChange }); }
async function loadCounterparts() {
  const data = await api('/api/counterparts');
  state.counterparts = data.counterparts || [];
  state.topThree = data.topThree || [];
  renderDirectory();
  if (state.selectedId && !state.counterparts.some((item) => item.id === state.selectedId)) state.selectedId = null;
  if (!state.selectedId && state.counterparts.length) await loadCounterpart(state.counterparts[0].id);
}
function renderDirectory() {
  $('counterpart-select').replaceChildren(...state.counterparts.map((person) => {
    const rank = state.topThree.indexOf(person.id);
    return el('option', { value: person.id }, `${person.alias}${rank >= 0 ? ` · 优先 ${rank + 1}` : ''}`);
  }));
  if (!state.counterparts.length) $('counterpart-select').append(el('option', { value: '' }, '添加一位对象'));
  $('counterpart-select').value = state.selectedId || '';
}
async function loadCounterpart(id, { autoAnalyze = true, preserveComposer = false } = {}) {
  const serial = ++state.detailRequestSerial;
  const userId = state.me?.user.id;
  const previousId = state.detail?.counterpart.id;
  if (previousId && previousId !== id) state.intentDrafts.set(previousId, $('intent').value);
  const changed = previousId !== id;
  const keepComposer = preserveComposer && !changed;
  if (changed) { closeInlineCards(); closeFieldCoach(); }
  state.selectedId = id;
  if (changed) { $('counterpart-workspace').hidden = true; $('empty-state').hidden = true; if ($('coach-error')) $('coach-error').hidden = true; }
  if (changed) { state.detail = null; state.suggestion = null; updateComposer(); renderFieldCoach(null); renderFieldCoachPlan(); }
  renderDirectory();
  const detail = await api(counterpartPath(id));
  if (state.selectedId !== id || state.me?.user.id !== userId || serial !== state.detailRequestSerial) return;
  state.detail = detail;
  if (!state.planDrafts.has(planDraftKey()) && detail.latestCoachPlan) {
    state.planDrafts.set(planDraftKey(), detail.latestCoachPlan.plan);
    state.planResults.set(JSON.stringify([currentContextKey(), detail.latestCoachPlan.plan]), { planAssessment: detail.latestCoachPlan.planAssessment });
  }
  if (changed) $('intent').value = state.intentDrafts.get(id) || '';
  state.selectedDirection = null;
  if (!keepComposer) {
    state.editingMessageId = null;
    $('message-form').reset();
    $('editing-message').textContent = '';
    $('cancel-message-edit').hidden = true;
  }
  $('empty-state').hidden = true;
  $('counterpart-workspace').hidden = false;
  $('counterpart-title').textContent = '模拟微信';
  $('counterpart-select').setAttribute('aria-label', `选择聊天对象，当前是${detail.counterpart.alias}`);
  $('counterpart-channel').textContent = `${channelNames[detail.counterpart.channel] || '认识背景'} · 此前约 ${detail.counterpart.rounds ?? 0} 轮`;
  $('counterpart-background').textContent = detail.counterpart.background || '';
  renderHeat(detail.heat);
  renderTranscript();
  renderTiming();
  renderClassification(detail.classification);
  renderJobs(detail.jobs || []);
  const currentId = state.suggestion?.id;
  const suggestions = detail.suggestions || [];
  state.suggestion = suggestions.find((item) => item.id === currentId && item.pendingEligible === true) || suggestions.findLast((item) => item.pendingEligible === true && item.pendingCopyReceiptId) || suggestions.findLast((item) => item.pendingEligible === true) || null;
  renderSuggestion();
  fillMeeting(detail.meeting);
  updateComposer();
  if (changed) scrollToLatest();
  updateCoachBusy();
  renderFieldCoachPlan();
  if (autoAnalyze) maybeAutoCoach();
}
function renderJobs(jobs) {
  let history = $('job-history');
  if (!history) {
    history = el('details', { id: 'job-history' }, el('summary', {}, '最近操作状态'), el('div', { id: 'job-list' }));
    $('coach-panel').append(history);
  }
  history.hidden = !jobs.length;
  const states = { reserved: '等待处理', running: '正在处理', linked: '关联已有操作', succeeded: '已完成', failed: '已失败' };
  const errorNames = { JOB_INTERRUPTED: '服务重启中断，可重新尝试', PROVIDER_TIMEOUT: '模型超时，可重新尝试', INVALID_MODEL_OUTPUT: '结果未通过校验，可重新尝试', CONTEXT_CHANGED: '资料已变化，请按新背景重新尝试', CLASSIFICATION_QUOTA_EXHAUSTED: '方向试用已用完', PROVIDER_BUDGET_EXHAUSTED: '今日模型预算已用完' };
  const refresh = el('button', { type: 'button', class: 'quiet-button', onclick: () => void perform(refresh, '读取状态…', async () => { const id = state.selectedId; await loadCounterpart(id, { autoAnalyze: false }); await reloadMe(); announce('已读取保存状态，没有调用模型。'); }) }, '刷新保存状态');
  $('job-list').replaceChildren(...jobs.slice(0, 4).map((job) => el('p', { class: 'small muted' }, `${({ classify: '方向分析', reply: '回复生成', coach_plan: '场外教练评估' }[job.operation] || '模型操作')} · ${states[job.state] || '状态待确认'}${job.errorCode ? ` · ${errorNames[job.errorCode] || '操作未完成，可查看错误后重试'}` : ''}`)), refresh);
}
async function refreshCounterpart(id, { autoAnalyze = false, preserveComposer = false } = {}) {
  await loadCounterparts();
  if (state.selectedId === id) await loadCounterpart(id, { autoAnalyze, preserveComposer });
}
function renderHeat(heat) {
  $('heat-status').textContent = heatNames[heat?.status] || '信息不足';
  $('heat-explanation').textContent = heat?.explanation || '补充认识背景和真实对话后再判断。未观察到，不等于负向。';
  const dimensions = heat?.dimensions || state.detail?.classification?.heat || {};
  const known = Object.values(dimensions).filter((item) => item?.level && item.level !== 'unknown').length;
  const messages = new Map((state.detail?.messages || []).map((message) => [message.id, message]));
  $('heat-dimensions').replaceChildren(...Object.entries(dimensionNames).map(([key, name]) => {
    const dimension = dimensions[key] || { level: 'unknown', evidenceIds: [] };
    const card = el('div', { class: 'heat-dimension' }, el('strong', {}, name), el('span', { class: `level ${dimension.level === 'unknown' ? 'unknown' : ''}` }, levelNames[dimension.level] || '未知'));
    if (dimension.evidenceIds?.length) {
      const evidence = el('details', {}, el('summary', {}, `查看 ${dimension.evidenceIds.length} 条依据`));
      for (const id of dimension.evidenceIds) {
        const message = messages.get(id);
        evidence.append(el('p', {}, message ? `${message.speaker === 'self' ? '我' : '对方'}：${message.text}` : `消息引用：${id}`));
      }
      card.append(evidence);
    }
    return card;
  }));
  const trend = heat?.trend?.status;
  $('heat-confidence').textContent = `${confidenceNames[heat?.confidence] || '证据有限'} · 已观察 ${known}/5 个维度 · ${trend === 'up' || trend === 'rising' ? '有上升迹象' : trend === 'down' || trend === 'falling' ? '有下降迹象' : trend === 'stable' ? '目前变化不明显' : '趋势暂不确定'}。阶段与权重尚未校准。`;
}
function renderTranscript() {
  const messages = state.detail?.messages || [];
  $('message-count').textContent = `${messages.length} 条记录`;
  $('transcript').replaceChildren(...messages.map((message) => {
    const controls = el('details', { class: 'message-menu chat-menu' });
    controls.append(el('summary', { 'aria-label': `${message.speaker === 'self' ? '我的' : '对方的'}消息操作` }, '⋯'), el('div', { class: 'chat-menu-items' },
      el('button', { class: 'quiet-button', type: 'button', 'aria-label': `编辑${message.speaker === 'self' ? '我' : '对方'}的消息`, onclick: () => { controls.open = false; editMessage(message); } }, '编辑'),
      el('button', { class: 'quiet-button', type: 'button', 'aria-label': '修改消息时间', onclick: () => { controls.open = false; editMessageTiming(message, controls); } }, '修改时间'),
      el('button', { class: 'quiet-button danger', type: 'button', 'aria-label': '删除这条消息', onclick: (event) => { closeMenu(controls, { restoreFocus: true }); void perform(event.currentTarget, '删除中…', () => deleteMessage(message)); } }, '删除')));
    const recordedAt = message.recordedAt || message.createdAt;
    const date = new Date(recordedAt);
    const recordedTime = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '';
    const reportedDate = new Date(message.wechatTime?.at);
    const reportedTime = message.wechatTime?.source === 'user_reported' && Number.isFinite(reportedDate.getTime()) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(reportedDate) : '';
    const label = message.speaker === 'self' ? message.provenance === 'inferred_from_followup' ? '我 · 推定使用' : '我' : state.detail.counterpart.alias;
    return el('article', { class: `message ${message.speaker === 'self' ? 'self' : 'other'}`, 'data-message-id': message.id }, el('span', { class: 'message-label', title: reportedTime ? `本人标注的微信时间 ${message.wechatTime.at}（未核验）；原软件录入时间 ${recordedAt}` : recordedAt ? `本软件录入时间 ${recordedAt}，不是微信实际收发时间` : '录入时间未知' }, `${label}${reportedTime ? ` · 标注 ${reportedTime}` : recordedTime ? ` · 录入 ${recordedTime}` : ''}`), el('div', { class: 'message-row' }, el('div', { class: 'message-bubble' }, message.text), controls));
  }));
  if (!messages.length) $('transcript').append(el('p', { class: 'helper' }, '还没有对话。按说话人逐条加入原文，也可以先补充此前背景。'));
}
function editMessageTiming(message, menu) {
  const id = state.selectedId, userId = state.me?.user.id;
  document.querySelectorAll('.message-time-edit').forEach((form) => form.remove());
  const input = el('input', { type: 'datetime-local', 'aria-label': '本人补充的微信消息时间', step: '60' });
  const existing = new Date(message.wechatTime?.at || message.recordedAt || message.createdAt);
  if (Number.isFinite(existing.getTime())) {
    const local = new Date(existing.getTime() - existing.getTimezoneOffset() * 60000);
    input.value = local.toISOString().slice(0, 16);
  }
  const form = el('form', { class: 'message-time-edit message-time-editor' }, el('label', {}, '本人补充的微信时间（未核验）', input), el('p', { class: 'small muted' }, '原录入时间保留；留空可清除标注。'));
  const save = el('button', { type: 'submit', class: 'quiet-button' }, '保存时间');
  const cancel = el('button', { type: 'button', class: 'quiet-button', onclick: () => { form.remove(); menu.querySelector('summary').focus({ preventScroll: true }); } }, '收起');
  form.append(el('div', { class: 'button-row' }, save, cancel));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void perform(save, '保存时间…', async () => {
      const actualWechatAt = input.value ? new Date(input.value).toISOString() : null;
      await api(`${counterpartPath(id)}/messages/${encodeURIComponent(message.id)}/timing`, { method: 'PATCH', body: { actualWechatAt } });
      if (state.selectedId !== id || state.me?.user.id !== userId) return;
      await refreshCounterpart(id, { preserveComposer: true });
      if (state.selectedId === id) { announce('时间标注已保存，原录入时间保留。方向判断已失效，可重新分析。'); $('message-text').focus({ preventScroll: true }); }
    }, { userId, counterpartId: id });
  });
  menu.closest('.message').append(form);
  input.focus({ preventScroll: true });
  form.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}
function renderTiming() {
  const timing = [...(state.detail?.messages || [])].reverse().find((message) => message.speaker === 'other')?.replyInterval;
  $('timing-note').hidden = !timing;
  if (!timing) { $('timing-note').textContent = ''; return; }
  const elapsed = timing.elapsedMs;
  const elapsedText = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed < 60000 ? '不足 1 分钟' : elapsed < 3600000 ? `约 ${Math.floor(elapsed / 60000)} 分钟` : `约 ${(elapsed / 3600000).toFixed(1)} 小时` : '未知';
  const from = timing.fromSource === 'user_reported_wechat_sent' ? '本人标注的上一轮发送' : timing.fromSource === 'clipboard_copied' ? '上一轮复制' : timing.fromSource === 'suggestion_prepared' ? '上一轮建议生成' : '上一轮表达';
  $('timing-note').textContent = `距${from}${elapsedText}（${timing.reliability === 'user_reported_interval' ? '本人补充的收发间隔，未核验' : timing.reliability === 'weak_preparation_estimate' ? '生成到录入的弱估计' : timing.reliability === 'unknown' ? '间隔未知' : '录入估计'}，非微信实际回复速度）。`;
}
function editMessage(message) {
  state.editingMessageId = message.id;
  $('message-speaker').value = message.speaker;
  $('message-text').value = message.text;
  $('editing-message').textContent = '正在编辑已有消息';
  $('cancel-message-edit').hidden = false;
  $('save-message').textContent = '保存修改';
  updateComposer();
  $('message-text').focus();
}
function cancelMessageEdit() {
  state.editingMessageId = null;
  $('message-form').reset();
  $('editing-message').textContent = '';
  $('cancel-message-edit').hidden = true;
  updateComposer();
}
async function deleteMessage(message) {
  if (!confirm('删除这条对话记录？相关的旧判断将失效。')) return;
  const id = state.selectedId;
  await api(`${counterpartPath(id)}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
  await refreshCounterpart(id);
  announce('消息已删除，后续辅助将使用更新后的记录。');
}
function classificationUnavailable() {
  return state.me?.user.plan !== 'paid' && state.me?.quota?.classificationRemaining === 0;
}
function renderClassification(classification) {
  renderFieldCoach(classification);
  const busy = state.modelCalls.get(currentContextKey());
  const options = new Map((classification?.options || []).map((option) => [option.topicMove, option]));
  const available = options.size === 3;
  $('classification-summary').textContent = available
    ? `${confidenceNames[classification.confidence] || '证据有限'}${classification.status === 'needs_context' ? ' · 还需要更多背景' : ''}。建议占比是相对推荐，尚未校准；点任一方向生成。`
    : classificationUnavailable() ? '方向分析试用已用完，直接给一句；本轮不展示虚构百分比。'
      : busy?.type === 'classify' ? '正在分析三个方向…' : '等待方向分析；暂无建议占比。';
  $('direction-options').replaceChildren(...['up', 'down', 'sideways'].map((direction) => {
    const option = options.get(direction);
    const button = el('button', { type: 'button', class: 'direction-option', disabled: !option || Boolean(busy), 'aria-pressed': String(state.selectedDirection === direction), 'aria-label': `${directionNames[direction].split(' · ')[0]}，${option ? `建议占比 ${Math.round(option.weight * 100)}%` : busy?.type === 'classify' ? '分析中' : '待分析'}`, 'data-direction': direction,
      onclick: () => { chooseDirection(direction); void coachCall('reply', button, { direction }); } },
      el('span', { class: 'direction-name' }, directionNames[direction].split(' · ')[0]),
      el('span', { class: 'weight' }, option ? `${Math.round(option.weight * 100)}%` : busy?.type === 'classify' ? '分析中' : '待分析'));
    button.title = option ? `${actionNames[option.relationAction] || '当前动作'} · ${option.reason}` : directionNames[direction];
    button.classList.toggle('selected', state.selectedDirection === direction);
    return button;
  }));
}
function closeFieldCoach({ restoreFocus = false } = {}) {
  const inside = $('field-coach').contains(document.activeElement);
  $('field-coach').dataset.open = 'false';
  $('toggle-field-coach').setAttribute('aria-expanded', 'false');
  if (restoreFocus && inside) $('toggle-field-coach').focus({ preventScroll: true });
}
function renderFieldCoach(classification) {
  const coach = classification?.fieldCoach;
  $('field-coach-topic').textContent = coach?.currentTopic || '当前话题待判断';
  $('field-coach-state').textContent = coach ? `${topicStatusNames[coach.topicStatus] || topicStatusNames.unknown}${coach.warmingLayer && coach.warmingLayer !== 'none' ? ` · 升温层次 ${coach.warmingLayer}` : ''}` : '记录对方的新话后，结合完整对话判断。';
  $('field-coach-initiative').textContent = coach?.initiative || '结合完整话题，给出下一步主导建议。';
  $('field-coach-next').textContent = coach ? `${coach.nextAction}${coach.reason ? ` · ${coach.reason}` : ''}` : '';
  const messages = new Map((state.detail?.messages || []).map((message) => [message.id, message]));
  const evidence = (coach?.topicMessageIds || []).map((id) => messages.get(id)).filter(Boolean);
  $('field-coach-evidence').textContent = evidence.length ? `依据 ${evidence.length} 条话题记录：${evidence.slice(-3).map((message) => `${message.speaker === 'self' ? '我' : '对方'}：${message.text}`).join(' / ')}` : '';
}
function planDraftKey() { return JSON.stringify([state.me?.user.id, state.selectedId]); }
function renderFieldCoachPlan() {
  const key = planDraftKey();
  $('field-coach-plan').value = state.planDrafts.get(key) || '';
  const busy = state.planCalls.has(currentContextKey());
  const ready = Boolean(state.me && state.detail && state.selectedId);
  $('field-coach-plan-submit').disabled = !ready || busy;
  $('field-coach-plan-submit').textContent = busy ? '教练正在看…' : '问场外教练';
  const result = state.planResults.get(JSON.stringify([currentContextKey(), $('field-coach-plan').value.trim()]));
  $('field-coach-plan-result').replaceChildren();
  if (busy) { $('field-coach-plan-result').textContent = '正在结合完整话题看这个计划…'; return; }
  if (!result) return;
  if (result.error) { $('field-coach-plan-result').textContent = result.error; return; }
  const assessment = result.planAssessment;
  $('field-coach-plan-result').append(el('p', {}, `${planVerdictNames[assessment.verdict] || '建议待判断'} · ${assessment.reason}`),
    el('p', {}, `${planTimingNames[assessment.timingSuggestion?.status] || planTimingNames.unknown}：${assessment.timingSuggestion?.guidance || '还没有足够的时机依据。'}`));
  if (assessment.adjustedPlan) $('field-coach-plan-result').append(el('p', {}, `可以改成：${assessment.adjustedPlan}`));
  $('field-coach-plan-result').append(el('p', {}, `下一步：${assessment.nextAction}`));
}
function chooseDirection(direction) {
  state.selectedDirection = direction;
  $('direction-options').querySelectorAll('button').forEach((button) => {
    button.classList.toggle('selected', button.dataset.direction === direction);
    button.setAttribute('aria-pressed', String(button.dataset.direction === direction));
  });
  const option = state.detail?.classification?.options?.find((item) => item.topicMove === direction);
  if (option) $('classification-summary').textContent = `建议占比尚未校准。${actionNames[option.relationAction] || '当前动作'} · ${option.reason}`;
}
function currentContextKey() { return JSON.stringify([state.me?.user.id, state.selectedId, state.detail?.counterpart, state.detail?.messages, state.detail?.meeting, state.me?.profile]); }
function requestId(type, id, direction = '', intent = '') {
  const contextKey = JSON.stringify([type, id, direction, intent, currentContextKey()]);
  if (!state.requestIds.has(contextKey)) state.requestIds.set(contextKey, crypto.randomUUID());
  return { id: state.requestIds.get(contextKey), key: contextKey };
}
function updateCoachBusy() {
  const busy = state.modelCalls.get(currentContextKey());
  $('coach-loading').hidden = !busy;
  if (busy) $('coach-loading').textContent = busy.type === 'classify' ? '正在结合完整体系与当前背景分析三个方向…' : '正在生成回复，请稍候。';
  $('coach-panel').setAttribute('aria-busy', String(Boolean(busy)));
  $('classify').disabled = Boolean(busy);
  $('direct-reply').disabled = Boolean(busy);
  renderClassification(state.detail?.classification);
}
function maybeAutoCoach() {
  if (!state.me?.profile?.background || state.me.requiresQuestionnaireUpdate || state.me.profile.requiresQuestionnaireUpdate || !state.detail?.messages?.some(({ speaker }) => speaker === 'other')) return;
  if (state.detail.classification) return;
  const context = currentContextKey();
  if (state.autoAttempts.has(context) || state.modelCalls.has(context)) return;
  const exhausted = classificationUnavailable();
  const attempted = state.detail.modelContext?.[exhausted ? 'directReplyAttempted' : 'classificationAttempted'];
  if (attempted || exhausted && state.detail.directReply) return;
  state.autoAttempts.add(context);
  void coachCall(exhausted ? 'reply' : 'classify', null, { automatic: true });
}
async function coachCall(type, button, { direction, automatic = false } = {}) {
  if (button?.disabled || !state.selectedId || !state.detail || !state.me) return;
  const id = state.selectedId, userId = state.me.user.id, inputContext = currentContextKey();
  if (state.modelCalls.has(inputContext)) return;
  state.autoAttempts.add(inputContext);
  state.modelCalls.set(inputContext, { type, id });
  closeInlineCards();
  const intent = type === 'reply' && !automatic ? $('intent').value.trim() : '';
  const request = requestId(type, id, direction, intent);
  let localError = $('coach-error');
  if (!localError) { localError = el('p', { id: 'coach-error', class: 'form-error', role: 'alert' }); $('coach-loading').after(localError); }
  localError.hidden = true;
  updateCoachBusy();
  try {
    const data = await post(`${counterpartPath(id)}/${type}`, { requestId: request.id, ...(type === 'reply' ? { ...(direction ? { direction } : {}), ...(intent ? { intent } : {}) } : {}) });
    state.requestIds.delete(request.key);
    if (state.me?.user.id !== userId) return;
    updateQuota(data.quota);
    if (state.selectedId === id && currentContextKey() === inputContext) {
      if (type === 'classify') {
        state.detail.classification = data.classification; state.detail.heat = data.heat;
        renderHeat(data.heat);
      } else {
        state.suggestion = data.suggestion;
        const suggestions = state.detail.suggestions || (state.detail.suggestions = []);
        if (!suggestions.some((item) => item.id === data.suggestion.id)) suggestions.push(data.suggestion);
        if (!direction && !intent) state.detail.directReply = data.suggestion;
        renderSuggestion(); scrollToLatest();
      }
      announce(data.cached ? '已取回保存结果，没有重复调用模型。' : type === 'classify' ? '' : '建议已生成，修改后自行发到微信；粘贴对方下一句即可继续。');
    }
    await loadCounterparts();
  } catch (error) {
    if (state.me?.user.id !== userId) return;
    const recoverExisting = !error.status || error.code === 'JOB_IN_PROGRESS';
    if (!recoverExisting) state.requestIds.delete(request.key);
    const retryMessage = `${error.message} ${recoverExisting ? '可点击按钮取回结果。' : '可手动重新尝试。'}不会自动重试。`;
    if (state.selectedId === id && currentContextKey() === inputContext) {
      announce(retryMessage, 'error'); localError.textContent = retryMessage; localError.hidden = false;
    }
    try { await reloadMe(); } catch { /* Preserve the original recovery state. */ }
    if (['REQUEST_ID_CONTEXT_CONFLICT', 'CONTEXT_CHANGED'].includes(error.code) && state.selectedId === id) {
      try { await loadCounterpart(id, { autoAnalyze: false }); } catch { /* No automatic retry. */ }
    }
    if ((error.code === 'FULL_PROFILE_REQUIRES_UPDATE' || error.code === 'PROFILE_REQUIRED') && state.selectedId === id) { fillProfile(); showView('profile'); }
    if (error.code === 'CLASSIFICATION_QUOTA_EXHAUSTED' && automatic && state.selectedId === id && currentContextKey() === inputContext) {
      state.modelCalls.delete(inputContext); updateCoachBusy();
      void coachCall('reply', null, { automatic: true });
    }
    if (state.selectedId === id) {
      try { const detail = await api(counterpartPath(id)); if (state.selectedId === id) renderJobs(detail.jobs || []); } catch { /* Read only. */ }
    }
  } finally {
    if (state.modelCalls.get(inputContext)?.type === type) state.modelCalls.delete(inputContext);
    if (state.selectedId === id && currentContextKey() === inputContext) updateCoachBusy();
  }
}
function renderSuggestion() {
  const suggestion = state.suggestion;
  const suggestions = state.detail?.suggestions || [];
  $('suggestion-history').hidden = !suggestions.length;
  $('suggestion-list').replaceChildren(...[...suggestions].reverse().map((item) => el('button', { type: 'button', class: 'history-button', 'data-suggestion-id': item.id, onclick: () => {
    if (state.suggestion) state.suggestionDrafts.set(state.suggestion.id, $('suggestion-text').value);
    state.suggestion = item; renderSuggestion();
  } }, `${actionNames[item.action] || '回复'} · ${item.reply || '建议等待或暂停'}`)));
  $('suggestion-panel').hidden = !suggestion;
  if (!suggestion) { $('suggestion-text').value = ''; updateComposer(); return; }
  const relatedMessage = [...(state.detail?.messages || [])].reverse().find((message) => message.speaker === 'self' && message.suggestionId === suggestion.id);
  $('suggestion-text').value = state.suggestionDrafts.get(suggestion.id) ?? suggestion.pendingReplyText ?? relatedMessage?.text ?? suggestion.reply ?? '';
  $('suggestion-action').textContent = actionNames[suggestion.action] || '建议';
  $('suggestion-reason').textContent = suggestion.reason || '';
  $('suggestion-style').textContent = suggestion.styleNote || '';
  updateSentState(); updateComposer();
}
function updateSentState() {
  if (!state.suggestion) return;
  const eligible = state.suggestion.pendingEligible === true;
  $('suggestion-title').textContent = eligible ? '我 · AI 建议' : '历史 AI 建议 · 仅供查看';
  $('sent-state').textContent = eligible ? '修改后自行发到微信；粘贴对方下一句即可继续。系统不会自动确认你发过这段话。' : '这条历史建议不会默认关联续聊。若重新复制使用，复制记录仍不等于已确认发送。';
}
function fillMeeting(meeting) {
  $('meeting-kind').value = meeting?.status || 'none';
  $('meeting-time').value = meeting?.time || '';
  $('meeting-place').value = meeting?.place || '';
  $('meeting-note').value = meeting?.note || '';
  $('meeting-status').textContent = meetingNames[meeting?.status || 'none'];
  updateMeetingRequirements();
}
function updateMeetingRequirements() {
  const confirmed = $('meeting-kind').value === 'confirmed';
  $('meeting-time').required = confirmed;
  $('meeting-place').required = confirmed;
}
function updateIntakeChannel() {
  const channel = $('intake-channel').value;
  $('app-profile-field').hidden = channel !== 'app';
  $('offline-scene-field').hidden = channel !== 'offline';
  $('intake-app').required = channel === 'app';
  $('intake-offline').required = channel === 'offline';
}
function openCounterpart(person = null) {
  state.editingCounterpartId = person?.id || null;
  $('counterpart-form').reset();
  $('counterpart-dialog-title').textContent = person ? '编辑认识背景' : '添加聊天对象';
  for (const [id, key] of [['intake-alias', 'alias'], ['intake-channel', 'channel'], ['intake-app', 'appProfile'], ['intake-offline', 'offlineScene'], ['intake-background', 'background']]) $(id).value = person?.[key] || (key === 'channel' ? 'app' : '');
  $('intake-rounds').value = person?.rounds ?? 0;
  updateIntakeChannel();
  $('delete-counterpart').hidden = !person;
  openInlineCard('counterpart-dialog');
  $('intake-alias').focus();
}
async function copyText(text, confirmation = '已复制。请检查表达，再由你手动发送。') {
  if (!text.trim()) { announce('当前没有可复制的文本。', 'error'); return false; }
  try { await navigator.clipboard.writeText(text); announce(confirmation); return true; }
  catch { announce('浏览器未允许复制。请选中文本手动复制。', 'error'); return false; }
}
async function loadAdmin() {
  if (state.localDemo || state.me.user.role !== 'owner') return;
  const [records, users] = await Promise.all([api('/api/admin/feedback'), api('/api/admin/users')]);
  $('admin-users').replaceChildren(...users.users.map((user) => {
    const select = el('select', { 'aria-label': `${user.username}的内测权限` }, el('option', { value: 'free' }, '免费'), el('option', { value: 'paid' }, '付费内测'));
    select.value = user.plan;
    const save = el('button', { class: 'small-button', type: 'button', onclick: () => void perform(save, '保存中…', async () => { await put(`/api/admin/users/${encodeURIComponent(user.id)}/plan`, { plan: select.value }); await loadAdmin(); if (user.id === state.me.user.id) await reloadMe(); announce('内测权限已更新。'); }) }, '保存');
    const tokenResult = el('div', { class: 'mcp-token-result', hidden: '' });
    const tokenButton = el('button', { class: 'quiet-button', type: 'button', onclick: () => void perform(tokenButton, '创建密钥…', async () => {
      if (!confirm(`为 ${user.username} 创建新的账号 MCP 接入密钥？该账号原密钥会失效。`)) return;
      const data = await post(`/api/admin/users/${encodeURIComponent(user.id)}/mcp-token`, {});
      const field = el('input', { type: 'password', readonly: '', autocomplete: 'off', 'aria-label': '账号 MCP 接入密钥' });
      field.value = data.token;
      const copy = el('button', { type: 'button', class: 'small-button', onclick: () => void copyText(field.value, '接入密钥已复制，请妥善保管。') }, '复制密钥');
      tokenResult.replaceChildren(el('p', { class: 'small muted' }, '仅绑定此账号，不能读取体系原文；有效期 30 天，只在本次页面显示。'), field, copy);
      tokenResult.hidden = false;
      announce('新的账号接入密钥已创建，原密钥已撤销。');
    }) }, '创建 MCP 接入密钥');
    return el('div', { class: 'admin-user-wrap' }, el('div', { class: 'admin-user' }, el('div', {}, el('strong', {}, user.username), el('p', {}, `${user.role === 'owner' ? 'Owner' : '内测用户'} · ${user.id}`)), el('div', { class: 'button-row' }, select, save)), tokenButton, tokenResult);
  }));
  const feedback = records.feedback || [];
  $('feedback-count').textContent = `${feedback.length} 条记录`;
  $('admin-feedback-list').replaceChildren(...feedback.map(renderAdminFeedback));
  if (!feedback.length) $('admin-feedback-list').append(el('p', { class: 'helper' }, '尚未收到反馈。收到后先清洗，再决定是否采用。'));
}
function inferredFeedback(record) { return record.raw?.sourceMode === 'beta_followup' || record.raw?.caseEvidence?.actualSend === 'inferred_from_followup'; }
function feedbackText(record) {
  const raw = record.raw?.payload || record.raw?.feedback || record.raw || {};
  return [raw.actualSentText ? `${inferredFeedback(record) ? '推定上一轮草稿（发送未确认）' : '实际发送'}：${raw.actualSentText}` : '', raw.counterpartReply ? `对方后续：${raw.counterpartReply}` : '', raw.observation ? `用户观察：${raw.observation}` : '', `类型：${{ positive: '有效做法', pitfall: '雷点', uncertain: '不确定' }[raw.kind] || '待确认'}`, `使用许可：${raw.consent ? '已同意清洗审阅' : '未获得许可'}`].filter(Boolean).join('\n\n');
}
function renderAdminFeedback(record) {
  const stageNames = { raw_untrusted: '未清洗', clean_candidate: '已清洗候选', cleaned_candidate: '已清洗候选', approved_candidate: '已批准候选', owner_reviewed: '已审阅', approved_use: '已批准使用', rejected: '已拒绝', quarantined: '隔离待补充' };
  const cleanButton = el('button', { class: 'secondary', type: 'button', disabled: Boolean(record.review), onclick: () => void perform(cleanButton, '清洗中…', async () => { await post(`/api/admin/feedback/${encodeURIComponent(record.id)}/clean`, {}); await loadAdmin(); announce('清洗结果已记录；是否采用仍需人工审阅。'); }) }, record.review ? '此记录已审阅' : record.cleaning ? '重新清洗' : '清洗这条反馈');
  const card = el('article', { class: 'feedback-review' }, el('div', { class: 'section-heading' }, el('div', {}, el('h3', {}, record.user?.username || '内测用户'), el('p', { class: 'small muted' }, record.id)), el('span', { class: 'badge' }, stageNames[record.stage] || record.stage)), el('pre', {}, feedbackText(record)), cleanButton);
  if (record.cleaning) {
    const cleaning = record.cleaning;
    const summary = el('div', {}, el('h3', {}, '清洗记录'));
    const issueNames = { source_id: '缺少来源记录', suggestion_record: '缺少建议记录', knowledge_version: '缺少知识版本', actual_sent_text: '缺少实际发送文本', actual_sent_record: '缺少已发送记录', observed_outcome: '缺少后续观察', observed_counterpart_reply: '缺少对方后续原话', embedded_instruction: '内容夹带指令', outcome_label_conflict: '标签与对方回应存在矛盾', actual_sent_record_mismatch: '与已发送记录不一致', suggestion_identity_mismatch: '建议来源不一致', duplicate: '重复样本' };
    const transformNames = { known_identifier: '人物代号', national_id: '证件号码', email: '邮箱', phone: '电话', contact_handle: '联系方式', address: '地址' };
    for (const [key, name] of [['transformations', '处理'], ['missing', '缺失依据'], ['flags', '问题'], ['missingEvidence', '缺失依据'], ['issues', '问题'], ['reasons', '说明'], ['unresolved', '待确认']]) {
      if (cleaning[key]?.length) summary.append(el('p', { class: 'helper' }, `${name}：${Array.isArray(cleaning[key]) ? cleaning[key].map((item) => typeof item === 'string' ? issueNames[item] || item : `${transformNames[item.kind] || '敏感信息'}已替换 ${item.count || 0} 处`).join('；') : cleaning[key]}`));
    }
    if (cleaning.cleaned) summary.append(el('pre', {}, [`${inferredFeedback(record) ? '清洗后推定上一轮草稿（发送未确认）' : '清洗后实际发送'}：${cleaning.cleaned.actualSentText || ''}`, `清洗后回应：${cleaning.cleaned.counterpartReply || ''}`, `清洗后观察：${cleaning.cleaned.observation || ''}`].join('\n\n')));
    card.append(summary);
    const form = el('form', {}, el('h3', {}, '人工审阅'));
    const purpose = el('select', {}, el('option', { value: 'knowledge' }, '知识补充'), el('option', { value: 'evaluation' }, '独立评估'));
    const conditions = el('textarea', { rows: 2, maxlength: 4000, placeholder: '这条经验适用于什么情境？' });
    const limits = el('textarea', { rows: 2, maxlength: 4000, placeholder: '证据局限、例外或不适用情况' });
    const note = el('textarea', { rows: 2, maxlength: 4000, placeholder: '采用或拒绝的依据' });
    const savedReview = record.review?.review || record.review;
    if (savedReview) {
      purpose.value = savedReview.purpose || record.review.purpose || 'knowledge';
      conditions.value = savedReview.conditions || '';
      limits.value = savedReview.limits || '';
      note.value = savedReview.note || '';
      for (const field of [purpose, conditions, limits, note]) field.disabled = true;
    }
    form.append(el('label', {}, '批准用途', purpose), el('div', { class: 'form-grid' }, el('label', {}, '适用条件', conditions), el('label', {}, '限制', limits)), el('label', {}, '审阅说明', note));
    const review = async (decision, button) => {
      if (decision === 'approve' && (!conditions.value.trim() || !limits.value.trim())) { announce('批准前请写明适用条件和局限。', 'error'); return; }
      await perform(button, '保存审阅…', async () => { await post(`/api/admin/feedback/${encodeURIComponent(record.id)}/review`, { decision, purpose: purpose.value, conditions: conditions.value.trim(), limits: limits.value.trim(), note: note.value.trim() }); await loadAdmin(); announce(decision === 'approve' ? '审阅已保存。只有获得许可且已清洗的候选可被批准使用。' : '拒绝决定已保存，原始记录保留可追溯。'); });
    };
    const approve = el('button', { class: 'primary', type: 'button', disabled: Boolean(record.review) || cleaning.stage !== 'clean_candidate' || !cleaning.consent || !cleaning.allowedPurposes?.length, onclick: () => void review('approve', approve) }, '批准指定用途');
    const reject = el('button', { class: 'quiet-button danger', type: 'button', disabled: Boolean(record.review), onclick: () => void review('reject', reject) }, '拒绝');
    form.append(el('div', { class: 'button-row' }, approve, reject));
    card.append(form);
  }
  if (record.review) {
    const review = record.review.review || record.review;
    card.append(el('p', { class: 'helper' }, `审阅决定：${review.decision === 'approve' ? '批准' : '拒绝'}${review.note ? ` · ${review.note}` : ''}`));
  }
  return card;
}

$('login-tab').addEventListener('click', () => setAuthMode('login'));
$('register-tab').addEventListener('click', () => setAuthMode('register'));
$('auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.localDemo) return;
  void perform($('auth-submit'), '正在进入…', async () => {
    if (state.authMode === 'register' && ($('password').value.length < 10 || !/[\p{L}]/u.test($('password').value) || !/\d/.test($('password').value))) throw new Error('密码需至少 10 个字符，并同时包含字母和数字。');
    const data = await post(`/api/${state.authMode}`, { username: $('username').value.trim(), password: $('password').value, ...(state.authMode === 'register' ? { invite: $('invite').value.trim() } : {}) });
    state.csrf = data.csrfToken;
    $('password').value = '';
    await enterWorkspace();
    announce(state.authMode === 'register' ? '注册成功。先完成真实画像，再开始辅助。' : '已登录，继续你的聊天记录。');
  });
});
function clearSessionUI() {
  state.me = null; state.csrf = ''; state.selectedId = null; state.detail = null; state.suggestion = null;
  state.counterparts = []; state.requestIds.clear(); state.suggestionDrafts.clear();
  state.intentDrafts.clear(); state.planDrafts.clear(); state.planResults.clear(); state.planCalls.clear(); state.copyReceipts.clear(); state.autoAttempts.clear(); state.modelCalls.clear(); state.detailRequestSerial++; state.questionnaireAnswers = {};
  state.styleLearning = null; state.styleReadSerial++; state.profileDraftVersion++; resetStyleDraft(); renderStyleLearning();
  $('workspace').hidden = true; $('account-bar').hidden = true; $('auth').hidden = state.localDemo;
  $('counterpart-workspace').hidden = true; $('empty-state').hidden = false;
  $('profile-form').reset(); $('intent').value = ''; $('suggestion-text').value = '';
  for (const id of ['counterpart-select', 'transcript', 'direction-options', 'suggestion-list', 'questionnaire', 'admin-feedback-list', 'admin-users']) $(id).replaceChildren();
  for (const id of ['counterpart-background', 'suggestion-reason', 'suggestion-style', 'classification-summary']) $(id).textContent = '';
  $('counterpart-title').textContent = '模拟微信';
  $('generated-invite').value = ''; $('invite-result').hidden = true;
  $('counterpart-form').reset(); $('message-form').reset(); $('meeting-form').reset(); $('job-history')?.remove(); $('coach-error')?.remove();
  document.querySelectorAll('form .form-error').forEach((node) => node.remove());
  closeInlineCards(); closeFieldCoach(); updateComposer(); renderFieldCoach(null); renderFieldCoachPlan();
  if (!state.localDemo) $('username').focus();
}
$('logout').addEventListener('click', () => void perform($('logout'), '退出中…', async () => {
  if (state.localDemo) return;
  await post('/api/logout', {});
  clearSessionUI();
  announce('已退出。');
}));
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeInlineCards({ restoreFocus: true })));
document.addEventListener('click', (event) => { document.querySelectorAll('.chat-menu[open]').forEach((menu) => { if (!menu.contains(event.target)) closeMenu(menu); }); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const menus = [...document.querySelectorAll('.chat-menu[open]')];
  if (menus.length) menus.forEach((menu) => closeMenu(menu, { restoreFocus: true }));
  else if ($('field-coach').dataset.open === 'true') closeFieldCoach({ restoreFocus: true });
});
$('toggle-field-coach').addEventListener('click', () => {
  const open = $('field-coach').dataset.open !== 'true';
  $('field-coach').dataset.open = String(open);
  $('toggle-field-coach').setAttribute('aria-expanded', String(open));
  if (open) $('field-coach-plan').focus({ preventScroll: true });
});
$('close-field-coach').addEventListener('click', () => closeFieldCoach({ restoreFocus: true }));
$('field-coach-plan').addEventListener('input', () => { state.planDrafts.set(planDraftKey(), $('field-coach-plan').value); $('field-coach-plan-result').replaceChildren(); });
$('field-coach-plan-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = state.selectedId, userId = state.me?.user.id, context = currentContextKey(), plan = $('field-coach-plan').value.trim();
  if (!id || !state.detail || !userId || state.planCalls.has(context)) return;
  if (!plan) { $('field-coach-plan-result').textContent = '先写下你打算怎么主导这个话题。'; $('field-coach-plan').focus(); return; }
  const resultKey = JSON.stringify([context, plan]);
  const request = requestId('coach-plan', id, '', plan);
  state.planCalls.set(context, true); renderFieldCoachPlan();
  void (async () => {
    try {
      const data = await post(`${counterpartPath(id)}/coach-plan`, { requestId: request.id, plan });
      state.requestIds.delete(request.key);
      if (state.me?.user.id !== userId) return;
      state.planResults.set(resultKey, data); updateQuota(data.quota);
    } catch (error) {
      if (state.me?.user.id !== userId) return;
      if (error.status && error.code !== 'JOB_IN_PROGRESS') state.requestIds.delete(request.key);
      state.planResults.set(resultKey, { error: `${error.message} 可手动再问；不会自动重试。` });
    } finally {
      state.planCalls.delete(context);
      if (state.me?.user.id === userId && state.selectedId === id && currentContextKey() === context) renderFieldCoachPlan();
    }
  })();
});
$('counterpart-select').addEventListener('change', async (event) => {
  const id = event.target.value;
  if (!id || id === state.selectedId) return;
  event.target.disabled = true;
  try { await loadCounterpart(id); }
  catch (error) { announce(error.message, 'error'); }
  finally { event.target.disabled = false; }
});
for (const [button, card] of [['open-heat', 'heat-panel'], ['open-meeting', 'meeting-panel']]) $(button).addEventListener('click', () => {
  if (!state.detail) return;
  openInlineCard(card);
});
$('questionnaire-kind').addEventListener('change', () => { captureAnswers(); renderQuestionnaire($('questionnaire-kind').value); });
$('open-style-preferences').addEventListener('click', openStylePreferences);
$('style-own-version').addEventListener('input', renderStyleObservation);
$('style-cancel-draft').addEventListener('click', () => { resetStyleDraft(); state.profileDraftVersion++; $('style-rule-text').focus(); });
$('style-reload').addEventListener('click', () => void perform($('style-reload'), '读取规则…', async () => { await loadStyleLearning(); announce('已读取最新规则版本，未保存的画像与偏好草稿仍保留。可检查后手动保存，没有调用模型。'); }));
$('profile-form').addEventListener('input', (event) => { state.profileDraftVersion++; if (event.target.classList.contains('style-review-input')) state.styleReviewDirty = true; });
$('profile-form').addEventListener('change', (event) => { state.profileDraftVersion++; if (event.target.classList.contains('style-review-input')) state.styleReviewDirty = true; });
$('profile-form').addEventListener('invalid', (event) => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
$('profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveProfile(event.submitter, { includeDraft: true });
});
for (const id of ['add-counterpart', 'empty-add']) $(id).addEventListener('click', () => openCounterpart());
$('edit-counterpart').addEventListener('click', () => { if (state.detail) openCounterpart(state.detail.counterpart); });
$('intake-channel').addEventListener('change', updateIntakeChannel);
for (const id of ['close-counterpart-dialog', 'cancel-counterpart-dialog']) $(id).addEventListener('click', () => closeInlineCards({ restoreFocus: true }));
$('counterpart-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void perform(event.submitter, '保存中…', async () => {
    const input = { alias: $('intake-alias').value.trim(), channel: $('intake-channel').value, appProfile: $('intake-app').value.trim(), offlineScene: $('intake-offline').value.trim(), background: $('intake-background').value.trim(), rounds: Number($('intake-rounds').value) };
    const data = state.editingCounterpartId ? await put(counterpartPath(state.editingCounterpartId), input) : await post('/api/counterparts', input);
    closeInlineCards({ restoreFocus: true }); state.selectedId = data.counterpart.id; await loadCounterparts(); await loadCounterpart(data.counterpart.id); showView('coach'); announce('认识背景已保存。自己的猜测仍需要实际互动验证。');
  });
});
$('delete-counterpart').addEventListener('click', () => void perform($('delete-counterpart'), '删除中…', async () => {
  if (!confirm('删除这个对象及其关联的私有记录？此操作不能撤销。')) return;
  const id = state.selectedId;
  await api(counterpartPath(id), { method: 'DELETE' });
  for (const suggestion of state.detail?.suggestions || []) state.suggestionDrafts.delete(suggestion.id);
  state.intentDrafts.delete(id); state.requestIds.clear();
  state.selectedId = null; state.detail = null; state.suggestion = null;
  $('suggestion-text').value = ''; $('intent').value = '';
  for (const element of ['transcript', 'direction-options', 'suggestion-list', 'heat-dimensions']) $(element).replaceChildren();
  $('counterpart-title').textContent = '模拟微信'; $('counterpart-background').textContent = '';
  $('counterpart-workspace').hidden = true; $('empty-state').hidden = false;
  closeInlineCards(); updateComposer();
  await loadCounterparts(); announce('对象及其关联记录已删除。');
}));
$('cancel-message-edit').addEventListener('click', cancelMessageEdit);
$('message-speaker').addEventListener('change', updateComposer);
$('message-text').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (!$('save-message').disabled) $('message-form').requestSubmit($('save-message'));
});
$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const scope = { userId: state.me?.user.id, counterpartId: state.selectedId };
  void perform(event.submitter, '保存消息…', async () => {
    const id = state.selectedId, userId = state.me?.user.id;
    if (!id || !state.detail) throw new Error('先添加或选择一位聊天对象。');
    const body = { speaker: $('message-speaker').value, text: $('message-text').value.trim() };
    const editing = state.editingMessageId;
    if (editing) await put(`${counterpartPath(id)}/messages/${encodeURIComponent(editing)}`, body);
    else if (body.speaker === 'other') {
      const previousReplyText = state.suggestion?.pendingEligible === true ? $('suggestion-text').value.trim() : '';
      const copyReceipt = previousReplyText && (state.suggestion.pendingCopyReceiptId || state.copyReceipts.get(JSON.stringify([userId, id, state.suggestion.id, previousReplyText])));
      const followup = { text: body.text, ...(previousReplyText ? { previousSuggestionId: state.suggestion.id, previousReplyText, ...(copyReceipt ? { previousCopyReceiptId: copyReceipt } : {}) } : {}) };
      const key = JSON.stringify(['followup', userId, id, followup]);
      if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID());
      await post(`${counterpartPath(id)}/followup`, { ...followup, requestId: state.requestIds.get(key) });
      state.requestIds.delete(key);
    } else await post(`${counterpartPath(id)}/messages`, body);
    if (state.me?.user.id !== userId || state.selectedId !== id) return;
    cancelMessageEdit(); await refreshCounterpart(id, { autoAnalyze: !editing && body.speaker === 'other' });
    if (state.selectedId !== id) return;
    closeInlineCards(); scrollToLatest();
    announce(body.speaker === 'other' && !editing ? '对方的新消息已记录，后续回应只作为未核实反馈保存。' : '原话已记录。');
  }, scope);
});
$('classify').addEventListener('click', () => void coachCall('classify', $('classify')));
$('direct-reply').addEventListener('click', () => void coachCall('reply', $('direct-reply')));
$('suggestion-text').addEventListener('input', () => { if (state.suggestion) state.suggestionDrafts.set(state.suggestion.id, $('suggestion-text').value); updateSentState(); });
$('copy-reply').addEventListener('click', () => void perform($('copy-reply'), '复制中…', async () => {
  const id = state.selectedId, userId = state.me?.user.id, suggestionId = state.suggestion?.id, copiedText = $('suggestion-text').value;
  if (!id || !suggestionId || !copiedText.trim()) return;
  const copied = await copyText(copiedText);
  if (!copied) return;
  const key = JSON.stringify(['copy', userId, id, suggestionId, copiedText]);
  if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID());
  try {
    const data = await post(`${counterpartPath(id)}/suggestions/${encodeURIComponent(suggestionId)}/copied`, { copiedText, requestId: state.requestIds.get(key) });
    state.requestIds.delete(key);
    if (state.me?.user.id === userId) state.copyReceipts.set(JSON.stringify([userId, id, suggestionId, copiedText.trim()]), data.copyReceipt.id);
    if (state.me?.user.id === userId && state.selectedId === id) await refreshCounterpart(id, { preserveComposer: true });
  } catch (error) {
    if (state.me?.user.id === userId && state.selectedId === id) announce(`文本已复制，但复制时间未保存：${error.message} 仍可粘贴对方下一句继续。`, 'error');
  }
}));
$('meeting-kind').addEventListener('change', updateMeetingRequirements);
$('meeting-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void perform(event.submitter, '保存安排…', async () => {
    const id = state.selectedId;
    const data = await put(`${counterpartPath(id)}/meeting`, { status: $('meeting-kind').value, time: $('meeting-time').value.trim(), place: $('meeting-place').value.trim(), note: $('meeting-note').value.trim() });
    if (state.selectedId === id) {
      state.detail.meeting = data.meeting; fillMeeting(data.meeting);
      await refreshCounterpart(id);
      if (state.selectedId === id) announce('见面安排已记录，确认状态应以双方实际约定为准。');
    }
  });
});
$('reload-admin').addEventListener('click', () => void perform($('reload-admin'), '读取中…', loadAdmin));
$('invite-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void perform(event.submitter, '创建邀请…', async () => {
    const data = await post('/api/admin/invites', { plan: $('invite-plan').value });
    const invite = typeof data.invite === 'string' ? data.invite : data.invite?.token || data.invite?.code;
    if (!invite) throw new Error('邀请已创建，但返回结果缺少邀请码。请联系维护者核查，勿连续重复创建。');
    $('generated-invite').value = invite; $('invite-result').hidden = false; announce('单次邀请码已创建，请只分享给本次内测参与者。');
  });
});
$('copy-invite').addEventListener('click', () => void copyText($('generated-invite').value, '邀请码已复制。'));

function showStartup(message, { failed = false, restoreFocus = false } = {}) {
  const hadFocus = $('startup-status').contains(document.activeElement);
  $('startup-status').hidden = !message;
  $('startup-message').textContent = message;
  $('startup-message').className = failed ? 'form-error' : 'helper';
  $('startup-retry').hidden = !failed;
  if (!message && (hadFocus || restoreFocus)) {
    const next = !$('auth').hidden ? $('username') : $('message-text').disabled ? $('add-counterpart') : $('message-text');
    next.focus({ preventScroll: true });
  }
}
$('startup-retry').addEventListener('click', () => void boot());
async function boot() {
  if (state.bootLoading) return;
  const retryHadFocus = document.activeElement === $('startup-retry');
  state.bootLoading = true;
  $('startup-retry').disabled = true;
  $('auth').hidden = true;
  showStartup('正在打开聊天…');
  announce('正在连接内测工作区…', 'progress');
  try {
    state.meta = await api('/api/meta');
    applyDemoMode();
    const privacy = state.meta.privacy;
    if (typeof privacy === 'string') $('privacy-note').textContent = privacy;
    else if (privacy?.summary) $('privacy-note').textContent = privacy.summary;
    if (state.localDemo) {
      announce('正在打开本机演示…', 'progress');
      const session = await post('/api/demo/session', {});
      state.csrf = session.csrfToken;
      await enterWorkspace();
      if (typeof session.counterpartId === 'string' && state.counterparts.some(({ id }) => id === session.counterpartId) && state.selectedId !== session.counterpartId) await loadCounterpart(session.counterpartId);
      showStartup('', { restoreFocus: retryHadFocus });
      announce('');
      return;
    }
    try { await enterWorkspace(); showStartup('', { restoreFocus: retryHadFocus }); announce(''); }
    catch (error) {
      if (error.status === 401) { $('auth').hidden = false; showStartup('', { restoreFocus: retryHadFocus }); announce(''); }
      else throw error;
    }
  } catch (error) {
    $('workspace').hidden = true;
    $('auth').hidden = true;
    announce(error.message, 'error');
    showStartup(`${error.message} 可重试打开；不会自动调用模型。`, { failed: true });
  } finally { state.bootLoading = false; $('startup-retry').disabled = false; }
}
// Keep client limits within the authoritative domain schema.
for (const [id, maximum] of Object.entries({ password: 128, 'profile-style': 10000, 'profile-growth': 10000, 'profile-goal': 10000, 'intake-alias': 80, 'suggestion-text': 5000 })) $(id).maxLength = maximum;
$('intent').parentElement.firstChild.textContent = '本轮意图（用于回复生成）';
initializeTheme();
void boot();
