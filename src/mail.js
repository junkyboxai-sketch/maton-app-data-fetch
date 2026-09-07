// Entry point for the Gmail workspace: builds the shell, loads data,
// and routes every interaction to the right view module.

import { api } from './api.js';
import { state, setState, emit, subscribe, toggleSelected, clearSelection, selectedIds, patchThreads } from './state.js';
import { esc, initials } from './util.js';
import { icon } from './icons.js';
import { renderSidebar, bindSidebar } from './views/sidebar.js';
import { renderList, PAGE_SIZE } from './views/list.js';
import { renderThread, expandMessage, expandAll, resetExpanded, printThread } from './views/thread.js';
import { initComposeDock, openComposer, renderDock, hasOpenComposers } from './views/compose.js';
import * as actions from './actions.js';

const SILENT_SYNC_KEYS = ['threads', 'labels'];

let els = {};
let started = false;
let active = false;

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function buildShell(root) {
  root.innerHTML = `
    <aside class="gm-sidebar" id="gm-sidebar"></aside>
    <div class="gm-main">
      <div class="gm-toolbar" id="gm-toolbar"></div>
      <div class="gm-list" id="gm-list" tabindex="-1"></div>
      <div class="gm-thread" id="gm-thread" hidden></div>
    </div>
    <div class="gm-compose-dock" id="gm-compose-dock"></div>`;

  els = {
    root,
    sidebar: root.querySelector('#gm-sidebar'),
    toolbar: root.querySelector('#gm-toolbar'),
    list: root.querySelector('#gm-list'),
    thread: root.querySelector('#gm-thread'),
    dock: root.querySelector('#gm-compose-dock'),
    search: document.getElementById('search-input'),
    avatar: document.getElementById('user-avatar')
  };
}

function showList() {
  els.thread.hidden = true;
  els.toolbar.hidden = false;
  els.list.hidden = false;
}

function showThread() {
  els.list.hidden = true;
  els.toolbar.hidden = true;
  els.thread.hidden = false;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export async function refreshLabels() {
  try {
    const data = await api.labels(true);
    setState({ labels: data.labels || [] });
  } catch (e) { /* counts are cosmetic; keep the last good set */ }
}

async function loadProfile() {
  try {
    const profile = await api.profile();
    setState({ profile });
    if (els.avatar && profile.emailAddress) {
      els.avatar.textContent = initials(profile.emailAddress);
      els.avatar.title = profile.emailAddress;
    }
  } catch (e) { /* the list still works without a profile */ }
}

async function loadThreads({ refresh = false, silent = false } = {}) {
  if (!silent) setState({ loading: true, error: null });

  try {
    if (state.view === 'drafts') {
      const data = await api.listDrafts();
      setState({
        drafts: data.drafts || [],
        threads: [],
        nextPageToken: null,
        resultSizeEstimate: (data.drafts || []).length,
        loading: false
      });
      return;
    }

    const data = await api.threads({
      view: state.label ? 'all' : state.view,
      label: state.label,
      category: state.view === 'inbox' && !state.search && !state.label ? state.category : '',
      q: state.search,
      pageToken: state.pageTokens[state.pageIndex] || '',
      maxResults: PAGE_SIZE,
      refresh
    });

    setState({
      threads: data.threads || [],
      nextPageToken: data.nextPageToken,
      resultSizeEstimate: data.resultSizeEstimate,
      loading: false,
      error: null
    });
  } catch (err) {
    if (silent) return;
    setState({ loading: false, error: err.message, threads: [], drafts: [] });
  }
}

async function openThread(id, historyId) {
  setState({ openThreadId: id, openThread: null, threadLoading: true });
  resetExpanded();
  showThread();
  renderThread(els.thread);

  try {
    const thread = await api.thread(id, historyId || '');
    setState({ openThread: thread, threadLoading: false });
    renderThread(els.thread);

    // Opening a conversation marks it read, exactly like Gmail.
    const summary = state.threads.find(t => t.id === id);
    if (summary && summary.unread) {
      patchThreads([id], { unread: false });
      api.modifyThreads([id], [], ['UNREAD']).then(refreshLabels).catch(() => {});
    }
  } catch (err) {
    setState({ threadLoading: false });
    els.thread.innerHTML = `<div class="gm-thread-bar">
        <button class="gm-icon-btn" data-action="back">${icon('chevronLeft')}</button>
      </div>
      <div class="gm-empty gm-empty-error">
        ${icon('report', { size: 48 })}
        <h3>Could not open this conversation</h3><p>${esc(err.message)}</p>
      </div>`;
  }
}

function backToList() {
  setState({ openThreadId: null, openThread: null });
  showList();
  render();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Switch mailbox, label, category or search. Anything not named is reset,
 * so picking a mailbox clears an active search exactly as Gmail does.
 */
function navigate({ view, label = '', category = null, search = '', resetPage = true }) {
  clearSelection();
  const patch = { openThreadId: null, openThread: null, search, cursorIndex: -1 };

  if (view === 'label') {
    patch.label = label;
    patch.view = 'label';
  } else {
    patch.view = view;
    patch.label = '';
  }
  if (category !== null) patch.category = category;
  if (resetPage) {
    patch.pageTokens = [''];
    patch.pageIndex = 0;
  }
  setState(patch);

  if (els.search) els.search.value = search;
  showList();
  render();
  loadThreads();
}

function goToPage(delta) {
  if (delta > 0) {
    if (!state.nextPageToken) return;
    const tokens = state.pageTokens.slice(0, state.pageIndex + 1);
    tokens.push(state.nextPageToken);
    setState({ pageTokens: tokens, pageIndex: state.pageIndex + 1 });
  } else {
    if (state.pageIndex === 0) return;
    setState({ pageIndex: state.pageIndex - 1 });
  }
  clearSelection();
  els.list.scrollTop = 0;
  loadThreads();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SIDEBAR_KEYS = ['labels', 'view', 'label', 'search'];
const LIST_KEYS = ['threads', 'drafts', 'selected', 'loading', 'error',
  'view', 'label', 'category', 'search', 'nextPageToken', 'cursorIndex'];
const THREAD_KEYS = ['openThread', 'threadLoading'];

function render() {
  renderSidebar(els.sidebar);
  if (state.openThreadId) renderThread(els.thread);
  else renderList({ toolbarEl: els.toolbar, listEl: els.list });
}

// State changes are coalesced into one paint per microtask, and each region
// only repaints when a key it depends on actually changed. Without this, a
// list-level patch would rebuild the open conversation and reload its iframes.
let pendingKeys = new Set();
let renderQueued = false;

function queueRender(changed) {
  changed.forEach(key => pendingKeys.add(key));
  if (renderQueued) return;
  renderQueued = true;

  queueMicrotask(() => {
    renderQueued = false;
    const keys = Array.from(pendingKeys);
    pendingKeys.clear();

    if (keys.some(key => SIDEBAR_KEYS.includes(key))) renderSidebar(els.sidebar);

    if (state.openThreadId) {
      if (keys.some(key => THREAD_KEYS.includes(key))) renderThread(els.thread);
    } else if (keys.some(key => LIST_KEYS.includes(key))) {
      renderList({ toolbarEl: els.toolbar, listEl: els.list });
    }
  });
}

// ---------------------------------------------------------------------------
// List interactions
// ---------------------------------------------------------------------------

function bindList() {
  els.list.addEventListener('click', event => {
    const tab = event.target.closest('[data-category]');
    if (tab) return navigate({ view: 'inbox', category: tab.dataset.category });

    const trigger = event.target.closest('[data-action]');
    const row = event.target.closest('.gm-row');

    if (trigger && !row) {
      if (trigger.dataset.action === 'refresh') return loadThreads({ refresh: true });
      return;
    }
    if (!row) return;

    if (row.dataset.draftId) {
      if (trigger && trigger.dataset.action === 'discard-draft') {
        event.stopPropagation();
        return discardDraft(row.dataset.draftId);
      }
      const draft = state.drafts.find(d => d.id === row.dataset.draftId);
      if (draft) openComposer({ mode: 'draft', draft });
      return;
    }

    const id = row.dataset.threadId;
    if (!trigger) return openThread(id, row.dataset.historyId);

    event.stopPropagation();
    const thread = state.threads.find(t => t.id === id);

    switch (trigger.dataset.action) {
      case 'select':
        toggleSelected(id);
        break;
      case 'star':
        actions.setStarred([id], !(thread && thread.starred));
        break;
      case 'archive':
        actions.archive([id]);
        break;
      case 'trash':
        actions.trash([id]);
        break;
      case 'untrash':
        actions.untrash([id]);
        break;
      case 'toggle-read':
        actions.setRead([id], !!(thread && thread.unread));
        break;
      default:
        openThread(id, row.dataset.historyId);
    }
  });

  els.toolbar.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const ids = selectedIds();

    switch (trigger.dataset.action) {
      case 'select-all':
        if (state.selected.size) clearSelection();
        else {
          state.threads.forEach(t => state.selected.add(t.id));
          emit(['selected']);
        }
        break;
      case 'refresh':
        loadThreads({ refresh: true });
        break;
      case 'prev-page': goToPage(-1); break;
      case 'next-page': goToPage(1); break;
      case 'bulk-archive': actions.archive(ids); break;
      case 'bulk-trash': actions.trash(ids); break;
      case 'bulk-untrash': actions.untrash(ids); break;
      case 'bulk-delete': actions.deleteForever(ids); break;
      case 'bulk-spam': actions.markSpam(ids); break;
      case 'bulk-read': actions.setRead(ids, true); break;
      case 'bulk-unread': actions.setRead(ids, false); break;
      default: break;
    }
  });
}

async function discardDraft(draftId) {
  if (!confirm('Discard this draft?')) return;
  try {
    await api.deleteDraft(draftId);
    setState({ drafts: state.drafts.filter(d => d.id !== draftId) });
    actions.toast('Draft discarded.');
    refreshLabels();
  } catch (err) {
    actions.toast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Thread interactions
// ---------------------------------------------------------------------------

function messageFor(node) {
  const block = node.closest('.gm-message');
  const thread = state.openThread;
  if (!thread) return null;
  if (block) return thread.messages.find(m => m.id === block.dataset.messageId);
  return thread.messages[thread.messages.length - 1];
}

function bindThread() {
  els.thread.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const id = state.openThreadId;
    const action = trigger.dataset.action;

    switch (action) {
      case 'back':
        backToList();
        break;
      case 'archive':
        actions.archive([id]);
        backToList();
        break;
      case 'trash':
        actions.trash([id]);
        backToList();
        break;
      case 'untrash':
        actions.untrash([id]);
        backToList();
        break;
      case 'spam':
        actions.markSpam([id]);
        backToList();
        break;
      case 'unread':
        actions.setRead([id], false);
        backToList();
        break;
      case 'print':
      case 'print-thread':
        printThread();
        break;
      case 'expand-all':
        expandAll(els.thread);
        break;
      case 'toggle-message': {
        const block = trigger.closest('.gm-message');
        if (block) expandMessage(els.thread, block.dataset.messageId);
        break;
      }
      case 'star-message': {
        event.stopPropagation();
        const msg = messageFor(trigger);
        if (!msg) break;
        // Keep the open thread's own copy in step; the list patch alone
        // does not reach the message header.
        msg.starred = !msg.starred;
        actions.setStarred([id], msg.starred);
        renderThread(els.thread);
        break;
      }
      case 'reply-message':
        event.stopPropagation();
        openComposer({ mode: 'reply', message: messageFor(trigger) });
        break;
      case 'reply':
        openComposer({ mode: 'reply', message: messageFor(trigger) });
        break;
      case 'reply-all':
        openComposer({ mode: 'replyAll', message: messageFor(trigger) });
        break;
      case 'forward':
        openComposer({ mode: 'forward', message: messageFor(trigger) });
        break;
      default:
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function bindSearch() {
  if (!els.search) return;

  els.search.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate({ view: 'all', search: els.search.value.trim() });
    } else if (event.key === 'Escape') {
      els.search.value = '';
      els.search.blur();
      if (state.search) navigate({ view: 'inbox', search: '' });
    }
    event.stopPropagation();
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function moveCursor(delta) {
  const max = state.threads.length - 1;
  if (max < 0) return;
  const next = Math.min(Math.max(state.cursorIndex + delta, 0), max);
  setState({ cursorIndex: next });
  // The row is rebuilt by the queued render, so scroll on the next microtask.
  queueMicrotask(() => {
    const row = els.list.querySelector(`.gm-row[data-index="${next}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

function cursorThread() {
  return state.threads[state.cursorIndex] || null;
}

function bindShortcuts() {
  document.addEventListener('keydown', event => {
    if (!active || isTyping(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const inThread = !!state.openThreadId;
    const target = inThread
      ? state.openThreadId
      : (state.selected.size ? null : (cursorThread() || {}).id);
    const ids = state.selected.size ? selectedIds() : (target ? [target] : []);

    switch (event.key) {
      case 'c':
        event.preventDefault();
        openComposer({ mode: 'new' });
        break;
      case '/':
        event.preventDefault();
        if (els.search) els.search.focus();
        break;
      case 'j': event.preventDefault(); moveCursor(1); break;
      case 'k': event.preventDefault(); moveCursor(-1); break;
      case 'o':
      case 'Enter': {
        if (inThread) break;
        const thread = cursorThread();
        if (thread) {
          event.preventDefault();
          openThread(thread.id, thread.historyId);
        }
        break;
      }
      case 'u':
        if (inThread) { event.preventDefault(); backToList(); }
        break;
      case 'e':
        if (ids.length) { event.preventDefault(); actions.archive(ids); if (inThread) backToList(); }
        break;
      case '#':
        if (ids.length) { event.preventDefault(); actions.trash(ids); if (inThread) backToList(); }
        break;
      case 's': {
        if (!ids.length) break;
        event.preventDefault();
        const thread = state.threads.find(t => t.id === ids[0]);
        actions.setStarred(ids, !(thread && thread.starred));
        break;
      }
      case 'x': {
        const thread = cursorThread();
        if (thread && !inThread) { event.preventDefault(); toggleSelected(thread.id); }
        break;
      }
      case 'r':
      case 'a':
      case 'f': {
        if (!inThread || !state.openThread) break;
        event.preventDefault();
        const last = state.openThread.messages[state.openThread.messages.length - 1];
        const mode = event.key === 'r' ? 'reply' : event.key === 'a' ? 'replyAll' : 'forward';
        openComposer({ mode, message: last });
        break;
      }
      case 'Escape':
        if (state.selected.size) { event.preventDefault(); clearSelection(); }
        else if (inThread) { event.preventDefault(); backToList(); }
        break;
      default:
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export function initMail(root) {
  if (started) return;
  started = true;

  buildShell(root);
  initComposeDock(els.dock);

  bindSidebar(els.sidebar, {
    onNavigate: navigate,
    onCompose: () => openComposer({ mode: 'new' }),
    onRerender: () => renderSidebar(els.sidebar)
  });
  bindList();
  bindThread();
  bindSearch();
  bindShortcuts();

  subscribe(queueRender);

  document.addEventListener('gm:message-sent', () => {
    refreshLabels();
    if (!state.openThreadId) loadThreads({ refresh: true });
  });
  document.addEventListener('gm:composer-closed', () => {
    if (state.view === 'drafts') loadThreads({ refresh: true });
    else refreshLabels();
  });
  document.addEventListener('gm:list-shrank', () => {
    if (!state.threads.length && state.nextPageToken) loadThreads({ refresh: true });
  });

  // A different API key is a different mailbox; drop everything and reload.
  document.addEventListener('maton:key-changed', async () => {
    setState({
      profile: null, labels: [], threads: [], drafts: [],
      openThreadId: null, openThread: null,
      pageTokens: [''], pageIndex: 0, search: '', error: null
    });
    clearSelection();
    if (!active) return;
    showList();
    await loadProfile();
    await refreshLabels();
    await loadThreads({ refresh: true });
  });
}

/** Called by the shell when the Mail workspace becomes visible. */
export async function activate() {
  active = true;
  document.body.dataset.workspace = 'mail';
  if (els.search) {
    els.search.placeholder = 'Search mail';
    els.search.value = state.search;
  }
  render();
  if (!state.profile) await loadProfile();
  if (!state.labels.length) await refreshLabels();
  if (!state.threads.length && !state.loading) await loadThreads();
}

export function deactivate() {
  active = false;
}

/** Background poll used by the shell's live-sync toggle. */
export async function silentSync() {
  if (!active || state.openThreadId || hasOpenComposers()) return;
  await loadThreads({ refresh: true, silent: true });
  await refreshLabels();
  emit(SILENT_SYNC_KEYS);
}

export { openComposer, renderDock };
