// Back/forward trail for Drive, modelled on a browser's session history.
//
// Pure functions over a plain { entries, index } value: every operation returns
// a new trail rather than mutating one, so the store can diff it and the
// behaviour can be reasoned about (and tested) without a DOM.

export const HISTORY_LIMIT = 50;

export function createHistory() {
  return { entries: [], index: -1 };
}

/** Two locations are the same place if view, folder and search all match. */
export function sameLocation(a, b) {
  return !!a && !!b
    && a.view === b.view
    && (a.folderId || '') === (b.folderId || '')
    && (a.search || '') === (b.search || '');
}

export function current(history) {
  if (!history || history.index < 0) return null;
  return history.entries[history.index] || null;
}

export function canGoBack(history) {
  return !!history && history.index > 0;
}

export function canGoForward(history) {
  return !!history && history.index > -1 && history.index < history.entries.length - 1;
}

export function peek(history, delta) {
  if (!history) return null;
  return history.entries[history.index + delta] || null;
}

/**
 * Visit a location. Anything ahead of the cursor is discarded, which is what
 * makes "go back, then somewhere new" behave the way people expect.
 * Re-visiting the current location is a no-op so the trail never grows on a
 * plain refresh.
 */
export function push(history, location) {
  const trail = history || createHistory();
  const entries = trail.entries.slice(0, trail.index + 1);

  if (sameLocation(entries[entries.length - 1], location)) return trail;

  entries.push({
    view: location.view,
    folderId: location.folderId || '',
    search: location.search || '',
    breadcrumbs: location.breadcrumbs || null
  });

  // Drop the oldest entries once the trail is full.
  const overflow = Math.max(0, entries.length - HISTORY_LIMIT);
  return { entries: entries.slice(overflow), index: entries.length - overflow - 1 };
}

/**
 * Move the cursor. Returns the new trail and the location to apply, or null
 * when there is nowhere to go in that direction.
 */
export function step(history, delta) {
  if (!history) return null;
  const index = history.index + delta;
  if (index < 0 || index >= history.entries.length) return null;
  return { history: { entries: history.entries, index }, location: history.entries[index] };
}

/**
 * Attach a breadcrumb trail to one entry, so returning to a folder does not
 * have to walk its ancestry again. The caller passes the index it captured
 * when the request started, since the user may have moved on since.
 */
export function remember(history, index, breadcrumbs) {
  if (!history) return createHistory();
  const entry = history.entries[index];
  if (!entry || entry.view !== 'folder') return history;

  const entries = history.entries.slice();
  entries[index] = { ...entry, breadcrumbs };
  return { entries, index: history.index };
}
