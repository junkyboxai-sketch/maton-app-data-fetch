// Thread mutations shared by the list and the open-thread view.
// Each one updates the UI optimistically, calls the API, and rolls back on error.

import { api } from './api.js';
import { state, setState, patchThreads, removeThreads, clearSelection, emit } from './state.js';
import { esc } from './util.js';

let toastEl = null;
let toastTimer = null;
let pendingUndo = null;

function ensureToast() {
  if (toastEl) return toastEl;
  toastEl = document.createElement('div');
  toastEl.className = 'gm-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.hidden = true;
  document.body.appendChild(toastEl);

  toastEl.addEventListener('click', event => {
    const button = event.target.closest('[data-toast-action]');
    if (!button) return;
    if (button.dataset.toastAction === 'undo' && pendingUndo) {
      const undo = pendingUndo;
      pendingUndo = null;
      hideToast();
      undo();
    }
  });
  return toastEl;
}

export function hideToast() {
  if (!toastEl) return;
  toastEl.hidden = true;
  clearTimeout(toastTimer);
}

/**
 * Gmail's bottom-left confirmation strip.
 * @param {string} message
 * @param {Function} [undo] when given, an "Undo" affordance is shown
 */
export function toast(message, undo = null) {
  const node = ensureToast();
  pendingUndo = undo;
  node.innerHTML = `<span class="gm-toast-text">${esc(message)}</span>`
    + (undo ? '<button class="gm-toast-btn" data-toast-action="undo">Undo</button>' : '');
  node.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    pendingUndo = null;
    node.hidden = true;
  }, undo ? 12000 : 5000);
}

function refreshLabelCounts() {
  // Counts live server-side; re-pull them without blocking the interaction.
  import('./mail.js').then(mod => mod.refreshLabels()).catch(() => {});
}

async function run(ids, optimistic, call, { message, undo, removes } = {}) {
  if (!ids.length) return;
  const snapshot = state.threads.slice();

  optimistic();
  clearSelection();

  try {
    await call();
    if (message) toast(message, undo || null);
    refreshLabelCounts();
  } catch (err) {
    setState({ threads: snapshot });
    emit(['threads']);
    toast(err.message || 'Action failed');
  }

  // A removal can empty the page; let the caller top it back up.
  if (removes) document.dispatchEvent(new CustomEvent('gm:list-shrank'));
}

export function archive(ids) {
  return run(
    ids,
    () => removeThreads(ids),
    () => api.modifyThreads(ids, [], ['INBOX']),
    {
      message: `Conversation${ids.length > 1 ? 's' : ''} archived.`,
      undo: () => unarchive(ids),
      removes: true
    }
  );
}

export function unarchive(ids) {
  return run(
    ids,
    () => {},
    () => api.modifyThreads(ids, ['INBOX'], []),
    { message: 'Moved to Inbox.' }
  );
}

export function trash(ids) {
  return run(
    ids,
    () => removeThreads(ids),
    () => api.trashThreads(ids),
    {
      message: `Conversation${ids.length > 1 ? 's' : ''} moved to Trash.`,
      undo: () => untrash(ids),
      removes: true
    }
  );
}

export function untrash(ids) {
  return run(
    ids,
    () => removeThreads(ids),
    () => api.trashThreads(ids, true),
    { message: 'Moved out of Trash.', removes: true }
  );
}

export function deleteForever(ids) {
  const plural = ids.length > 1 ? `${ids.length} conversations` : 'this conversation';
  if (!confirm(`Delete ${plural} forever? This cannot be undone.`)) return Promise.resolve();
  return run(
    ids,
    () => removeThreads(ids),
    () => api.deleteThreads(ids),
    { message: 'Deleted forever.', removes: true }
  );
}

export function markSpam(ids) {
  return run(
    ids,
    () => removeThreads(ids),
    () => api.modifyThreads(ids, ['SPAM'], ['INBOX']),
    {
      message: 'Reported spam.',
      undo: () => run(ids, () => {}, () => api.modifyThreads(ids, ['INBOX'], ['SPAM']), { message: 'Moved to Inbox.' }),
      removes: true
    }
  );
}

export function setRead(ids, read) {
  return run(
    ids,
    () => patchThreads(ids, { unread: !read }),
    () => (read ? api.modifyThreads(ids, [], ['UNREAD']) : api.modifyThreads(ids, ['UNREAD'], [])),
    { message: read ? 'Marked as read.' : 'Marked as unread.' }
  );
}

export function setStarred(ids, starred) {
  return run(
    ids,
    () => patchThreads(ids, { starred }),
    () => (starred ? api.modifyThreads(ids, ['STARRED'], []) : api.modifyThreads(ids, [], ['STARRED'])),
    {}
  );
}

export function applyLabel(ids, labelId, add = true) {
  return run(
    ids,
    () => {},
    () => (add ? api.modifyThreads(ids, [labelId], []) : api.modifyThreads(ids, [], [labelId])),
    { message: add ? 'Label applied.' : 'Label removed.' }
  );
}
