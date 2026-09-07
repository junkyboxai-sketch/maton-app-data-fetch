// A tiny observable store. Views subscribe to the slices they care about and
// re-render when those change; nothing else in the app touches state directly.

const listeners = new Map();
let nextListenerId = 1;

export const state = {
  // Navigation
  view: 'inbox',            // inbox | starred | important | sent | drafts | trash | spam | all
  label: '',                // user label name, mutually exclusive with view
  category: 'primary',      // inbox tabs: primary | social | promotions | updates | forums
  search: '',

  // Thread list
  threads: [],
  drafts: [],
  loading: false,
  error: null,
  nextPageToken: null,
  pageTokens: [''],         // token stack so "older/newer" can walk backwards
  pageIndex: 0,
  resultSizeEstimate: 0,

  // Selection + open thread
  selected: new Set(),
  openThreadId: null,
  openThread: null,
  threadLoading: false,
  cursorIndex: -1,          // keyboard navigation cursor

  // Account
  profile: null,
  labels: [],

  // Compose windows, newest last
  composers: []
};

export function subscribe(fn) {
  const id = nextListenerId++;
  listeners.set(id, fn);
  return () => listeners.delete(id);
}

/** Merge a patch into state and notify subscribers with the changed keys. */
export function setState(patch) {
  const changed = [];
  Object.keys(patch).forEach(key => {
    if (state[key] !== patch[key]) changed.push(key);
    state[key] = patch[key];
  });
  if (changed.length) emit(changed);
  return changed;
}

/** Notify subscribers without replacing a reference (Sets, arrays mutated in place). */
export function emit(changed) {
  listeners.forEach(fn => fn(changed, state));
}

/** The label id backing the current view, used for archive/move semantics. */
export function currentLabelId() {
  const map = {
    inbox: 'INBOX',
    starred: 'STARRED',
    important: 'IMPORTANT',
    sent: 'SENT',
    drafts: 'DRAFT',
    trash: 'TRASH',
    spam: 'SPAM'
  };
  return map[state.view] || null;
}

export function isSelected(id) {
  return state.selected.has(id);
}

export function toggleSelected(id, force) {
  const shouldSelect = force === undefined ? !state.selected.has(id) : force;
  if (shouldSelect) state.selected.add(id);
  else state.selected.delete(id);
  emit(['selected']);
}

export function clearSelection() {
  if (!state.selected.size) return;
  state.selected.clear();
  emit(['selected']);
}

export function selectedIds() {
  return Array.from(state.selected);
}

/** Apply an optimistic change to the in-memory thread list. */
export function patchThreads(ids, patch) {
  const idSet = new Set(ids);
  state.threads = state.threads.map(thread =>
    idSet.has(thread.id) ? { ...thread, ...patch } : thread
  );
  emit(['threads']);
}

/** Remove threads from the current list, e.g. after archive or trash. */
export function removeThreads(ids) {
  const idSet = new Set(ids);
  state.threads = state.threads.filter(thread => !idSet.has(thread.id));
  ids.forEach(id => state.selected.delete(id));
  emit(['threads', 'selected']);
}
