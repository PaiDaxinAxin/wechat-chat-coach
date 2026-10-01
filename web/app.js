const $ = (id) => document.getElementById(id);
const state = {
  meta: null, me: null, csrf: '', authMode: 'login', localDemo: false, counterparts: [], topThree: [],
  selectedId: null, detail: null, selectedDirection: null, suggestion: null, replyFeedback: null,
  editingMessageId: null, editingCounterpartId: null, requestIds: new Map(),
  questionnaireAnswers: {}, suggestionDrafts: new Map(),
  messageDrafts: new Map(), messageCalls: new Set(), timeCalls: new Map(), composerBeforeEdit: null, intakeDrafts: new Map(), intakeInstance: 0,
  composerImage: null, imageCalls: new Map(), imageSelectionSerial: 0,
  topicChangeContexts: new Set(), annotationDrafts: new Map(), annotationOpen: new Set(), annotationCalls: new Set(), annotationErrors: new Map(),
  intentDrafts: new Map(), planDrafts: new Map(), planResults: new Map(), planCalls: new Map(), copyReceipts: new Map(), copyCalls: new Set(), autoAttempts: new Set(), modelCalls: new Map(), detailRequestSerial: 0, replyRevision: 0,
  activeInlineCard: null, inlineTrigger: null, bootLoading: false,
  styleLearning: null, styleReadSerial: 0, styleCase: null, styleReviewDirty: false, styleSupersedesId: null, profileDraftVersion: 0,
};
const directionNames = { up: '上切 · 看更大的类别', down: '下切 · 深入具体细节', sideways: '平移 · 关联另一个话题' };
const actionNames = { continue: '继续了解', warm: '自然升温', handle_obstacle: '承接阻力', clarify: '澄清', invite: '协商邀约', pause: '暂停投入', reply: '建议回复', wait: '先等待' };
const relationMoveNames = { continue: '普通交流', deepen: '深入聊', push_pull: '轻松推拉', male_to_female: '男对女', light_approach: '轻度靠近', give_space: '拉开一点', receive: '承接', close_topic: '结束话题', clarify: '澄清', invite: '协商邀约', wait: '暂时不回', pause: '停止当前推进' };
const focusNames = { value_display: '价值展示', emotion: '情绪拉升', security: '安全需求', unknown: '待判断' };
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
    if (error.displayed) return;
    const message = error.message || '操作未完成，请重试。';
    announce(form?.isConnected && form.id !== 'auth-form' ? '' : message, 'error');
    if (form?.isConnected) {
      if (!localError) { localError = el('p', { class: 'form-error', role: 'alert' }); form.append(localError); }
      localError.textContent = message; localError.hidden = false;
      localError.scrollIntoView({ block: 'nearest' });
    }
  }
  finally {
    if (button?.isConnected) {
      button.disabled = button.dataset.locked === 'true'; button.textContent = original;
      if (button.id === 'save-message') updateComposer();
      if (button.id === 'retry-counterpart' && button.checkVisibility() && !button.disabled && document.activeElement === document.body
          && (!scope || state.me?.user.id === scope.userId && state.selectedId === scope.counterpartId)) button.focus({ preventScroll: true });
    }
  }
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
function rememberComposer({ changed = false } = {}) {
  const id = state.selectedId;
  if (!id || state.detail?.counterpart.id !== id) return null;
  const draft = { text: $('message-text').value, speaker: $('message-speaker').value, editingId: state.editingMessageId, beforeEdit: state.composerBeforeEdit, image: state.composerImage, meaning: $('message-meaning').value };
  const previous = state.messageDrafts.get(id);
  if (!changed && previous && Object.keys(draft).every((key) => previous[key] === draft[key])) return previous;
  state.messageDrafts.set(id, draft);
  return draft;
}
function restoreComposer(id) {
  const draft = state.messageDrafts.get(id);
  state.editingMessageId = draft?.editingId || null;
  state.composerBeforeEdit = draft?.beforeEdit || null;
  $('message-text').value = draft?.text || '';
  $('message-speaker').value = draft?.speaker || 'other';
  state.composerImage = draft?.image || null;
  $('message-meaning').value = draft?.meaning || '';
  $('editing-message').textContent = state.editingMessageId ? '正在编辑已有消息' : '';
  $('cancel-message-edit').hidden = !state.editingMessageId;
  const error = $('message-form').querySelector('.form-error');
  if (error) error.hidden = true;
}
function finishComposerSubmission(id, submitted) {
  // Clear only the submitted version. Typing or editing while a save is in
  // flight creates a new version, including after switching away and back.
  if (state.messageDrafts.get(id) !== submitted) return;
  if (submitted.beforeEdit) state.messageDrafts.set(id, submitted.beforeEdit);
  else state.messageDrafts.delete(id);
  if (state.selectedId === id) restoreComposer(id);
}
function updateComposer() {
  const ready = Boolean(state.selectedId && state.detail);
  const callKey = JSON.stringify([state.me?.user.id, state.selectedId]);
  const reading = state.imageCalls.has(callKey);
  const saving = state.messageCalls.has(callKey);
  const needsImageRead = Boolean(state.composerImage && !state.composerImage.interpretation);
  $('message-text').disabled = !ready;
  $('message-speaker').disabled = !ready || Boolean(state.composerImage);
  $('message-text').required = !needsImageRead;
  $('save-message').disabled = !ready || saving || reading;
  $('save-message').dataset.locked = String(!ready || saving || reading);
  $('save-message').textContent = reading ? '识读图片…' : saving ? '保存消息…' : needsImageRead ? '识读图片' : state.editingMessageId ? '保存修改' : $('message-speaker').value === 'self' ? '记录已发送' : '记录消息';
  $('message-text').placeholder = $('message-speaker').value === 'self' ? '填写你已经发出的原话…' : '粘贴对方刚说的话…';
  const canAttach = ready && !state.editingMessageId && $('message-speaker').value === 'other';
  $('add-message-image').disabled = !canAttach;
  $('message-image-file').disabled = !canAttach;
  $('message-meaning').disabled = !ready || $('message-speaker').value !== 'other' || Boolean(state.editingMessageId);
  $('message-meaning-details').hidden = $('message-speaker').value !== 'other' || Boolean(state.editingMessageId);
  $('message-image-preview').hidden = !state.composerImage;
  $('message-image-privacy').hidden = !state.composerImage;
  if (state.composerImage) $('message-image-thumbnail').src = state.composerImage.dataUrl;
  else $('message-image-thumbnail').removeAttribute('src');
  $('message-image-status').textContent = `${reading ? '正在识读，文字与补充意思仍可修改。' : state.composerImage?.interpretation ? '描述已放入草稿，可修改后记录。' : '图片已准备好，可先补充大概意思，再识读。'}本应用不长期保存原图，刷新会清除。`;
  $('message-image-result').hidden = !state.composerImage?.interpretation;
  $('message-image-description').textContent = state.composerImage?.interpretation?.description || '';
  $('message-image-uncertainty').textContent = state.composerImage?.interpretation?.uncertainty || '';
  for (const id of ['edit-counterpart', 'open-heat', 'open-meeting']) $(id).disabled = !ready;
}
async function attachMessageImage(file) {
  if (!file || $('add-message-image').disabled) return;
  const scope = { userId: state.me?.user.id, counterpartId: state.selectedId };
  const serial = ++state.imageSelectionSerial;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 1_000_000 || !file.size) { announce('请选择小于1MB的JPEG、PNG或WebP图片。', 'error'); return; }
  try {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片未读入，请重新选择。')); reader.readAsDataURL(file); });
    if (serial !== state.imageSelectionSerial || state.me?.user.id !== scope.userId || state.selectedId !== scope.counterpartId || state.editingMessageId || $('message-speaker').value !== 'other') return;
    state.composerImage = { id: crypto.randomUUID(), dataUrl, interpretation: null };
    rememberComposer({ changed: true }); updateComposer();
    $('message-meaning-details').open = true;
    $('message-meaning').focus({ preventScroll: true });
  } catch (error) { if (state.me?.user.id === scope.userId && state.selectedId === scope.counterpartId) announce(error.message, 'error'); }
}
async function readComposerImage(scope) {
  const id = scope.counterpartId, image = state.composerImage, submitted = rememberComposer();
  if (!image || image.interpretation) return;
  const callKey = JSON.stringify([scope.userId, id]);
  if (state.imageCalls.has(callKey)) return;
  const key = JSON.stringify(['image-read', scope.userId, id, image.id, submitted.meaning.trim()]);
  if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID());
  const call = { imageId: image.id }; state.imageCalls.set(callKey, call); updateComposer();
  try {
    const data = await post(`${counterpartPath(id)}/image-read`, { requestId: state.requestIds.get(key), image: image.dataUrl, explanation: submitted.meaning.trim() });
    state.requestIds.delete(key);
    if (state.me?.user.id !== scope.userId) return;
    updateQuota(data.quota);
    const current = state.messageDrafts.get(id);
    if (current?.image !== image || current.editingId || current.speaker !== 'other') return;
    const text = current.text === submitted.text ? [current.text.trim(), data.imageInterpretation.description].filter(Boolean).join('\n') : current.text;
    state.messageDrafts.set(id, { ...current, text, image: { ...image, interpretation: data.imageInterpretation } });
    if (state.selectedId === id) { const focusDraft = document.activeElement === $('save-message') || document.activeElement === document.body; restoreComposer(id); updateComposer(); if (focusDraft) $('message-text').focus({ preventScroll: true }); }
  } catch (error) { if (error.status && error.code !== 'JOB_IN_PROGRESS') state.requestIds.delete(key); throw error; }
  finally { if (state.imageCalls.get(callKey) === call) state.imageCalls.delete(callKey); if (state.me?.user.id === scope.userId) updateComposer(); }
}
function composerRecordText(draft) {
  const kind = draft.image?.interpretation?.kind;
  const parts = [draft.image ? `【图片记录·AI识读后可修改，不是准确原文${['screenshot', 'unknown'].includes(kind) ? '，可能包含双方内容' : ''}】\n${draft.text.trim()}` : draft.text.trim()];
  const ai = draft.image?.interpretation;
  if (ai && draft.text.trim() !== ai.description) parts.push(`【AI初次描述·可能有误】\n${ai.description}`);
  if (ai?.uncertainty) parts.push(`【识读不确定】\n${ai.uncertainty}`);
  if (draft.speaker === 'other' && !draft.editingId && draft.meaning.trim()) parts.push(`【用户补充意思·非对方原文】\n${draft.meaning.trim()}`);
  return parts.join('\n\n');
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
  $('quota-summary').textContent = `${remaining === null ? state.localDemo ? 'Demo 局面分析' : '付费内测局面分析' : `局面分析试用剩余 ${remaining ?? '—'} / 3 次`} · 今日模型调用剩余 ${quota.providerRemaining ?? '—'} 次`;
  const unavailable = state.me.user.plan !== 'paid' && remaining === 0;
  $('classify').hidden = unavailable;
  $('classify-availability').textContent = unavailable
    ? '局面分析试用已用完。仍可主动请求回复，或选择换题方向；不补造建议占比。'
    : '结合已保存的背景与完整对话判断当前动作。只有需要换话题时才展示三个方向；占比不是成功率。';
  const daily = quota.dailyReplyRemaining;
  $('daily-reply-quota').hidden = !Number.isInteger(daily);
  $('daily-reply-quota').textContent = Number.isInteger(daily) ? `今日免费 AI 回复剩余 ${daily} / 3 条 · 北京时间每日重置` : '';
  updateComposer();
  if (state.detail) updateCoachBusy();
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
    if (counterpartId) await loadCounterpart(counterpartId, { autoAnalyze: !hadProfile && !changes.review && !changes.ruleChange });
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
function showCounterpartLoading(message = '', failed = false) {
  $('counterpart-loading').hidden = !message;
  $('counterpart-loading-message').textContent = message;
  $('retry-counterpart').hidden = !failed;
}
async function loadCounterpart(id, { autoAnalyze = true } = {}) {
  const serial = ++state.detailRequestSerial;
  const retryHadFocus = document.activeElement === $('retry-counterpart');
  const replyRevision = state.replyRevision;
  const userId = state.me?.user.id;
  const previousId = state.detail?.counterpart.id;
  rememberComposer();
  if (previousId && previousId !== id) state.intentDrafts.set(previousId, $('intent').value);
  const changed = previousId !== id;
  if (changed) { closeInlineCards(); closeFieldCoach(); announce(''); showCounterpartLoading('正在读取这段对话…'); }
  state.selectedId = id;
  if (changed) { $('counterpart-workspace').hidden = true; $('empty-state').hidden = true; if ($('coach-error')) $('coach-error').hidden = true; }
  if (changed) { state.detail = null; state.suggestion = null; updateComposer(); renderFieldCoach(null); renderFieldCoachPlan(); }
  renderDirectory();
  let detail;
  try { detail = await api(counterpartPath(id)); }
  catch (error) {
    if (state.selectedId !== id || state.me?.user.id !== userId || serial !== state.detailRequestSerial) return;
    if (changed) {
      showCounterpartLoading('这段对话暂时没能加载，请重试；未提交的草稿仍保留。', true);
      error.displayed = true;
    }
    throw error;
  }
  if (state.selectedId !== id || state.me?.user.id !== userId || serial !== state.detailRequestSerial) return;
  // A concurrent reply may have completed after this read's snapshot. Read the
  // latest state instead of rolling back the reply or discarding incoming messages.
  if (replyRevision !== state.replyRevision) return loadCounterpart(id, { autoAnalyze });
  state.detail = detail;
  showCounterpartLoading();
  if (!state.planDrafts.has(planDraftKey()) && detail.latestCoachPlan) {
    state.planDrafts.set(planDraftKey(), detail.latestCoachPlan.plan);
    state.planResults.set(JSON.stringify([currentContextKey(), detail.latestCoachPlan.plan]), { planAssessment: detail.latestCoachPlan.planAssessment });
  }
  if (changed) $('intent').value = state.intentDrafts.get(id) || '';
  state.selectedDirection = null;
  if (changed) restoreComposer(id);
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
  const currentNoReply = (item) => isNoReplySuggestion(item) && (detail.currentSuggestionIds?.includes(item.id) || detail.directReply?.id === item.id);
  let restored = suggestions.find((item) => item.id === currentId && (isPendingSuggestion(item) || currentNoReply(item))) || suggestions.findLast((item) => isPendingSuggestion(item) && item.pendingCopyReceiptId) || suggestions.findLast((item) => isPendingSuggestion(item) || currentNoReply(item)) || null;
  const latestCurrent = suggestions.findLast((item) => detail.currentSuggestionIds?.includes(item.id) || detail.directReply?.id === item.id);
  if (isNoReplySuggestion(latestCurrent) && restored && suggestions.indexOf(restored) < suggestions.indexOf(latestCurrent)) {
    // An old clipboard receipt must not undo a later decision to wait. Only
    // explicitly copying that history again after the decision restores use.
    const copiedAfterDecision = isPendingSuggestion(restored) && restored.pendingCopyReceiptId && Date.parse(restored.pendingCopiedAt) > Date.parse(latestCurrent.createdAt);
    if (!copiedAfterDecision) restored = latestCurrent;
  }
  state.suggestion = restored;
  state.selectedDirection = state.modelCalls.get(currentContextKey())?.direction || state.suggestion?.direction || null;
  renderSuggestion();
  fillMeeting(detail.meeting);
  updateComposer();
  if (retryHadFocus && document.activeElement === document.body) $('message-text').focus({ preventScroll: true });
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
  const errorNames = { JOB_INTERRUPTED: '服务重启中断，可重新尝试', PROVIDER_TIMEOUT: '模型超时，可重新尝试', INVALID_MODEL_OUTPUT: '结果未通过校验，可重新尝试', CONTEXT_CHANGED: '资料已变化，请按新背景重新尝试', CLASSIFICATION_QUOTA_EXHAUSTED: '局面分析试用已用完', PROVIDER_BUDGET_EXHAUSTED: '今日模型预算已用完' };
  const refresh = el('button', { type: 'button', class: 'quiet-button', onclick: () => void perform(refresh, '读取状态…', async () => { const id = state.selectedId; await loadCounterpart(id, { autoAnalyze: false }); await reloadMe(); announce('已读取保存状态，没有调用模型。'); }) }, '刷新保存状态');
  $('job-list').replaceChildren(...jobs.slice(0, 4).map((job) => el('p', { class: 'small muted' }, `${({ classify: '局面分析', reply: '回复生成', coach_plan: '场外教练评估', image_read: '图片识读' }[job.operation] || '模型操作')} · ${states[job.state] || '状态待确认'}${job.errorCode ? ` · ${errorNames[job.errorCode] || '操作未完成，可查看错误后重试'}` : ''}`)), refresh);
}
async function refreshCounterpart(id, { autoAnalyze = false } = {}) {
  await loadCounterparts();
  if (state.selectedId === id) await loadCounterpart(id, { autoAnalyze });
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
  const focusedNote = document.activeElement.closest?.('.message-annotation');
  const focusedKey = focusedNote?.dataset.annotationKey;
  const selection = focusedNote && document.activeElement.tagName === 'TEXTAREA' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  $('message-count').textContent = `${messages.length} 条记录`;
  $('transcript').replaceChildren(...messages.map((message) => {
    const controls = el('details', { class: 'message-menu chat-menu' });
    controls.append(el('summary', { 'aria-label': `${message.speaker === 'self' ? '我的' : '对方的'}消息操作` }, '⋯'), el('div', { class: 'chat-menu-items' },
      el('button', { class: 'quiet-button', type: 'button', 'aria-label': `编辑${message.speaker === 'self' ? '我' : '对方'}的消息`, onclick: () => { controls.open = false; editMessage(message); } }, '编辑'),
      el('button', { class: 'quiet-button', type: 'button', 'aria-label': '修改消息时间', 'data-edit-time': '', disabled: state.timeCalls.has(JSON.stringify([state.me?.user.id, state.selectedId])), onclick: () => { controls.open = false; editMessageTiming(message, controls); } }, '修改时间'),
      el('button', { class: 'quiet-button danger', type: 'button', 'aria-label': '删除这条消息', onclick: (event) => { closeMenu(controls, { restoreFocus: true }); void perform(event.currentTarget, '删除中…', () => deleteMessage(message)); } }, '删除')));
    const recordedAt = message.recordedAt || message.createdAt;
    const date = new Date(recordedAt);
    const recordedTime = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '';
    const reportedDate = new Date(message.wechatTime?.at);
    const reportedTime = message.wechatTime?.source === 'user_reported' && Number.isFinite(reportedDate.getTime()) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(reportedDate) : '';
    const label = message.speaker === 'self' ? message.provenance === 'inferred_from_followup' ? '我 · 推定使用' : '我' : state.detail.counterpart.alias;
    return el('article', { class: `message ${message.speaker === 'self' ? 'self' : 'other'}`, 'data-message-id': message.id }, el('span', { class: 'message-label', title: reportedTime ? `消息时间 ${message.wechatTime.at}；原录入时间 ${recordedAt}` : recordedAt ? `录入时间 ${recordedAt}` : '录入时间未知' }, `${label}${reportedTime ? ` · 标注 ${reportedTime}` : recordedTime ? ` · 录入 ${recordedTime}` : ''}`), el('div', { class: 'message-row' }, el('div', { class: 'message-bubble' }, message.text), controls), messageAnnotation(message));
  }));
  if (!messages.length) $('transcript').append(el('p', { class: 'helper' }, '还没有对话。按说话人逐条加入原文，也可以先补充此前背景。'));
  if (focusedKey) {
    const note = [...document.querySelectorAll('.message-annotation')].find((element) => element.dataset.annotationKey === focusedKey);
    const input = note?.querySelector('textarea');
    if (note?.open && input && document.activeElement === document.body) { input.focus({ preventScroll: true }); if (selection) input.setSelectionRange(...selection); }
  }
}
function messageAnnotation(message) {
  const id = state.selectedId, userId = state.me?.user.id;
  const key = JSON.stringify([userId, id, message.id]);
  const note = el('details', { class: 'message-annotation', 'data-annotation-key': key });
  note.open = state.annotationOpen.has(key);
  const summary = el('summary', {}, message.annotation?.text ? '批注 · 已补背景' : '批注');
  const input = el('textarea', { rows: '2', maxlength: '5000', 'aria-label': '这条消息的背景批注', placeholder: '如：这句话接着线下的话题；她当时是在开玩笑。我的补充，不是对方原话。' });
  input.value = state.annotationDrafts.get(key)?.text ?? message.annotation?.text ?? '';
  const form = el('form', { class: 'message-annotation-form' }, el('label', {}, '背景批注 · 本人补充', input));
  const save = el('button', { class: 'quiet-button', type: 'submit', disabled: state.annotationCalls.has(key) }, state.annotationCalls.has(key) ? '保存批注…' : '保存批注');
  save.dataset.locked = String(state.annotationCalls.has(key));
  const close = el('button', { class: 'quiet-button', type: 'button', onclick: () => { note.open = false; state.annotationOpen.delete(key); summary.focus({ preventScroll: true }); } }, '收起');
  form.append(el('div', { class: 'button-row' }, save, close), el('p', { class: 'small muted' }, '只补充背景，不改原话；清空并保存可移除。'));
  if (state.annotationErrors.has(key)) form.append(el('p', { class: 'form-error', role: 'alert' }, state.annotationErrors.get(key)));
  input.addEventListener('input', () => state.annotationDrafts.set(key, { text: input.value }));
  note.addEventListener('toggle', () => { if (note.isConnected && state.me?.user.id === userId && state.selectedId === id) { if (note.open) state.annotationOpen.add(key); else state.annotationOpen.delete(key); } });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.annotationCalls.has(key)) return;
    const submitted = state.annotationDrafts.get(key) || { text: input.value };
    const hadFocus = form.contains(document.activeElement);
    state.annotationErrors.delete(key);
    state.annotationDrafts.set(key, submitted); state.annotationCalls.add(key); save.dataset.locked = 'true';
    void perform(save, '保存批注…', async () => {
      await api(`${counterpartPath(id)}/messages/${encodeURIComponent(message.id)}/annotation`, { method: 'PATCH', body: { annotationText: submitted.text } });
      if (state.me?.user.id !== userId) return;
      if (state.annotationDrafts.get(key) === submitted) state.annotationDrafts.delete(key);
      await refreshCounterpart(id, { autoAnalyze: false });
      if (state.me?.user.id === userId && state.selectedId === id) announce('背景批注已保存；后续建议会结合这段补充。');
    }, { userId, counterpartId: id }).finally(() => {
      const error = form.querySelector('.form-error');
      if (state.me?.user.id === userId && error && !error.hidden) state.annotationErrors.set(key, error.textContent);
      state.annotationCalls.delete(key); save.dataset.locked = 'false';
      if (state.me?.user.id === userId && state.selectedId === id) {
        renderTranscript();
        if (hadFocus && document.activeElement === document.body) [...document.querySelectorAll('.message-annotation')].find((element) => element.dataset.annotationKey === key && element.open)?.querySelector('textarea').focus({ preventScroll: true });
      }
    });
  });
  note.append(summary, form);
  return note;
}
function editMessageTiming(message, menu) {
  const id = state.selectedId, userId = state.me?.user.id;
  const key = JSON.stringify([userId, id]);
  if (state.timeCalls.has(key)) return;
  document.querySelectorAll('.message-time-edit').forEach((form) => form.remove());
  const recorded = new Date(message.wechatTime?.at || message.recordedAt || message.createdAt);
  const existing = Number.isFinite(recorded.getTime()) ? recorded : new Date();
  const localDate = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const hour = el('input', { type: 'text', inputmode: 'numeric', maxlength: '2', pattern: '[0-9]{1,2}', 'aria-label': '小时', autocomplete: 'off' });
  const minute = el('input', { type: 'text', inputmode: 'numeric', maxlength: '2', pattern: '[0-9]{1,2}', 'aria-label': '分钟', autocomplete: 'off' });
  hour.value = String(existing.getHours()).padStart(2, '0');
  minute.value = String(existing.getMinutes()).padStart(2, '0');
  const date = el('input', { type: 'date', 'aria-label': '消息日期' });
  date.value = localDate(existing);
  const dateSummary = el('summary');
  const showDate = () => {
    const value = new Date(`${date.value}T12:00:00`);
    dateSummary.textContent = Number.isFinite(value.getTime()) ? `日期 · ${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', ...(value.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }).format(value)} · 调整` : '选择日期';
  };
  date.addEventListener('input', showDate); showDate();
  const pickDay = (offset) => { const value = new Date(); value.setDate(value.getDate() + offset); date.value = localDate(value); showDate(); };
  const dateDetails = el('details', { class: 'message-time-date' }, dateSummary,
    el('div', { class: 'button-row' }, el('button', { type: 'button', class: 'secondary', onclick: () => pickDay(0) }, '今天'), el('button', { type: 'button', class: 'secondary', onclick: () => pickDay(-1) }, '昨天')),
    el('label', {}, '其他日期', date));
  const form = el('form', { class: 'message-time-edit message-time-editor' },
    el('fieldset', { class: 'message-time-fields' }, el('legend', {}, '消息时间'),
      el('div', { class: 'message-time-clock' }, el('label', {}, '时', hour), el('span', { 'aria-hidden': 'true' }, ':'), el('label', {}, '分', minute))), dateDetails);
  const save = el('button', { type: 'submit', class: 'primary' }, '保存时间');
  const cancel = el('button', { type: 'button', class: 'quiet-button', onclick: () => { form.remove(); menu.querySelector('summary').focus({ preventScroll: true }); } }, '收起');
  let saving = false;
  const persist = (button, clear = false) => {
    if (saving || state.timeCalls.has(key)) return;
    void perform(button, '保存时间…', async () => {
      const hours = hour.value.trim(), minutes = minute.value.trim();
      let actualWechatAt = null;
      if (!clear && (hours || minutes)) {
        if (!/^(?:[01]?[0-9]|2[0-3])$/.test(hours) || !/^[0-5]?[0-9]$/.test(minutes)) throw new Error('请填写 0–23 的小时和 0–59 的分钟。');
        if (!date.value) throw new Error('请选择消息日期。');
        const value = new Date(`${date.value}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00`);
        if (!Number.isFinite(value.getTime()) || localDate(value) !== date.value || value.getHours() !== Number(hours) || value.getMinutes() !== Number(minutes)) throw new Error('这个日期或时间无效，请调整后再保存。');
        actualWechatAt = value.toISOString();
      }
      saving = true;
      const call = {};
      state.timeCalls.set(key, call);
      document.querySelectorAll('[data-edit-time]').forEach((button) => { button.disabled = true; });
      const fields = [...form.querySelectorAll('input, button')];
      fields.forEach((field) => { field.disabled = true; });
      try {
        await api(`${counterpartPath(id)}/messages/${encodeURIComponent(message.id)}/timing`, { method: 'PATCH', body: { actualWechatAt } });
        if (state.selectedId !== id || state.me?.user.id !== userId) return;
        const restoreFocus = form.contains(document.activeElement) || document.activeElement === document.body;
        await refreshCounterpart(id, { autoAnalyze: false });
        if (state.selectedId === id && state.me?.user.id === userId) {
          announce(actualWechatAt ? '消息时间已更新，后续建议会按新时间判断。' : '已恢复录入时间。');
          if (restoreFocus && document.activeElement === document.body) $('message-text').focus({ preventScroll: true });
        }
      } finally {
        saving = false; fields.forEach((field) => { field.disabled = false; });
        if (state.timeCalls.get(key) === call) state.timeCalls.delete(key);
        document.querySelectorAll('[data-edit-time]').forEach((button) => { button.disabled = state.timeCalls.has(JSON.stringify([state.me?.user.id, state.selectedId])); });
      }
    }, { userId, counterpartId: id });
  };
  const clear = el('button', { type: 'button', class: 'quiet-button', onclick: () => persist(clear, true) }, '清除修改');
  clear.hidden = !message.wechatTime;
  form.append(el('div', { class: 'button-row' }, save, cancel, clear));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    persist(save);
  });
  menu.closest('.message').append(form);
  minute.focus({ preventScroll: true }); minute.select();
  form.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}
function renderTiming() {
  const timing = [...(state.detail?.messages || [])].reverse().find((message) => message.speaker === 'other')?.replyInterval;
  $('timing-note').hidden = !timing;
  if (!timing) { $('timing-note').textContent = ''; return; }
  const elapsed = timing.elapsedMs;
  const elapsedText = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed < 60000 ? '不足 1 分钟' : elapsed < 3600000 ? `约 ${Math.floor(elapsed / 60000)} 分钟` : `约 ${(elapsed / 3600000).toFixed(1)} 小时` : '未知';
  const from = timing.fromSource === 'user_reported_wechat_sent' ? '上一条发送' : timing.fromSource === 'clipboard_copied' ? '上一轮复制' : timing.fromSource === 'suggestion_prepared' ? '上一轮建议生成' : '上一轮表达';
  $('timing-note').textContent = timing.reliability === 'unknown' ? '当前回复间隔暂不明确。' : `距${from}${elapsedText}${timing.reliability === 'user_reported_interval' ? '' : timing.reliability === 'weak_preparation_estimate' ? ' · 生成到录入的估计' : ' · 录入估计'}。`;
}
function editMessage(message) {
  if (!state.editingMessageId) state.composerBeforeEdit = rememberComposer();
  state.editingMessageId = message.id;
  state.composerImage = null; $('message-meaning').value = '';
  $('message-speaker').value = message.speaker;
  $('message-text').value = message.text;
  $('editing-message').textContent = '正在编辑已有消息';
  $('cancel-message-edit').hidden = false;
  $('save-message').textContent = '保存修改';
  rememberComposer({ changed: true });
  updateComposer();
  $('message-text').focus();
}
function cancelMessageEdit() {
  if (state.composerBeforeEdit) state.messageDrafts.set(state.selectedId, state.composerBeforeEdit);
  else state.messageDrafts.delete(state.selectedId);
  restoreComposer(state.selectedId);
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
  const requested = state.topicChangeContexts.has(currentContextKey());
  const changing = requested || classification?.topicDecision?.mode === 'change';
  const available = classification?.topicDecision?.mode === 'change' && options.size === 3;
  const missing = coachPrerequisite();
  $('classification-summary').textContent = missing || (busy?.type === 'classify' ? '正在结合完整对话看当前局面…'
    : changing ? classification?.topicDecision?.reason || '选择一个方向，换个话题。'
      : classification?.topicDecision?.reason || '结合当前阶段与上下文给建议，也可以主动换个话题。');
  $('direction-options').hidden = !changing || Boolean(missing);
  $('change-topic').setAttribute('aria-expanded', String(changing && !missing));
  $('direction-options').replaceChildren(...(changing ? ['up', 'down', 'sideways'] : []).map((direction) => {
    const option = options.get(direction);
    const button = el('button', { type: 'button', class: 'direction-option', disabled: Boolean(busy) || Boolean(missing) || state.me?.quota?.dailyReplyRemaining === 0, 'aria-pressed': String(state.selectedDirection === direction), 'aria-label': `${directionNames[direction].split(' · ')[0]}${available ? `，建议占比 ${Math.round(option.weight * 100)}%` : ''}`, 'data-direction': direction,
      onclick: () => void coachCall('reply', button, { direction, topicChangeRequested: true }) },
      el('span', { class: 'direction-name' }, directionNames[direction].split(' · ')[0], el('span', { class: 'direction-check', 'aria-hidden': 'true' }, '✓')),
      el('span', { class: 'weight' }, available ? `${Math.round(option.weight * 100)}%` : directionNames[direction].split(' · ')[1]));
    button.title = available ? `${actionNames[option.relationAction] || '当前动作'} · ${option.reason}` : directionNames[direction];
    button.classList.toggle('selected', state.selectedDirection === direction);
    return button;
  }));
}
const fieldCoachViewport = window.matchMedia('(max-width: 1020px)');
let fieldCoachFocusWithin = false;
document.addEventListener('focusin', (event) => {
  // Hiding a focused child can send a synthetic focusin to body before resize.
  // Keep the last real focus location; a composer or header focus still clears it.
  if (event.target !== document.body && event.target !== document.documentElement) fieldCoachFocusWithin = $('field-coach').contains(event.target);
});
function setFieldCoachModal(open) {
  const modal = open && fieldCoachViewport.matches;
  $('workspace').inert = modal;
  document.querySelector('.skip-link').inert = modal;
  $('field-coach-backdrop').hidden = !modal;
  if (modal) {
    $('field-coach').setAttribute('role', 'dialog');
    $('field-coach').setAttribute('aria-modal', 'true');
  } else {
    $('field-coach').setAttribute('role', 'complementary');
    $('field-coach').removeAttribute('aria-modal');
  }
}
function closeFieldCoach({ restoreFocus = false } = {}) {
  const inside = $('field-coach').contains(document.activeElement);
  const wasModal = $('field-coach').getAttribute('aria-modal') === 'true';
  $('field-coach').dataset.open = 'false';
  $('toggle-field-coach').setAttribute('aria-expanded', 'false');
  setFieldCoachModal(false);
  if (restoreFocus && (inside || wasModal || fieldCoachFocusWithin)) {
    const trigger = $('toggle-field-coach').checkVisibility() ? $('toggle-field-coach') : $('chat-menu').querySelector('summary');
    trigger.focus({ preventScroll: true });
  }
}
fieldCoachViewport.addEventListener('change', ({ matches }) => {
  const focused = document.activeElement;
  // CSS may hide a focused child before the media event runs, leaving body focused.
  const lostFocus = focused === document.body && fieldCoachFocusWithin;
  const inside = $('field-coach').contains(focused) || lostFocus;
  closeFieldCoach({ restoreFocus: matches && inside });
  if (!matches && inside && (lostFocus || !focused.checkVisibility())) $('field-coach-title').focus({ preventScroll: true });
});
function currentSuggestion() {
  const item = state.suggestion;
  return item && (state.detail?.currentSuggestionIds?.includes(item.id) || state.detail?.directReply?.id === item.id) ? item : null;
}
function workingFocus() { return currentSuggestion()?.workingFocus || state.detail?.classification?.workingFocus || null; }
function renderFieldCoach(classification) {
  const coach = classification?.fieldCoach;
  const heat = classification ? state.detail?.heat : null;
  const paused = heat?.status === 'pause' || classification?.obstacle?.type === 'negative';
  const insufficient = !classification || classification.status === 'needs_context' || !heat || heat.status === 'insufficient_evidence' || !Number.isFinite(heat.score);
  // The server's existing five-dimension index stays authoritative. A rounded
  // display does not create a new score, and uncertainty/refusal hides the number.
  $('field-coach-temperature').textContent = paused ? '先停推进' : insufficient ? '待判断' : `约${Math.round(heat.score / 5) * 5}°`;
  $('field-coach-temperature').title = '0–100° 暂定互动指数，非成功率；未知维度不按零分计算。';
  $('field-coach-heat-status').textContent = paused ? '已有明确负面阻力' : insufficient ? '信息不足' : heatNames[heat.status] || '结合当前互动判断';
  const observed = Object.values(heat?.dimensions || {}).filter((dimension) => dimension.level !== 'unknown').length;
  $('field-coach-heat-basis').textContent = heat ? `暂定指数，非成功率 · 已观察 ${observed}/5 维度` : '记录对方的新消息后再判断。';
  const focus = workingFocus();
  $('field-coach-focus').textContent = `本轮重点：${focusNames[focus?.stage] || focusNames.unknown}`;
  $('field-coach-focus').title = focus?.reason || '';

  const obstacle = classification?.obstacle?.type;
  const guidance = currentSuggestion()?.guidance;
  let action = guidance?.ownWordsGuide || coach?.initiative || '本轮主导建议待判断。';
  let pitfall = coach?.pitfall || (coach ? '通用提醒：别连续追问，别同一话题反复升温。' : '本轮雷点待判断。');
  if (paused) {
    action = '停止这类推进，尊重她的边界。';
    pitfall = '别继续这类升级，也别劝她接受。';
  } else if (heat?.status === 'too_low') {
    action = '先收住投入，等真实互动变化。';
    pitfall = '别连发催促，别用更强暗示硬推进。';
  } else if (obstacle === 'ambiguous') {
    action = '先弄清她的意思，轻松接住疑虑。';
    pitfall = '别把疑虑当调侃，也别继续加码。';
  } else if (!classification && !guidance) {
    action = classificationUnavailable() ? '可以直接生成一句回复。' : '先记录对方的新消息。';
  }
  // Keep historical advice intact, including later conditions and negations.
  // CSS bounds the preview; the full advice remains readable in the disclosure.
  $('field-coach-initiative').textContent = action;
  $('field-coach-pitfall').textContent = pitfall;
  const options = (classification?.options || []).filter((option) => Number.isFinite(option.weight));
  const highest = options.length ? Math.max(...options.map(({ weight }) => weight)) : null;
  const recommended = options.filter(({ weight }) => weight === highest);
  $('field-coach-next').textContent = paused || heat?.status === 'too_low' ? '先留白，暂不升级或邀约。'
    : guidance?.reentryWhen ? guidance.reentryWhen
      : classification?.topicDecision?.mode !== 'change' ? coach?.nextAction || '结合当前话题给建议。'
    : !recommended.length ? '可以主动选择一个换题方向。'
      : `${recommended.length > 1 ? '并列可选' : '推荐'}${recommended.map(({ topicMove }) => directionNames[topicMove]?.split(' · ')[0] || '待判断').join(' / ')} · ${obstacle === 'ambiguous' ? '先澄清她的意思，暂不升级。' : recommended[0].reason}`;

  $('field-coach-topic').textContent = `当前话题：${coach?.currentTopic || '待判断'}`;
  $('field-coach-state').textContent = coach ? `${topicStatusNames[coach.topicStatus] || topicStatusNames.unknown}${coach.warmingLayer && coach.warmingLayer !== 'none' ? ` · 升温层次 ${coach.warmingLayer}` : ''}` : '记录对方的新话后，结合完整对话判断。';
  $('field-coach-full-guidance').replaceChildren(...(coach ? [['主导建议', coach.initiative], ['具体动作', coach.nextAction], ['雷点', coach.pitfall], ['判断', coach.reason]] : []).filter(([, text]) => text).map(([label, text]) => el('p', {}, `${label}：${text}`)));
  for (const option of options) $('field-coach-full-guidance').append(el('p', {}, `${directionNames[option.topicMove]?.split(' · ')[0] || '方向'}：${option.reason}`));
  const messages = new Map((state.detail?.messages || []).map((message) => [message.id, message]));
  const evidence = (coach?.topicMessageIds || []).map((id) => messages.get(id)).filter(Boolean);
  $('field-coach-evidence').textContent = evidence.length ? `依据 ${evidence.length} 条话题记录：${evidence.slice(-3).map((message) => `${message.speaker === 'self' ? '我' : '对方'}：${message.text}`).join(' / ')}` : '';
}
function planDraftKey() { return JSON.stringify([state.me?.user.id, state.selectedId]); }
function renderFieldCoachPlan() {
  const key = planDraftKey();
  $('field-coach-plan').value = state.planDrafts.get(key) || '';
  const busy = state.planCalls.has(currentContextKey());
  const ready = !coachPrerequisite();
  $('field-coach-plan-submit').disabled = !ready || busy;
  $('field-coach-plan-submit').textContent = busy ? '教练正在看…' : '问场外教练';
  const result = state.planResults.get(JSON.stringify([currentContextKey(), $('field-coach-plan').value.trim()]));
  $('field-coach-plan-result').replaceChildren();
  if (busy) { $('field-coach-plan-result').textContent = '正在结合完整话题看这个计划…'; return; }
  if (!result) return;
  if (result.error) { $('field-coach-plan-result').textContent = result.error; return; }
  const assessment = result.planAssessment;
  const details = el('details', { class: 'coach-details' }, el('summary', {}, '查看评估依据'),
    el('p', {}, `判断：${assessment.reason}`),
    el('p', {}, `${planTimingNames[assessment.timingSuggestion?.status] || planTimingNames.unknown}：${assessment.timingSuggestion?.guidance || '还没有足够的时机依据。'}`));
  if (assessment.adjustedPlan) details.append(el('p', {}, `可以改成：${assessment.adjustedPlan}`));
  details.append(el('p', {}, `完整下一步：${assessment.nextAction}`));
  $('field-coach-plan-result').append(el('p', { class: 'coach-plan-verdict' }, planVerdictNames[assessment.verdict] || '建议待判断'),
    el('p', { class: 'coach-plan-next' }, `下一步：${assessment.nextAction}`),
    el('p', { class: 'helper' }, `时机：${planTimingNames[assessment.timingSuggestion?.status] || planTimingNames.unknown}`), details);
}
function currentContextKey() { return JSON.stringify([state.me?.user.id, state.selectedId, state.detail?.counterpart, state.detail?.messages, state.detail?.meeting, state.me?.profile]); }
function requestId(type, id, direction = '', intent = '', topicChangeRequested = false) {
  const contextKey = JSON.stringify([type, id, direction, intent, topicChangeRequested, currentContextKey()]);
  if (!state.requestIds.has(contextKey)) state.requestIds.set(contextKey, crypto.randomUUID());
  return { id: state.requestIds.get(contextKey), key: contextKey };
}
function updateCoachBusy() {
  const busy = state.modelCalls.get(currentContextKey());
  $('coach-loading').hidden = busy?.type !== 'classify';
  if (busy?.type === 'classify') $('coach-loading').textContent = '正在结合完整对话看当前局面…';
  $('coach-panel').setAttribute('aria-busy', String(Boolean(busy)));
  $('classify').disabled = Boolean(busy) || Boolean(coachPrerequisite());
  $('direct-reply').disabled = Boolean(busy) || Boolean(coachPrerequisite()) || state.me?.quota?.dailyReplyRemaining === 0;
  $('direct-reply').textContent = busy?.type === 'reply' ? '正在给建议…' : state.me?.quota?.dailyReplyRemaining === 0 ? '今日免费回复已用完' : '给我建议';
  $('change-topic').disabled = Boolean(busy) || Boolean(coachPrerequisite());
  renderClassification(state.detail?.classification);
  renderSuggestion();
}
function coachPrerequisite() {
  if (!state.me || !state.detail || !state.selectedId) return '先添加一位聊天对象，填写认识背景。';
  if (!state.me.profile?.background || state.me.requiresQuestionnaireUpdate || state.me.profile.requiresQuestionnaireUpdate) return '先在「资料 → 我的画像」补全自己的背景和聊天偏好。';
  if (!state.detail.messages?.some(({ speaker }) => speaker === 'other')) return '先在下方粘贴对方的一条消息，再结合局面给建议。';
  return '';
}
function maybeAutoCoach() {
  if (coachPrerequisite()) return;
  if (state.detail.classification) return;
  const context = currentContextKey();
  if (state.autoAttempts.has(context) || state.modelCalls.has(context)) return;
  if (classificationUnavailable() || state.detail.modelContext?.classificationAttempted) return;
  state.autoAttempts.add(context);
  void coachCall('classify', null, { automatic: true });
}
async function coachCall(type, button, { direction, automatic = false, topicChangeRequested = false } = {}) {
  if (button?.disabled || coachPrerequisite()) return;
  const id = state.selectedId, userId = state.me.user.id, inputContext = currentContextKey();
  if (state.modelCalls.has(inputContext)) return;
  if (topicChangeRequested) state.topicChangeContexts.add(inputContext);
  topicChangeRequested = topicChangeRequested || type === 'reply' && state.topicChangeContexts.has(inputContext);
  const call = { type, id, direction, previousDirection: state.selectedDirection };
  const focusReply = type === 'reply' && button && document.activeElement === button;
  const focusTopicChange = type === 'classify' && topicChangeRequested && button && document.activeElement === button;
  if (type === 'reply') {
    if (state.suggestion) state.suggestionDrafts.set(state.suggestion.id, $('suggestion-text').value);
    state.replyFeedback = null;
    state.selectedDirection = direction || null;
  }
  state.autoAttempts.add(inputContext);
  state.modelCalls.set(inputContext, call);
  closeInlineCards();
  const intent = type === 'reply' && !automatic ? $('intent').value.trim() : '';
  const request = requestId(type, id, direction, intent, topicChangeRequested);
  let localError = $('coach-error');
  if (!localError) { localError = el('p', { id: 'coach-error', class: 'form-error', role: 'alert' }); $('coach-loading').after(localError); }
  localError.hidden = true;
  updateCoachBusy();
  if (type === 'reply' && !automatic) {
    $('suggestion-panel').scrollIntoView({ block: 'nearest' });
    if (focusReply) $('suggestion-panel').focus({ preventScroll: true });
  }
  let replyAccepted = false, classificationAccepted = false;
  try {
    const data = await post(`${counterpartPath(id)}/${type}`, { requestId: request.id, ...(topicChangeRequested ? { topicChangeRequested: true } : {}), ...(type === 'reply' ? { ...(direction ? { direction } : {}), ...(intent ? { intent } : {}) } : {}) });
    state.requestIds.delete(request.key);
    if (state.me?.user.id !== userId) return;
    updateQuota(data.quota);
    if (state.selectedId === id && currentContextKey() === inputContext) {
      if (type === 'classify') {
        classificationAccepted = true;
        state.detail.classification = data.classification; state.detail.heat = data.heat;
        renderHeat(data.heat);
      } else {
        replyAccepted = true;
        state.replyRevision++;
        state.suggestion = data.suggestion;
        if (Array.isArray(state.detail.currentSuggestionIds) && !state.detail.currentSuggestionIds.includes(data.suggestion.id)) state.detail.currentSuggestionIds.push(data.suggestion.id);
        state.selectedDirection = data.suggestion.direction || null;
        const name = directionNames[data.suggestion.direction]?.split(' · ')[0];
        state.replyFeedback = { context: inputContext, suggestionId: data.suggestion.id, highlight: true,
          text: `${name ? `已切换到${name}` : '回复已更新'}${data.cached ? ' · 使用已保存结果' : ''}` };
        const suggestions = state.detail.suggestions || (state.detail.suggestions = []);
        if (!suggestions.some((item) => item.id === data.suggestion.id)) suggestions.push(data.suggestion);
        if (!direction && !intent && !topicChangeRequested) state.detail.directReply = data.suggestion;
        renderSuggestion();
      }
      announce('');
    }
    try { await loadCounterparts(); }
    catch {
      if (state.selectedId === id && currentContextKey() === inputContext) announce('结果已取回，但对象列表暂未刷新。可稍后刷新保存状态。', 'error');
    }
  } catch (error) {
    if (state.me?.user.id !== userId) return;
    const recoverExisting = !error.status || error.code === 'JOB_IN_PROGRESS';
    if (!recoverExisting) state.requestIds.delete(request.key);
    const retryMessage = `${error.message} ${recoverExisting ? '可点击按钮取回结果。' : '可手动重新尝试。'}不会自动重试。`;
    if (state.selectedId === id && currentContextKey() === inputContext) {
      if (type === 'reply' && !replyAccepted) {
        state.selectedDirection = call.previousDirection;
        state.replyFeedback = { context: inputContext, suggestionId: state.suggestion?.id,
          text: state.suggestion ? '未取回新回复，保留上一条；可手动重试。' : '未取回回复，可手动重试。', error: true };
      }
      announce(''); localError.textContent = retryMessage; localError.hidden = false;
    }
    try { await reloadMe(); } catch { /* Preserve the original recovery state. */ }
    if (['REQUEST_ID_CONTEXT_CONFLICT', 'CONTEXT_CHANGED'].includes(error.code) && state.selectedId === id) {
      try { await loadCounterpart(id, { autoAnalyze: false }); } catch { /* No automatic retry. */ }
    }
    if ((error.code === 'FULL_PROFILE_REQUIRES_UPDATE' || error.code === 'PROFILE_REQUIRED') && state.selectedId === id) { fillProfile(); showView('profile'); }
    if (state.selectedId === id) {
      try { const detail = await api(counterpartPath(id)); if (state.selectedId === id) renderJobs(detail.jobs || []); } catch { /* Read only. */ }
    }
  } finally {
    if (state.modelCalls.get(inputContext) === call) state.modelCalls.delete(inputContext);
    if (state.selectedId === id && currentContextKey() === inputContext) {
      updateCoachBusy();
      // The complete editor/guidance appears only after the busy state clears.
      if (replyAccepted) scrollToLatest();
      if (classificationAccepted && focusTopicChange && (document.activeElement === button || document.activeElement === document.body)) {
        $('direction-options').querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
        $('direction-options').scrollIntoView({ block: 'nearest' });
      }
    }
  }
}
function renderSuggestion() {
  const suggestion = state.suggestion;
  const context = currentContextKey();
  const busy = state.modelCalls.get(context);
  const generating = busy?.type === 'reply';
  const feedback = state.replyFeedback?.context === context && state.replyFeedback.suggestionId === suggestion?.id ? state.replyFeedback : null;
  const suggestions = state.detail?.suggestions || [];
  $('suggestion-history').hidden = !suggestions.length;
  $('suggestion-list').replaceChildren(...[...suggestions].reverse().map((item) => el('button', { type: 'button', class: 'history-button', disabled: generating, 'data-suggestion-id': item.id, onclick: () => {
    if (state.suggestion) state.suggestionDrafts.set(state.suggestion.id, $('suggestion-text').value);
    state.replyFeedback = null; state.selectedDirection = item.direction || null;
    state.suggestion = item; renderClassification(state.detail?.classification); renderSuggestion();
  } }, `${actionNames[item.action] || '回复'} · ${item.reply || '建议等待或暂停'}`)));
  $('suggestion-panel').hidden = !suggestion && !generating;
  $('suggestion-panel').setAttribute('aria-busy', String(generating));
  $('suggestion-panel').classList.toggle('reply-updated', !generating && Boolean(feedback?.highlight));
  if (!generating && feedback?.highlight && !feedback.clearTimer) {
    // Motion preferences may suppress animationend; clear the cue independently.
    feedback.clearTimer = setTimeout(() => {
      feedback.highlight = false;
      if (state.replyFeedback === feedback && currentContextKey() === context && state.suggestion?.id === feedback.suggestionId) $('suggestion-panel').classList.remove('reply-updated');
    }, 900);
  }
  $('suggestion-loading').hidden = !generating;
  $('suggestion-loading').textContent = generating ? `正在生成${busy.direction ? `「${directionNames[busy.direction].split(' · ')[0]}」` : ''}回复…` : '';
  const noReply = isNoReplySuggestion(suggestion);
  $('suggestion-editor').hidden = generating || !suggestion || noReply;
  $('suggestion-meta').hidden = generating || !suggestion;
  $('suggestion-text').disabled = generating || noReply;
  $('reply-guidance').hidden = generating || !suggestion;
  const direction = generating ? busy.direction : suggestion?.guidance ? suggestion.guidance.topicMove : suggestion?.direction;
  $('suggestion-direction').hidden = !direction;
  $('suggestion-direction').textContent = directionNames[direction]?.split(' · ')[0] || '';
  $('suggestion-direction').setAttribute('aria-label', `话题方向：${directionNames[direction]?.split(' · ')[0] || '暂不延伸'}`);
  $('suggestion-update').hidden = generating || !feedback;
  $('suggestion-update').textContent = feedback?.text || '';
  $('suggestion-update').classList.toggle('error', Boolean(feedback?.error));
  if (generating) { $('suggestion-title').textContent = '我 · AI 正在准备回复'; updateReplyCopyState(); updateComposer(); return; }
  if (!suggestion) { $('suggestion-title').textContent = '我 · AI 建议'; $('suggestion-text').value = ''; updateReplyCopyState(); updateComposer(); return; }
  const relatedMessage = [...(state.detail?.messages || [])].reverse().find((message) => message.speaker === 'self' && message.suggestionId === suggestion.id);
  $('suggestion-text').value = state.suggestionDrafts.get(suggestion.id) ?? suggestion.pendingReplyText ?? relatedMessage?.text ?? suggestion.reply ?? '';
  $('suggestion-action').textContent = actionNames[suggestion.action] || '建议';
  $('suggestion-reason').textContent = suggestion.reason || '';
  $('suggestion-style').textContent = suggestion.styleNote || '';
  $('reply-relation').textContent = `${focusNames[currentSuggestion()?.workingFocus?.stage] || focusNames.unknown} · ${suggestion.action === 'pause' ? relationMoveNames.pause : relationMoveNames[suggestion.guidance?.relationMove] || (noReply ? relationMoveNames[suggestion.action] : '这条旧建议未保存关系动作')}`;
  $('reply-own-words').textContent = suggestion.guidance?.ownWordsGuide || (noReply ? '本轮先不发送，不必硬续一句。' : '这条旧建议未保存表达指引，可保留原意，用你的说法改写。');
  $('reply-reentry').textContent = suggestion.guidance?.reentryWhen || '这条旧建议未保存具体条件，不必按固定时长等待。';
  $('reply-wait-reason').hidden = !noReply;
  $('reply-wait-reason').textContent = noReply ? `现在不回的依据：${suggestion.reason || '这条旧建议未保存具体依据。'}` : '';
  updateReplyCopyState();
  updateSentState(); updateComposer(); renderFieldCoach(state.detail?.classification);
}
function isNoReplySuggestion(suggestion) { return ['wait', 'pause'].includes(suggestion?.action); }
function updateReplyCopyState() {
  const generating = state.modelCalls.get(currentContextKey())?.type === 'reply';
  const disabled = generating || state.copyCalls.has(JSON.stringify([state.me?.user.id, state.selectedId])) || !state.suggestion || isNoReplySuggestion(state.suggestion) || !$('suggestion-text').value.trim();
  $('copy-reply').disabled = disabled;
  $('copy-reply').dataset.locked = String(disabled);
}
function isPendingSuggestion(suggestion) {
  if (isNoReplySuggestion(suggestion)) return false;
  if (suggestion?.pendingEligible !== true) return false;
  if (!Array.isArray(state.detail?.currentSuggestionIds) || state.detail.currentSuggestionIds.includes(suggestion.id)) return true;
  const incoming = state.detail.messages.findLast(({ speaker }) => speaker === 'other');
  // Explicitly copying history after the latest incoming message can restore
  // use. A copy made before that message must not revive an old-context draft.
  const copiedAt = Date.parse(suggestion.pendingCopiedAt);
  const incomingAt = Date.parse(incoming?.updatedAt || incoming?.recordedAt || incoming?.createdAt);
  return Boolean(suggestion.pendingCopyReceiptId) && Number.isFinite(copiedAt) && Number.isFinite(incomingAt) && copiedAt > incomingAt;
}
function updateSentState() {
  if (!state.suggestion) return;
  if (isNoReplySuggestion(state.suggestion)) {
    const current = state.detail?.currentSuggestionIds?.includes(state.suggestion.id) || state.detail?.directReply?.id === state.suggestion.id;
    $('suggestion-title').textContent = current ? state.suggestion.action === 'pause' ? 'AI 建议 · 先停止当前推进' : 'AI 建议 · 暂时不回' : '历史节奏建议 · 仅供查看';
    $('sent-state').textContent = current ? '这是节奏建议，不是待发消息；出现上述接话条件后再判断。' : '这条节奏建议属于过去的背景，当前情况需要重新判断。';
    return;
  }
  const eligible = isPendingSuggestion(state.suggestion);
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
function readIntakeForm() {
  return { alias: $('intake-alias').value, channel: $('intake-channel').value, appProfile: $('intake-app').value, offlineScene: $('intake-offline').value, background: $('intake-background').value, rounds: $('intake-rounds').value };
}
function openCounterpart(person = null) {
  state.intakeInstance++;
  state.editingCounterpartId = person?.id || null;
  const draft = state.intakeDrafts.get(state.editingCounterpartId || 'new') || person;
  $('counterpart-form').reset();
  $('counterpart-dialog-title').textContent = person ? '编辑认识背景' : '添加聊天对象';
  for (const [id, key] of [['intake-alias', 'alias'], ['intake-channel', 'channel'], ['intake-app', 'appProfile'], ['intake-offline', 'offlineScene'], ['intake-background', 'background']]) $(id).value = draft?.[key] || (key === 'channel' ? 'app' : '');
  $('intake-rounds').value = draft?.rounds ?? 0;
  const error = $('counterpart-form').querySelector('.form-error');
  if (error) error.hidden = true;
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
  state.me = null; state.csrf = ''; state.selectedId = null; state.detail = null; state.suggestion = null; state.replyFeedback = null;
  state.counterparts = []; state.requestIds.clear(); state.suggestionDrafts.clear();
  state.messageDrafts.clear(); state.messageCalls.clear(); state.timeCalls.clear(); state.composerBeforeEdit = null; state.editingMessageId = null;
  state.composerImage = null; state.imageCalls.clear(); state.imageSelectionSerial++;
  state.intakeDrafts.clear();
  state.topicChangeContexts.clear(); state.annotationDrafts.clear(); state.annotationOpen.clear(); state.annotationCalls.clear(); state.annotationErrors.clear();
  state.intentDrafts.clear(); state.planDrafts.clear(); state.planResults.clear(); state.planCalls.clear(); state.copyReceipts.clear(); state.copyCalls.clear(); state.autoAttempts.clear(); state.modelCalls.clear(); state.detailRequestSerial++; state.questionnaireAnswers = {};
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
  showCounterpartLoading();
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
  const modalCoach = fieldCoachViewport.matches && $('field-coach').dataset.open === 'true';
  if (modalCoach && event.key === 'Tab') {
    const targets = [...$('field-coach').querySelectorAll('button,a[href],input,textarea,select,summary,[tabindex]')]
      .filter((node) => !node.disabled && node.tabIndex >= 0 && node.checkVisibility());
    const index = targets.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0 || !event.shiftKey && (index < 0 || index === targets.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? targets.at(-1) : targets[0])?.focus();
    }
    return;
  }
  if (event.key !== 'Escape') return;
  if (modalCoach) { event.preventDefault(); closeFieldCoach({ restoreFocus: true }); return; }
  const menus = [...document.querySelectorAll('.chat-menu[open]')];
  if (menus.length) menus.forEach((menu) => closeMenu(menu, { restoreFocus: true }));
  else if ($('field-coach').dataset.open === 'true') closeFieldCoach({ restoreFocus: true });
});
$('toggle-field-coach').addEventListener('click', () => {
  const open = $('field-coach').dataset.open !== 'true';
  if (!open) { closeFieldCoach({ restoreFocus: true }); return; }
  $('field-coach').dataset.open = String(open);
  $('toggle-field-coach').setAttribute('aria-expanded', String(open));
  setFieldCoachModal(open);
  $('field-coach').scrollTop = 0;
  $('field-coach-title').focus({ preventScroll: true });
});
$('close-field-coach').addEventListener('click', () => closeFieldCoach({ restoreFocus: true }));
$('field-coach-backdrop').addEventListener('click', () => closeFieldCoach({ restoreFocus: true }));
$('coach-glossary-toggle').addEventListener('change', (event) => {
  $('coach-glossary-terms').hidden = !event.currentTarget.checked;
});
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
  catch (error) { if (!error.displayed) announce(error.message, 'error'); }
  finally { event.target.disabled = false; }
});
$('retry-counterpart').addEventListener('click', () => {
  const scope = { userId: state.me?.user.id, counterpartId: state.selectedId };
  void perform($('retry-counterpart'), '读取中…', async () => {
    if (scope.counterpartId) await loadCounterpart(scope.counterpartId);
  }, scope);
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
$('close-counterpart-dialog').addEventListener('click', () => closeInlineCards({ restoreFocus: true }));
$('cancel-counterpart-dialog').addEventListener('click', () => { state.intakeDrafts.delete(state.editingCounterpartId || 'new'); closeInlineCards({ restoreFocus: true }); });
for (const type of ['input', 'change']) $('counterpart-form').addEventListener(type, () => { state.intakeDrafts.set(state.editingCounterpartId || 'new', readIntakeForm()); });
$('counterpart-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void perform(event.submitter, '保存中…', async () => {
    const editingId = state.editingCounterpartId, selectedId = state.selectedId, userId = state.me?.user.id, key = editingId || 'new', instance = state.intakeInstance;
    const submitted = readIntakeForm(); state.intakeDrafts.set(key, submitted);
    const input = { alias: $('intake-alias').value.trim(), channel: $('intake-channel').value, appProfile: $('intake-app').value.trim(), offlineScene: $('intake-offline').value.trim(), background: $('intake-background').value.trim(), rounds: Number($('intake-rounds').value) };
    const data = editingId ? await put(counterpartPath(editingId), input) : await post('/api/counterparts', input);
    if (state.me?.user.id !== userId) return;
    // A reopened intake is a new editing session, even when both target "new".
    // Its wording must never become an edit of the earlier saved counterpart.
    if (state.intakeInstance !== instance) {
      if (state.intakeDrafts.get(key) === submitted) state.intakeDrafts.delete(key);
      await loadCounterparts(); return;
    }
    const newerDraft = state.intakeDrafts.get(key) !== submitted ? state.intakeDrafts.get(key) : null;
    state.intakeDrafts.delete(key);
    if (newerDraft) state.intakeDrafts.set(data.counterpart.id, newerDraft);
    if (state.selectedId !== selectedId || state.activeInlineCard !== 'counterpart-dialog' || state.editingCounterpartId !== editingId) { await loadCounterparts(); return; }
    closeInlineCards({ restoreFocus: true }); await loadCounterparts(); await loadCounterpart(data.counterpart.id); showView('coach');
    if (newerDraft) openCounterpart(data.counterpart);
    announce(newerDraft ? '提交的背景已保存，刚补充的内容仍保留在表单里。' : '认识背景已保存。');
  });
});
$('delete-counterpart').addEventListener('click', () => void perform($('delete-counterpart'), '删除中…', async () => {
  if (!confirm('删除这个对象及其关联的私有记录？此操作不能撤销。')) return;
  const id = state.selectedId;
  await api(counterpartPath(id), { method: 'DELETE' });
  for (const suggestion of state.detail?.suggestions || []) state.suggestionDrafts.delete(suggestion.id);
  state.intentDrafts.delete(id); state.requestIds.clear();
  state.messageDrafts.delete(id);
  state.intakeDrafts.delete(id);
  state.selectedId = null; state.detail = null; state.suggestion = null;
  $('suggestion-text').value = ''; $('intent').value = '';
  for (const element of ['transcript', 'direction-options', 'suggestion-list', 'heat-dimensions']) $(element).replaceChildren();
  $('counterpart-title').textContent = '模拟微信'; $('counterpart-background').textContent = '';
  $('counterpart-workspace').hidden = true; $('empty-state').hidden = false;
  closeInlineCards(); updateComposer();
  await loadCounterparts(); announce('对象及其关联记录已删除。');
}));
$('cancel-message-edit').addEventListener('click', cancelMessageEdit);
$('add-message-image').addEventListener('click', () => $('message-image-file').click());
$('message-image-file').addEventListener('change', (event) => { void attachMessageImage(event.target.files?.[0]); event.target.value = ''; });
$('remove-message-image').addEventListener('click', () => { state.composerImage = null; state.imageSelectionSerial++; rememberComposer({ changed: true }); updateComposer(); $('message-text').focus({ preventScroll: true }); });
$('message-meaning').addEventListener('input', () => rememberComposer({ changed: true }));
$('message-text').addEventListener('paste', (event) => { const file = [...(event.clipboardData?.items || [])].find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile(); if (file && !$('add-message-image').disabled) { event.preventDefault(); void attachMessageImage(file); } });
$('message-speaker').addEventListener('change', () => { rememberComposer({ changed: true }); updateComposer(); });
$('message-text').addEventListener('input', () => rememberComposer({ changed: true }));
$('message-text').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (!$('save-message').disabled) $('message-form').requestSubmit($('save-message'));
});
$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const scope = { userId: state.me?.user.id, counterpartId: state.selectedId };
  const callKey = JSON.stringify([scope.userId, scope.counterpartId]);
  if (state.messageCalls.has(callKey) || state.imageCalls.has(callKey)) return;
  void perform(event.submitter, '保存消息…', async () => {
    const id = state.selectedId, userId = state.me?.user.id;
    if (!id || !state.detail) throw new Error('先添加或选择一位聊天对象。');
    if (state.composerImage && !state.composerImage.interpretation) { await readComposerImage(scope); return; }
    const submitted = rememberComposer();
    const body = { speaker: $('message-speaker').value, text: composerRecordText(submitted) };
    if (body.text.length > 20_000) throw new Error('消息、识读描述与补充意思合计需在20000字以内，请缩短后记录；当前草稿仍保留。');
    const editing = state.editingMessageId;
    state.messageCalls.add(callKey);
    try {
      if (editing) await put(`${counterpartPath(id)}/messages/${encodeURIComponent(editing)}`, body);
      else if (body.speaker === 'other') {
        // A hidden previous draft must not be inferred as the reply used during generation.
        // A screenshot may already contain both sides. It cannot establish that
        // the currently prepared reply was used before the described image.
        const imageHasUnknownTurns = submitted.image && ['screenshot', 'unknown'].includes(submitted.image.interpretation?.kind);
        const previousReplyText = !imageHasUnknownTurns && state.modelCalls.get(currentContextKey())?.type !== 'reply' && isPendingSuggestion(state.suggestion) ? $('suggestion-text').value.trim() : '';
        const copyReceipt = previousReplyText && (state.suggestion.pendingCopyReceiptId || state.copyReceipts.get(JSON.stringify([userId, id, state.suggestion.id, previousReplyText])));
        const followup = { text: body.text, ...(previousReplyText ? { previousSuggestionId: state.suggestion.id, previousReplyText, ...(copyReceipt ? { previousCopyReceiptId: copyReceipt } : {}) } : {}) };
        const key = JSON.stringify(['followup', userId, id, followup]);
        if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID());
        await post(`${counterpartPath(id)}/followup`, { ...followup, requestId: state.requestIds.get(key) });
        state.requestIds.delete(key);
      } else await post(`${counterpartPath(id)}/messages`, body);
      if (state.me?.user.id !== userId) return;
      finishComposerSubmission(id, submitted);
      if (state.selectedId !== id) return;
      await refreshCounterpart(id, { autoAnalyze: !editing && body.speaker === 'other' });
      if (state.selectedId !== id) return;
      closeInlineCards(); scrollToLatest();
      announce(body.speaker === 'other' && !editing ? '对方的新消息已记录。' : '原话已记录。');
    } finally { state.messageCalls.delete(callKey); updateComposer(); }
  }, scope);
});
$('classify').addEventListener('click', () => void coachCall('classify', $('classify')));
$('direct-reply').addEventListener('click', () => void coachCall('reply', $('direct-reply')));
$('change-topic').addEventListener('click', () => {
  if ($('change-topic').disabled || coachPrerequisite()) return;
  state.topicChangeContexts.add(currentContextKey());
  if (classificationUnavailable()) { renderClassification(state.detail?.classification); $('direction-options').querySelector('button')?.focus({ preventScroll: true }); }
  else void coachCall('classify', $('change-topic'), { topicChangeRequested: true });
});
$('suggestion-text').addEventListener('input', () => { if (state.suggestion) state.suggestionDrafts.set(state.suggestion.id, $('suggestion-text').value); updateReplyCopyState(); updateSentState(); });
$('copy-reply').addEventListener('click', () => void perform($('copy-reply'), '复制中…', async () => {
  const id = state.selectedId, userId = state.me?.user.id, suggestionId = state.suggestion?.id, copiedText = $('suggestion-text').value;
  if (!id || !suggestionId || !copiedText.trim() || isNoReplySuggestion(state.suggestion)) return;
  const copyCall = JSON.stringify([userId, id]);
  state.copyCalls.add(copyCall);
  try {
    const copied = await copyText(copiedText);
    if (!copied) return;
    const key = JSON.stringify(['copy', userId, id, suggestionId, copiedText]);
    if (!state.requestIds.has(key)) state.requestIds.set(key, crypto.randomUUID());
    const data = await post(`${counterpartPath(id)}/suggestions/${encodeURIComponent(suggestionId)}/copied`, { copiedText, requestId: state.requestIds.get(key) });
    state.requestIds.delete(key);
    if (state.me?.user.id === userId) state.copyReceipts.set(JSON.stringify([userId, id, suggestionId, copiedText.trim()]), data.copyReceipt.id);
    if (state.me?.user.id === userId && state.selectedId === id) await refreshCounterpart(id);
  } catch (error) {
    if (state.me?.user.id === userId && state.selectedId === id) announce(`文本已复制，但复制时间未保存：${error.message} 仍可粘贴对方下一句继续。`, 'error');
  } finally {
    state.copyCalls.delete(copyCall);
    if (state.me?.user.id === userId && state.selectedId === id) renderSuggestion();
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
    if (state.meta.hostedPreview?.enabled === true) {
      const session = await post('/api/preview/session', {});
      state.csrf = session.csrfToken;
      await enterWorkspace();
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
