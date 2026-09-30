const $ = (id) => document.getElementById(id);
const state = {
  meta: null, me: null, csrf: '', authMode: 'login', localDemo: false, counterparts: [], topThree: [],
  selectedId: null, detail: null, selectedDirection: null, suggestion: null,
  editingMessageId: null, editingCounterpartId: null, requestIds: new Map(),
  questionnaireAnswers: {}, suggestionDrafts: new Map(),
  feedbackDrafts: new Map(), feedbackKey: null, intentDrafts: new Map(),
  activeInlineCard: null, inlineTrigger: null, bootLoading: false,
};
const directionNames = { up: '上切 · 看更大的类别', down: '下切 · 深入具体细节', sideways: '平移 · 关联另一个话题' };
const actionNames = { continue: '继续了解', warm: '自然升温', handle_obstacle: '承接阻力', clarify: '澄清', invite: '协商邀约', pause: '暂停投入', reply: '建议回复', wait: '先等待' };
const dimensionNames = { activeInteraction: '主动互动', responseEngagement: '回复参与', personalInterest: '对我的兴趣', reciprocalFlirting: '双向暧昧', actionFollowThrough: '行动兑现' };
const levelNames = { unknown: '未知', negative: '有负向信号', passive: '被动回应', positive: '积极参与', repeated_positive: '持续积极' };
const heatNames = { pause: '建议暂停', insufficient_evidence: '信息不足', too_low: '当前投入较低', potential: '可以继续建设', high_invite: '可协商见面' };
const confidenceNames = { limited: '证据有限', moderate: '证据中等', strong: '证据较充分' };
const channelNames = { app: '交友软件认识', offline: '线下认识', other: '其他渠道' };
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
async function perform(button, label, callback) {
  if (button?.disabled) return;
  const original = button?.textContent;
  const form = button?.closest('form');
  let localError = form?.querySelector('.form-error');
  if (localError) localError.hidden = true;
  if (button) { button.disabled = true; button.textContent = label; }
  try { return await callback(); }
  catch (error) {
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
const inlineCards = ['profile-view', 'counterpart-dialog', 'heat-panel', 'meeting-panel', 'feedback-panel', 'admin-view'];
function closeInlineCards({ restoreFocus = false } = {}) {
  const focusedInCard = state.activeInlineCard && $(state.activeInlineCard).contains(document.activeElement);
  const trigger = state.inlineTrigger;
  for (const id of inlineCards) $(id).hidden = true;
  state.activeInlineCard = null; state.inlineTrigger = null;
  if (restoreFocus && focusedInCard) {
    const triggerMenu = trigger?.closest('.chat-menu');
    const menuSummary = triggerMenu?.querySelector(':scope > summary');
    const insideClosedMenu = triggerMenu && !triggerMenu.open && trigger !== menuSummary;
    const visibleTrigger = !insideClosedMenu && trigger?.isConnected && trigger.matches('button,input,textarea,select,a[href],summary,[tabindex]') && trigger.getClientRects().length ? trigger : menuSummary || $('chat-menu').querySelector('summary');
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
  $('open-feedback').disabled = !ready || !state.suggestion;
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
async function reloadMe() {
  const me = await api('/api/me');
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
  await loadCounterparts();
  const requiresUpdate = state.me.requiresQuestionnaireUpdate || state.me.profile?.requiresQuestionnaireUpdate;
  showView(state.me.profile?.background && !requiresUpdate ? 'coach' : 'profile');
  if (requiresUpdate) announce('当前账号已改为免费内测。请补全并保存精简问卷后继续辅助，原完整版答案在后台保留。', 'error');
}
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
async function loadCounterpart(id) {
  saveFeedbackDraft();
  const previousId = state.detail?.counterpart.id;
  if (previousId && previousId !== id) state.intentDrafts.set(previousId, $('intent').value);
  const changed = previousId !== id;
  if (changed) closeInlineCards();
  state.selectedId = id;
  if (changed) { $('counterpart-workspace').hidden = true; $('empty-state').hidden = true; if ($('coach-error')) $('coach-error').hidden = true; }
  if (changed) { state.detail = null; state.suggestion = null; updateComposer(); }
  renderDirectory();
  const detail = await api(counterpartPath(id));
  if (state.selectedId !== id) return;
  state.detail = detail;
  if (changed) $('intent').value = state.intentDrafts.get(id) || '';
  state.selectedDirection = null;
  state.editingMessageId = null;
  $('message-form').reset();
  $('editing-message').textContent = '';
  $('cancel-message-edit').hidden = true;
  $('empty-state').hidden = true;
  $('counterpart-workspace').hidden = false;
  $('counterpart-title').textContent = '模拟微信';
  $('counterpart-select').setAttribute('aria-label', `选择聊天对象，当前是${detail.counterpart.alias}`);
  $('counterpart-channel').textContent = `${channelNames[detail.counterpart.channel] || '认识背景'} · 此前约 ${detail.counterpart.rounds ?? 0} 轮`;
  $('counterpart-background').textContent = detail.counterpart.background || '';
  renderHeat(detail.heat);
  renderTranscript();
  renderClassification(detail.classification);
  renderJobs(detail.jobs || []);
  const currentId = state.suggestion?.id;
  const suggestions = detail.suggestions || [];
  state.suggestion = suggestions.find((item) => item.id === currentId) || suggestions.at(-1) || null;
  renderSuggestion();
  fillMeeting(detail.meeting);
  updateComposer();
  if (changed) scrollToLatest();
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
  const refresh = el('button', { type: 'button', class: 'quiet-button', onclick: () => void perform(refresh, '读取状态…', async () => { const id = state.selectedId; await loadCounterpart(id); await reloadMe(); announce('已读取保存状态，没有调用模型。'); }) }, '刷新保存状态');
  $('job-list').replaceChildren(...jobs.slice(0, 4).map((job) => el('p', { class: 'small muted' }, `${job.operation === 'classify' ? '方向分析' : '回复生成'} · ${states[job.state] || '状态待确认'}${job.errorCode ? ` · ${errorNames[job.errorCode] || '操作未完成，可查看错误后重试'}` : ''}`)), refresh);
}
async function refreshCounterpart(id) {
  await loadCounterparts();
  if (state.selectedId === id) await loadCounterpart(id);
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
      el('button', { class: 'quiet-button danger', type: 'button', 'aria-label': '删除这条消息', onclick: (event) => { closeMenu(controls, { restoreFocus: true }); void perform(event.currentTarget, '删除中…', () => deleteMessage(message)); } }, '删除')));
    return el('article', { class: `message ${message.speaker === 'self' ? 'self' : 'other'}`, 'data-message-id': message.id }, el('span', { class: 'message-label' }, message.speaker === 'self' ? '我' : state.detail.counterpart.alias), el('div', { class: 'message-row' }, el('div', { class: 'message-bubble' }, message.text), controls));
  }));
  if (!messages.length) $('transcript').append(el('p', { class: 'helper' }, '还没有对话。按说话人逐条加入原文，也可以先补充此前背景。'));
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
function renderClassification(classification) {
  $('direction-options').replaceChildren();
  $('chosen-reply').hidden = true;
  $('classification-summary').textContent = '';
  state.selectedDirection = null;
  if (!classification?.options?.length) return;
  $('classification-summary').textContent = `${confidenceNames[classification.confidence] || '证据有限'}${classification.status === 'needs_context' ? ' · 还需要更多背景' : ''}。请选择一个方向；较低权重也可以生成。`;
  const preferred = [...classification.options].sort((a, b) => b.weight - a.weight)[0]?.topicMove;
  for (const option of classification.options) {
    const button = el('button', { type: 'button', class: 'direction-option', 'aria-pressed': 'false', 'data-direction': option.topicMove, onclick: () => chooseDirection(option.topicMove) }, el('span', { class: 'direction-name' }, directionNames[option.topicMove] || option.topicMove, el('span', { class: 'weight' }, `${Math.round(option.weight * 100)}%`)), el('p', {}, `${actionNames[option.relationAction] || '当前动作'} · ${option.reason}`));
    $('direction-options').append(button);
  }
  chooseDirection(preferred);
}
function chooseDirection(direction) {
  state.selectedDirection = direction;
  $('direction-options').querySelectorAll('button').forEach((button) => {
    button.classList.toggle('selected', button.dataset.direction === direction);
    button.setAttribute('aria-pressed', String(button.dataset.direction === direction));
  });
  $('chosen-reply').hidden = !direction;
  $('chosen-reply').textContent = direction ? `按${directionNames[direction].split(' · ')[0]}方向生成回复` : '按所选方向生成';
}
function requestId(type, id, direction = '', intent = '') {
  const contextKey = JSON.stringify([type, id, direction, intent, state.detail?.counterpart, state.detail?.messages, state.me?.profile]);
  if (!state.requestIds.has(contextKey)) state.requestIds.set(contextKey, crypto.randomUUID());
  return { id: state.requestIds.get(contextKey), key: contextKey };
}
function currentContextKey() { return JSON.stringify([state.selectedId, state.detail?.counterpart, state.detail?.messages, state.me?.profile]); }
async function coachCall(type, button) {
  if (button.disabled) return;
  closeInlineCards();
  const id = state.selectedId;
  if (!id) return;
  const userId = state.me?.user.id;
  const inputContext = currentContextKey();
  const direction = type === 'reply' && button.id === 'chosen-reply' ? state.selectedDirection : undefined;
  const intent = $('intent').value.trim();
  const request = requestId(type, id, direction, intent);
  let localError = $('coach-error');
  if (!localError) { localError = el('p', { id: 'coach-error', class: 'form-error', role: 'alert' }); $('coach-loading').after(localError); }
  localError.hidden = true;
  $('coach-loading').hidden = false;
  $('coach-loading').textContent = type === 'classify' ? '正在结合完整体系与当前背景分析，通常需要十几秒。失败可重试，不重复消耗同一上下文额度。' : '正在组织表达，请稍候。你可以在收到后修改再发送。';
  $('coach-panel')?.setAttribute('aria-busy', 'true');
  for (const control of [$('classify'), $('direct-reply'), $('chosen-reply')]) control.disabled = true;
  try {
    const data = await post(`${counterpartPath(id)}/${type}`, { requestId: request.id, ...(type === 'reply' ? { ...(direction ? { direction } : {}), ...(intent ? { intent } : {}) } : {}) });
    state.requestIds.delete(request.key);
    if (state.me?.user.id !== userId) return;
    updateQuota(data.quota);
    if (state.selectedId === id && currentContextKey() === inputContext) {
      if (type === 'classify') {
        state.detail.classification = data.classification;
        state.detail.heat = data.heat;
        renderHeat(data.heat);
        renderClassification(data.classification);
      } else {
        state.suggestion = data.suggestion;
        const suggestions = state.detail.suggestions || (state.detail.suggestions = []);
        if (!suggestions.some((item) => item.id === data.suggestion.id)) suggestions.push(data.suggestion);
        renderSuggestion();
        scrollToLatest();
      }
    }
    await loadCounterparts();
    announce(data.cached ? '已取回同一上下文的保存结果，没有重复调用模型。' : type === 'classify' ? '方向分析已保存。权重仅表示相对建议程度。' : '建议已保存；编辑后由你手动发送。');
  } catch (error) {
    if (state.me?.user.id !== userId) return;
    const recoverExisting = !error.status || error.code === 'JOB_IN_PROGRESS';
    if (!recoverExisting) state.requestIds.delete(request.key);
    const retryMessage = `${error.message} ${recoverExisting ? '稍后点击同一按钮取回该操作的结果。' : '可手动再次尝试，下一次会创建新操作。'}不会自动重试。`;
    announce(retryMessage, 'error');
    if (state.selectedId === id) { localError.textContent = retryMessage; localError.hidden = false; }
    try { await reloadMe(); } catch { /* Preserve the actionable original error. */ }
    if (['REQUEST_ID_CONTEXT_CONFLICT', 'CONTEXT_CHANGED'].includes(error.code) && state.selectedId === id) {
      try { await loadCounterpart(id); } catch { /* Keep the prior context readable. */ }
    }
    if (error.code === 'FULL_PROFILE_REQUIRES_UPDATE' || error.code === 'PROFILE_REQUIRED') { fillProfile(); showView('profile'); }
    if (state.selectedId === id) {
      try { const detail = await api(counterpartPath(id)); if (state.selectedId === id) renderJobs(detail.jobs || []); } catch { /* A failed read does not trigger another model operation. */ }
    }
  } finally {
    $('coach-loading').hidden = true;
    $('coach-panel')?.removeAttribute('aria-busy');
    for (const control of [$('classify'), $('direct-reply'), $('chosen-reply')]) control.disabled = false;
  }
}
function saveFeedbackDraft() {
  if (!state.feedbackKey) return;
  state.feedbackDrafts.set(state.feedbackKey, { sent: $('feedback-sent').value, reply: $('feedback-reply').value, observation: $('feedback-observation').value, kind: $('feedback-kind').value, consent: $('feedback-consent').checked, receipt: $('feedback-state').textContent });
}
function renderSuggestion() {
  saveFeedbackDraft();
  const suggestion = state.suggestion;
  $('suggestion-panel').hidden = !suggestion;
  $('feedback-panel').hidden = !suggestion || state.activeInlineCard !== 'feedback-panel';
  if (!suggestion) { state.feedbackKey = null; $('feedback-form').reset(); updateComposer(); return; }
  const relatedMessage = [...(state.detail?.messages || [])].reverse().find((message) => message.speaker === 'self' && message.suggestionId === suggestion.id);
  $('suggestion-text').value = state.suggestionDrafts.get(suggestion.id) ?? relatedMessage?.text ?? suggestion.reply ?? '';
  $('suggestion-action').textContent = actionNames[suggestion.action] || '建议';
  $('suggestion-reason').textContent = suggestion.reason || '';
  $('suggestion-style').textContent = suggestion.styleNote || '';
  updateSentState();
  state.feedbackKey = `${state.selectedId}:${suggestion.id}`;
  const feedback = state.feedbackDrafts.get(state.feedbackKey);
  $('feedback-form').reset();
  $('feedback-sent').value = feedback?.sent ?? relatedMessage?.text ?? $('suggestion-text').value;
  $('feedback-reply').value = feedback?.reply || '';
  $('feedback-observation').value = feedback?.observation || '';
  $('feedback-kind').value = feedback?.kind || 'uncertain';
  $('feedback-consent').checked = feedback?.consent || false;
  $('feedback-state').textContent = feedback?.receipt || '';
  const suggestions = state.detail?.suggestions || [];
  $('suggestion-history').hidden = suggestions.length < 2;
  $('suggestion-list').replaceChildren(...[...suggestions].reverse().map((item) => el('button', { type: 'button', class: 'history-button', onclick: () => { state.suggestionDrafts.set(suggestion.id, $('suggestion-text').value); state.suggestion = item; renderSuggestion(); } }, `${actionNames[item.action] || '回复'} · ${item.reply || '建议等待或暂停'}`)));
  updateComposer();
}
function updateSentState() {
  if (!state.suggestion) return;
  const text = $('suggestion-text').value.trim();
  const matching = (state.detail?.messages || []).filter((message) => message.speaker === 'self' && message.suggestionId === state.suggestion.id && message.text.trim() === text);
  const confirmed = matching.some((message) => message.provenance === 'user_confirmed_record');
  $('record-sent').disabled = confirmed || !text;
  $('record-sent').dataset.locked = String(confirmed || !text);
  $('suggestion-title').textContent = confirmed ? '我 · AI 建议，已记录发送' : '我 · AI 建议，待发送';
  $('sent-state').textContent = confirmed ? '已记录你确认发送的这个版本，后续可以补充对方反馈。' : matching.some((message) => message.provenance === 'user_entered_edit') ? '此前记录已被修改。请确认你实际发送的是这个版本，再重新记录。' : '请手动发到微信；这里仅记录你实际发送的版本。';
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
  if (!text.trim()) { announce('当前没有可复制的文本。', 'error'); return; }
  try { await navigator.clipboard.writeText(text); announce(confirmation); }
  catch { announce('浏览器未允许复制。请选中文本手动复制。', 'error'); }
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
function feedbackText(record) {
  const raw = record.raw?.payload || record.raw?.feedback || record.raw || {};
  return [raw.actualSentText ? `实际发送：${raw.actualSentText}` : '', raw.counterpartReply ? `对方后续：${raw.counterpartReply}` : '', raw.observation ? `用户观察：${raw.observation}` : '', `类型：${{ positive: '有效做法', pitfall: '雷点', uncertain: '不确定' }[raw.kind] || '待确认'}`, `使用许可：${raw.consent ? '已同意清洗审阅' : '未获得许可'}`].filter(Boolean).join('\n\n');
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
    if (cleaning.cleaned) summary.append(el('pre', {}, [`清洗后实际发送：${cleaning.cleaned.actualSentText || ''}`, `清洗后回应：${cleaning.cleaned.counterpartReply || ''}`, `清洗后观察：${cleaning.cleaned.observation || ''}`].join('\n\n')));
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
  state.feedbackDrafts.clear(); state.feedbackKey = null; state.intentDrafts.clear(); state.questionnaireAnswers = {};
  $('workspace').hidden = true; $('account-bar').hidden = true; $('auth').hidden = state.localDemo;
  $('counterpart-workspace').hidden = true; $('empty-state').hidden = false;
  $('feedback-form').reset(); $('profile-form').reset(); $('intent').value = ''; $('suggestion-text').value = '';
  for (const id of ['counterpart-select', 'transcript', 'direction-options', 'suggestion-list', 'questionnaire', 'admin-feedback-list', 'admin-users']) $(id).replaceChildren();
  for (const id of ['counterpart-background', 'suggestion-reason', 'suggestion-style', 'classification-summary']) $(id).textContent = '';
  $('counterpart-title').textContent = '模拟微信';
  $('generated-invite').value = ''; $('invite-result').hidden = true;
  $('counterpart-form').reset(); $('message-form').reset(); $('meeting-form').reset(); $('job-history')?.remove(); $('coach-error')?.remove();
  document.querySelectorAll('form .form-error').forEach((node) => node.remove());
  closeInlineCards(); updateComposer();
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
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.querySelectorAll('.chat-menu[open]').forEach((menu) => closeMenu(menu, { restoreFocus: true })); });
$('counterpart-select').addEventListener('change', async (event) => {
  const id = event.target.value;
  if (!id || id === state.selectedId) return;
  event.target.disabled = true;
  try { await loadCounterpart(id); }
  catch (error) { announce(error.message, 'error'); }
  finally { event.target.disabled = false; }
});
for (const [button, card] of [['open-heat', 'heat-panel'], ['open-meeting', 'meeting-panel'], ['open-feedback', 'feedback-panel'], ['reply-feedback', 'feedback-panel']]) $(button).addEventListener('click', () => {
  if (!state.detail || card === 'feedback-panel' && !state.suggestion) return;
  openInlineCard(card);
});
$('questionnaire-kind').addEventListener('change', () => { captureAnswers(); renderQuestionnaire($('questionnaire-kind').value); });
$('profile-form').addEventListener('invalid', (event) => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
$('profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void perform(event.submitter, '保存画像…', async () => {
    captureAnswers();
    const kind = $('questionnaire-kind').value;
    const answers = Object.fromEntries((state.meta.questionnaires[kind] || []).map((question) => [question.id, state.questionnaireAnswers[question.id]]));
    await put('/api/profile', { background: $('profile-background').value.trim(), style: $('profile-style').value.trim(), growthGoals: $('profile-growth').value.trim(), relationshipGoal: $('profile-goal').value.trim(), questionnaire: { kind, answers } });
    await reloadMe(); showView('coach'); if (state.selectedId) await loadCounterpart(state.selectedId); announce(state.localDemo ? '演示画像已保存，后续 AI 会使用更新后的演示内容。' : '画像已保存，后续辅助会使用更新后的真实背景与成长目标。');
  });
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
  for (const key of state.feedbackDrafts.keys()) if (key.startsWith(`${id}:`)) state.feedbackDrafts.delete(key);
  state.intentDrafts.delete(id); state.feedbackKey = null; state.requestIds.clear();
  state.selectedId = null; state.detail = null; state.suggestion = null;
  $('feedback-form').reset(); $('suggestion-text').value = ''; $('intent').value = '';
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
  void perform(event.submitter, '保存消息…', async () => {
    const id = state.selectedId;
    if (!id || !state.detail) throw new Error('先添加或选择一位聊天对象。');
    const body = { speaker: $('message-speaker').value, text: $('message-text').value.trim() };
    if (state.editingMessageId) await put(`${counterpartPath(id)}/messages/${encodeURIComponent(state.editingMessageId)}`, body);
    else await post(`${counterpartPath(id)}/messages`, body);
    cancelMessageEdit(); await refreshCounterpart(id); closeInlineCards(); scrollToLatest(); announce('原话已记录。需要建议时，点击对话里的“分析三个方向”。');
  });
});
$('classify').addEventListener('click', () => void coachCall('classify', $('classify')));
$('direct-reply').addEventListener('click', () => void coachCall('reply', $('direct-reply')));
$('chosen-reply').addEventListener('click', () => void coachCall('reply', $('chosen-reply')));
$('suggestion-text').addEventListener('input', () => { if (state.suggestion) state.suggestionDrafts.set(state.suggestion.id, $('suggestion-text').value); updateSentState(); });
$('copy-reply').addEventListener('click', () => void copyText($('suggestion-text').value));
$('record-sent').addEventListener('click', () => void perform($('record-sent'), '记录中…', async () => {
  const suggestion = state.suggestion;
  if (!suggestion || !$('suggestion-text').value.trim()) throw new Error('请先填写你实际发送的文本；建议等待时不需要记录消息。');
  const id = state.selectedId;
  const actualSentText = $('suggestion-text').value.trim();
  await post(`${counterpartPath(id)}/sent`, { suggestionId: suggestion.id, actualSentText });
  await refreshCounterpart(id); if (state.selectedId === id) $('feedback-sent').value = actualSentText; announce('已记录你确认发送的这个版本，未替你向微信发送。');
}));
$('feedback-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void perform(event.submitter, '提交反馈…', async () => {
    if (!state.suggestion) throw new Error('请先选择一条已保存的建议。');
    const id = state.selectedId;
    const feedbackKey = state.feedbackKey;
    const data = await post(`${counterpartPath(id)}/feedback`, { suggestionId: state.suggestion.id, actualSentText: $('feedback-sent').value.trim(), counterpartReply: $('feedback-reply').value.trim(), observation: $('feedback-observation').value.trim(), kind: $('feedback-kind').value, consent: $('feedback-consent').checked });
    if (state.feedbackKey === feedbackKey) { $('feedback-state').textContent = `已收到，状态：未清洗原始反馈。编号：${data.id}。收件成功不表示内容已验证或被采用。`; saveFeedbackDraft(); }
    announce('反馈已隔离保存。清洗与人工审阅后才能决定是否使用。');
  });
});
$('meeting-kind').addEventListener('change', updateMeetingRequirements);
$('meeting-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void perform(event.submitter, '保存安排…', async () => {
    const id = state.selectedId;
    const data = await put(`${counterpartPath(id)}/meeting`, { status: $('meeting-kind').value, time: $('meeting-time').value.trim(), place: $('meeting-place').value.trim(), note: $('meeting-note').value.trim() });
    if (state.selectedId === id) { state.detail.meeting = data.meeting; fillMeeting(data.meeting); }
    announce('见面安排已记录，确认状态应以双方实际约定为准。');
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
for (const [id, maximum] of Object.entries({ password: 128, 'profile-style': 10000, 'profile-growth': 10000, 'profile-goal': 10000, 'intake-alias': 80, 'suggestion-text': 5000, 'feedback-sent': 5000, 'feedback-reply': 5000, 'feedback-observation': 5000 })) $(id).maxLength = maximum;
$('intent').parentElement.firstChild.textContent = '本轮意图（用于回复生成）';
initializeTheme();
void boot();
