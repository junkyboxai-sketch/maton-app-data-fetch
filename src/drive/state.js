// Observable store for the Drive workspace, mirroring src/state.js.

const listeners = new Map();
let nextListenerId = 1;

export const driveState = {
  // Navigation
  view: 'mydrive',        // mydrive | shared | recent | starred | trash | folder
  folderId: '',           // when view === 'folder'
  breadcrumbs: [],        // [{ id, name, isRoot }]
  search: '',

  // Back/forward trail, owned by ./history.js: { entries, index }
  history: { entries: [], index: -1 },

  // Listing
  files: [],
  loading: false,
  error: null,
  nextPageToken: null,
  sort: 'modified',       // newest first by default
  layout: 'list',         // list | grid

  // Selection
  selected: new Set(),
  lastClickedId: null,    // anchor for shift-click ranges

  // Panels
  detailsFor: null,       // file object shown in the right-hand panel
  detailsOpen: false,

  // File surface. Preview is a dismissible overlay; open is a full-window
  // surface that replaces the browser — two different things, as in Drive.
  openFile: null,
  openMode: null,         // null | 'preview' | 'open'
  editor: null,           // null | 'sheets' | 'docs' (only while openMode === 'open')
  openLoading: false,
  openError: null,

  // Share dialog
  shareFile: null,
  sharePermissions: [],
  shareLoading: false,

  // Account
  about: null,

  // Active folder download: { status, phase, label, done, total, bytes, name }
  transfer: null,

  // Drag state for move-by-drop
  dragIds: []
};

export function subscribeDrive(fn) {
  const id = nextListenerId++;
  listeners.set(id, fn);
  return () => listeners.delete(id);
}

export function setDriveState(patch) {
  const changed = [];
  Object.keys(patch).forEach(key => {
    if (driveState[key] !== patch[key]) changed.push(key);
    driveState[key] = patch[key];
  });
  if (changed.length) emitDrive(changed);
  return changed;
}

export function emitDrive(changed) {
  listeners.forEach(fn => fn(changed, driveState));
}

export function isSelected(id) {
  return driveState.selected.has(id);
}

export function selectedIds() {
  return Array.from(driveState.selected);
}

export function selectedFiles() {
  return driveState.files.filter(f => driveState.selected.has(f.id));
}

export function clearSelection() {
  if (!driveState.selected.size) return;
  driveState.selected.clear();
  emitDrive(['selected']);
}

export function toggleSelected(id, force) {
  const shouldSelect = force === undefined ? !driveState.selected.has(id) : force;
  if (shouldSelect) driveState.selected.add(id);
  else driveState.selected.delete(id);
  driveState.lastClickedId = id;
  emitDrive(['selected']);
}

export function selectOnly(id) {
  driveState.selected.clear();
  if (id) driveState.selected.add(id);
  driveState.lastClickedId = id;
  emitDrive(['selected']);
}

/** Shift-click: select the contiguous run between the anchor and this row. */
export function selectRange(toId) {
  const ids = driveState.files.map(f => f.id);
  const from = ids.indexOf(driveState.lastClickedId);
  const to = ids.indexOf(toId);
  if (to === -1) return;

  if (from === -1) {
    driveState.selected.add(toId);
  } else {
    const [start, end] = from < to ? [from, to] : [to, from];
    for (let i = start; i <= end; i++) driveState.selected.add(ids[i]);
  }
  emitDrive(['selected']);
}

export function selectAll() {
  driveState.files.forEach(f => driveState.selected.add(f.id));
  emitDrive(['selected']);
}

/** Optimistically patch files in the current listing. */
export function patchFiles(ids, patch) {
  const idSet = new Set(ids);
  driveState.files = driveState.files.map(file =>
    idSet.has(file.id) ? { ...file, ...patch } : file
  );
  emitDrive(['files']);
}

export function removeFiles(ids) {
  const idSet = new Set(ids);
  driveState.files = driveState.files.filter(file => !idSet.has(file.id));
  ids.forEach(id => driveState.selected.delete(id));
  if (driveState.detailsFor && idSet.has(driveState.detailsFor.id)) {
    driveState.detailsFor = null;
  }
  emitDrive(['files', 'selected', 'detailsFor']);
}
