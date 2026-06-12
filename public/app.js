'use strict';

/* ------------------------------------------------------------------ */
/* State & storage                                                     */
/* ------------------------------------------------------------------ */

const LS_INDEX = 'lcm:conversations';
const LS_CONV = (id) => `lcm:conv:${id}`;
const LS_ACTIVE = 'lcm:activeId';

let config = { models: [], defaultModel: 'gpt-4o-mini', preferredLanguages: [] };
let conversations = []; // [{id, title, mode, model, updatedAt}]
let activeId = null;
let streaming = false;
let abortController = null;

const $ = (id) => document.getElementById(id);

const els = {
  loginScreen: $('login-screen'),
  loginForm: $('login-form'),
  loginPassword: $('login-password'),
  loginError: $('login-error'),
  app: $('app'),
  sidebar: $('sidebar'),
  sidebarOverlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'),
  newChatBtn: $('new-chat-btn'),
  logoutBtn: $('logout-btn'),
  convList: $('conversation-list'),
  modeSelect: $('mode-select'),
  modelSelect: $('model-select'),
  modelBadge: $('model-badge'),
  messages: $('messages'),
  emptyState: $('empty-state'),
  input: $('input'),
  sendBtn: $('send-btn'),
  reviewBtn: $('review-btn'),
  stopBtn: $('stop-btn'),
};

function loadIndex() {
  try {
    conversations = JSON.parse(localStorage.getItem(LS_INDEX)) || [];
  } catch {
    conversations = [];
  }
}

function saveIndex() {
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  localStorage.setItem(LS_INDEX, JSON.stringify(conversations));
}

function loadMessages(id) {
  try {
    return JSON.parse(localStorage.getItem(LS_CONV(id)))?.messages || [];
  } catch {
    return [];
  }
}

function saveMessages(id, messages) {
  localStorage.setItem(LS_CONV(id), JSON.stringify({ messages }));
}

function activeConv() {
  return conversations.find((c) => c.id === activeId) || null;
}

/* ------------------------------------------------------------------ */
/* Markdown rendering                                                  */
/* ------------------------------------------------------------------ */

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  el.querySelectorAll('pre code').forEach((block) => {
    try { hljs.highlightElement(block); } catch { /* unknown language */ }
  });
  el.querySelectorAll('pre').forEach(addCopyButton);
}

function addCopyButton(pre) {
  // Anchor the button to a wrapper so it stays put when wide code scrolls
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  pre.replaceWith(wrap);
  wrap.appendChild(pre);

  const codeEl = pre.querySelector('code');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.onclick = async () => {
    const code = (codeEl || pre).innerText.replace(/\n$/, '');
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.textContent = 'Copied ✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1500);
  };
  wrap.appendChild(btn);
}

/* ------------------------------------------------------------------ */
/* UI rendering                                                        */
/* ------------------------------------------------------------------ */

function renderConversationList() {
  els.convList.innerHTML = '';
  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === activeId ? ' active' : '');

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = conv.title || 'Untitled problem';
    item.appendChild(title);

    const actions = document.createElement('span');
    actions.className = 'conv-actions';

    const renameBtn = document.createElement('button');
    renameBtn.textContent = '✏️';
    renameBtn.title = 'Rename';
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      const name = prompt('Rename conversation:', conv.title);
      if (name && name.trim()) {
        conv.title = name.trim();
        saveIndex();
        renderConversationList();
      }
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑️';
    deleteBtn.title = 'Delete';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${conv.title}"?`)) return;
      localStorage.removeItem(LS_CONV(conv.id));
      conversations = conversations.filter((c) => c.id !== conv.id);
      saveIndex();
      if (activeId === conv.id) {
        activeId = conversations[0]?.id || null;
        localStorage.setItem(LS_ACTIVE, activeId || '');
        renderActiveConversation();
      }
      renderConversationList();
    };

    actions.append(renameBtn, deleteBtn);
    item.appendChild(actions);
    item.onclick = () => selectConversation(conv.id);
    els.convList.appendChild(item);
  }
}

function appendMessageEl(role, content, { error = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}${error ? ' msg-error' : ''}`;

  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role';
  roleEl.textContent = role === 'user' ? 'You' : 'Mentor';
  wrap.appendChild(roleEl);

  const body = document.createElement('div');
  body.className = 'msg-body';
  if (role === 'user') {
    body.textContent = content;
  } else {
    renderMarkdown(body, content);
  }
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  return body;
}

function renderActiveConversation() {
  els.messages.querySelectorAll('.msg').forEach((el) => el.remove());
  const conv = activeConv();
  els.emptyState.classList.toggle('hidden', !!conv && loadMessages(conv.id).length > 0);

  if (!conv) {
    els.modeSelect.value = 'socratic';
    setModelBadge();
    return;
  }
  els.modeSelect.value = conv.mode || 'socratic';
  if (config.models.some((m) => m.id === conv.model)) {
    els.modelSelect.value = conv.model;
  }
  setModelBadge();

  for (const msg of loadMessages(conv.id)) {
    appendMessageEl(msg.role, msg.content, { error: !!msg.error });
  }
  scrollToBottom(true);
}

function setModelBadge() {
  const m = config.models.find((x) => x.id === els.modelSelect.value);
  els.modelBadge.textContent = m ? `${m.label} · ${m.note}` : '';
}

function scrollToBottom(force = false) {
  const m = els.messages;
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  if (force || nearBottom) m.scrollTop = m.scrollHeight;
}

function setStreaming(on) {
  streaming = on;
  els.sendBtn.classList.toggle('hidden', on);
  els.stopBtn.classList.toggle('hidden', !on);
  els.reviewBtn.disabled = on;
  els.input.disabled = false;
}

/* ------------------------------------------------------------------ */
/* Conversation actions                                                */
/* ------------------------------------------------------------------ */

function newConversation() {
  const conv = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title: 'New problem',
    mode: 'socratic',
    model: els.modelSelect.value || config.defaultModel,
    updatedAt: Date.now(),
  };
  conversations.unshift(conv);
  saveIndex();
  saveMessages(conv.id, []);
  selectConversation(conv.id);
}

function selectConversation(id) {
  if (streaming) stopStreaming();
  activeId = id;
  localStorage.setItem(LS_ACTIVE, id || '');
  renderConversationList();
  renderActiveConversation();
  closeSidebar();
}

function titleFromText(text) {
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || 'New problem';
  return firstLine.length > 48 ? firstLine.slice(0, 48) + '…' : firstLine;
}

/* ------------------------------------------------------------------ */
/* Chat / streaming                                                    */
/* ------------------------------------------------------------------ */

async function sendMessage(text, { review = false } = {}) {
  if (streaming) return;
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return;

  if (!activeConv()) newConversation();
  const conv = activeConv();
  conv.mode = els.modeSelect.value;
  conv.model = els.modelSelect.value;

  const messages = loadMessages(conv.id);
  const content = review ? `[REVIEW MY SOLUTION]\n\n${trimmed}` : trimmed;

  if (messages.length === 0) {
    conv.title = review ? `Review: ${titleFromText(trimmed)}` : titleFromText(trimmed);
  }
  messages.push({ role: 'user', content });
  conv.updatedAt = Date.now();
  saveMessages(conv.id, messages);
  saveIndex();
  renderConversationList();

  els.emptyState.classList.add('hidden');
  appendMessageEl('user', content);
  els.input.value = '';
  autosizeInput();
  scrollToBottom(true);

  const body = appendMessageEl('assistant', '');
  body.innerHTML = '<span class="typing-dot"></span>';
  setStreaming(true);

  let assistantText = '';
  let errored = false;
  abortController = new AbortController();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        messages: messages.map(({ role, content }) => ({ role, content })),
        mode: conv.mode,
        model: conv.model,
      }),
    });

    if (res.status === 401) {
      showLogin();
      throw new Error('Session expired — please sign in again.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));

        if (payload.error) {
          errored = true;
          assistantText = assistantText
            ? assistantText + `\n\n> ⚠️ ${payload.error}`
            : `⚠️ ${payload.error}`;
          renderMarkdown(body, assistantText);
          body.closest('.msg').classList.add('msg-error');
        } else if (payload.content) {
          assistantText += payload.content;
          renderMarkdown(body, assistantText);
        }
        scrollToBottom();
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      errored = true;
      assistantText = assistantText
        ? assistantText + `\n\n> ⚠️ ${err.message}`
        : `⚠️ ${err.message}`;
      renderMarkdown(body, assistantText);
      body.closest('.msg').classList.add('msg-error');
    } else if (assistantText) {
      assistantText += '\n\n> ⏹️ *Stopped.*';
      renderMarkdown(body, assistantText);
    }
  } finally {
    setStreaming(false);
    abortController = null;
    if (assistantText) {
      messages.push({ role: 'assistant', content: assistantText, error: errored });
      conv.updatedAt = Date.now();
      saveMessages(conv.id, messages);
      saveIndex();
      renderConversationList();
    } else {
      body.closest('.msg').remove();
    }
    scrollToBottom();
    els.input.focus();
  }
}

function stopStreaming() {
  abortController?.abort();
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function showLogin() {
  els.loginScreen.classList.remove('hidden');
  els.app.classList.add('hidden');
  els.loginPassword.focus();
}

async function showApp() {
  els.loginScreen.classList.add('hidden');
  els.app.classList.remove('hidden');

  els.modelSelect.innerHTML = '';
  for (const m of config.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.label} (${m.note})`;
    els.modelSelect.appendChild(opt);
  }
  els.modelSelect.value = config.defaultModel;

  loadIndex();
  activeId = localStorage.getItem(LS_ACTIVE) || conversations[0]?.id || null;
  if (activeId && !conversations.some((c) => c.id === activeId)) {
    activeId = conversations[0]?.id || null;
  }
  renderConversationList();
  renderActiveConversation();
}

async function checkAuth() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return showLogin();
    config = await res.json();
    showApp();
  } catch {
    showLogin();
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginError.classList.add('hidden');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: els.loginPassword.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Login failed');
    }
    els.loginPassword.value = '';
    await checkAuth();
  } catch (err) {
    els.loginError.textContent = err.message;
    els.loginError.classList.remove('hidden');
  }
});

els.logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

els.newChatBtn.addEventListener('click', newConversation);

els.sendBtn.addEventListener('click', () => sendMessage(els.input.value));
els.stopBtn.addEventListener('click', stopStreaming);

els.reviewBtn.addEventListener('click', () => {
  const text = els.input.value.trim();
  if (!text) {
    els.input.placeholder = 'Paste your solution code here, then click "Review my solution"…';
    els.input.focus();
    return;
  }
  sendMessage(text, { review: true });
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});

function autosizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, window.innerHeight * 0.4) + 'px';
}
els.input.addEventListener('input', autosizeInput);

els.modeSelect.addEventListener('change', () => {
  const conv = activeConv();
  if (conv) {
    conv.mode = els.modeSelect.value;
    saveIndex();
  }
});

els.modelSelect.addEventListener('change', () => {
  const conv = activeConv();
  if (conv) {
    conv.model = els.modelSelect.value;
    saveIndex();
  }
  setModelBadge();
});

// Mobile sidebar
function closeSidebar() {
  els.app.classList.remove('sidebar-open');
}
els.menuBtn.addEventListener('click', () => els.app.classList.toggle('sidebar-open'));
els.sidebarOverlay.addEventListener('click', closeSidebar);

checkAuth();
