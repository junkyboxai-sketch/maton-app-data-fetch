// Persistent store for Maton API keys.
//
// The active key stays in `matonApiKey` (every request reads it from there),
// and every key that has ever been saved is kept in `matonApiKeys` so it can
// be picked again later. Nothing is ever sent anywhere — this is one browser's
// local storage only.

const ACTIVE_STORAGE_KEY = 'matonApiKey';
const LIST_STORAGE_KEY = 'matonApiKeys';

function readList() {
  try {
    const raw = localStorage.getItem(LIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(entry => entry && typeof entry.key === 'string' && entry.key);
  } catch (e) {
    return [];
  }
}

function writeList(entries) {
  try {
    localStorage.setItem(LIST_STORAGE_KEY, JSON.stringify(entries));
  } catch (e) { /* private mode or quota; the active key still works */ }
}

function makeId() {
  return 'k_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function activeKey() {
  try {
    return localStorage.getItem(ACTIVE_STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

/** `mtn_1234••••••••••••cdef` — enough to tell two keys apart, not enough to use. */
export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 10) return '•'.repeat(Math.max(value.length, 6));
  return `${value.slice(0, 6)}${'•'.repeat(10)}${value.slice(-4)}`;
}

/**
 * A key saved before this feature existed lives only in `matonApiKey`.
 * Pull it into the list so it shows up alongside the rest.
 */
function migrate() {
  const active = activeKey();
  if (!active) return;

  const entries = readList();
  if (entries.some(entry => entry.key === active)) return;

  entries.push({
    id: makeId(),
    key: active,
    label: `Key ${entries.length + 1}`,
    addedAt: Date.now(),
    lastUsedAt: Date.now()
  });
  writeList(entries);
}

/** Saved keys, most recently used first, with the active one flagged. */
export function listKeys() {
  migrate();
  const active = activeKey();
  return readList()
    .map(entry => ({ ...entry, isActive: entry.key === active }))
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    });
}

export function getKey(id) {
  return readList().find(entry => entry.id === id) || null;
}

function setActive(key) {
  try {
    localStorage.setItem(ACTIVE_STORAGE_KEY, key);
  } catch (e) { /* nothing more we can do */ }
  document.dispatchEvent(new CustomEvent('maton:key-changed', { detail: { key } }));
}

/**
 * Save a key and make it active. Re-saving an existing key just promotes it
 * rather than creating a duplicate entry.
 * @returns {object} the stored entry
 */
export function saveKey(key, label) {
  const value = String(key || '').trim();
  if (!value) throw new Error('API key is required');

  migrate();
  const entries = readList();
  const existing = entries.find(entry => entry.key === value);

  let entry;
  if (existing) {
    existing.lastUsedAt = Date.now();
    if (label && label.trim()) existing.label = label.trim();
    entry = existing;
  } else {
    entry = {
      id: makeId(),
      key: value,
      label: (label && label.trim()) || `Key ${entries.length + 1}`,
      addedAt: Date.now(),
      lastUsedAt: Date.now()
    };
    entries.push(entry);
  }

  writeList(entries);
  setActive(value);
  return entry;
}

/** Switch the active key to a previously saved one. */
export function selectKey(id) {
  const entries = readList();
  const entry = entries.find(item => item.id === id);
  if (!entry) return null;

  entry.lastUsedAt = Date.now();
  writeList(entries);
  setActive(entry.key);
  return entry;
}

export function renameKey(id, label) {
  const entries = readList();
  const entry = entries.find(item => item.id === id);
  if (!entry) return null;
  entry.label = String(label || '').trim() || entry.label;
  writeList(entries);
  return entry;
}

/**
 * Forget a saved key. Removing the active one promotes the next most
 * recently used key so the app does not silently lose its credentials.
 */
export function removeKey(id) {
  const entries = readList();
  const entry = entries.find(item => item.id === id);
  if (!entry) return;

  const remaining = entries.filter(item => item.id !== id);
  writeList(remaining);

  if (entry.key !== activeKey()) return;

  const next = remaining.slice().sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0];
  if (next) {
    setActive(next.key);
  } else {
    try {
      localStorage.removeItem(ACTIVE_STORAGE_KEY);
    } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('maton:key-changed', { detail: { key: '' } }));
  }
}

export function hasKey() {
  return !!activeKey();
}
