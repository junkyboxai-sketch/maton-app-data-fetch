// Entry point for the Drive workspace: shell, data loading, and every
// interaction routed to the right view module.

import { driveApi } from './api.js';
import {
  driveState, setDriveState, subscribeDrive,
  selectOnly, toggleSelected, selectRange, selectAll, clearSelection,
  selectedIds, selectedFiles
} from './state.js';
import { esc } from '../util.js';
import { nativeEditor } from './util.js';
import * as history from './history.js';
import { renderDriveSidebar, bindDriveSidebar } from './views/sidebar.js';
import { renderDriveList, contextMenuMarkup } from './views/list.js';
import { renderDetails } from './views/details.js';
import { renderViewer } from './views/viewer.js';
import {
  renderShare, loadPermissions, addPerson, changeRole, enableLinkSharing
} from './views/share.js';
import { mountSheetsEditor, sheetsHasUnsavedChanges } from './views/sheets.js';
import { mountDocsEditor, docsHasUnsavedChanges } from './views/docs.js';
import * as actions from './actions.js';
import { renderTransfer } from './views/transfer.js';
import { downloadFiles, cancelDownload } from './download.js';

let els = {};
let started = false;
let active = false;

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function buildShell(root) {
  root.innerHTML = `
    <aside class="dr-sidebar" id="dr-sidebar"></aside>
    <div class="dr-main">
      <div class="dr-toolbar-host" id="dr-toolbar"></div>
      <div class="dr-list" id="dr-list" tabindex="-1"></div>
    </div>
    <aside class="dr-details" id="dr-details" hidden></aside>
    <div class="dr-viewer" id="dr-viewer" hidden></div>
    <div class="dr-modal-host" id="dr-share" hidden></div>
    <div class="dr-context" id="dr-context" hidden></div>
    <div class="dr-transfer-host" id="dr-transfer" hidden></div>`;

  els = {
    root,
    sidebar: root.querySelector('#dr-sidebar'),
    toolbar: root.querySelector('#dr-toolbar'),
    list: root.querySelector('#dr-list'),
    details: root.querySelector('#dr-details'),
    viewer: root.querySelector('#dr-viewer'),
    share: root.querySelector('#dr-share'),
    context: root.querySelector('#dr-context'),
    transfer: root.querySelector('#dr-transfer'),
    search: document.getElementById('search-input')
  };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadAbout() {
  try {
    setDriveState({ about: await driveApi.about() });
  } catch (e) { /* the storage meter is optional */ }
}

async function loadBreadcrumbs(folderId) {
  if (!folderId) return setDriveState({ breadcrumbs: [] });
  try {
    const data = await driveApi.path(folderId);
    setDriveState({ breadcrumbs: data.path || [] });
  } catch (e) {
    setDriveState({ breadcrumbs: [{ id: folderId, name: 'Folder' }] });
  }
}

async function loadFiles({ refresh = false, append = false, silent = false } = {}) {
  if (!silent) setDriveState({ loading: !append, error: null });

  try {
    const data = await driveApi.list({
      view: driveState.search ? 'mydrive' : driveState.view,
      parent: driveState.view === 'folder' ? driveState.folderId : '',
      search: driveState.search,
      sort: driveState.sort,
      pageToken: append ? (driveState.nextPageToken || '') : '',
      refresh
    });

    setDriveState({
      files: append ? driveState.files.concat(data.files || []) : (data.files || []),
      nextPageToken: data.nextPageToken,
      loading: false,
      error: null
    });
  } catch (err) {
    if (silent) return;
    setDriveState({ loading: false, error: err.message, files: [] });
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Apply a location. `record` is false when the move came from the trail
 * itself, so stepping back does not append a new entry.
 */
function applyLocation({ view, folderId = '', search = '', breadcrumbs = null }, { record = true } = {}) {
  clearSelection();
  setDriveState({
    view,
    folderId,
    search,
    nextPageToken: null,
    detailsFor: null,
    breadcrumbs: view === 'folder' ? (breadcrumbs || []) : []
  });

  if (record) setDriveState({ history: history.push(driveState.history, { view, folderId, search }) });

  if (els.search) els.search.value = search;
  els.list.scrollTop = 0;

  // Only walk the ancestry when the trail did not already carry it.
  if (view === 'folder' && !breadcrumbs) {
    const index = driveState.history.index;
    loadBreadcrumbs(folderId).then(() => {
      setDriveState({ history: history.remember(driveState.history, index, driveState.breadcrumbs) });
    });
  }

  render();
  loadFiles();
}

function navigate(location) {
  applyLocation(location, { record: true });
}

function openFolder(file) {
  navigate({ view: 'folder', folderId: file.id });
}

function stepHistory(delta) {
  const next = history.step(driveState.history, delta);
  if (!next) return;
  setDriveState({ history: next.history });
  applyLocation(next.location, { record: false });
}

function goBack() {
  stepHistory(-1);
}

function goForward() {
  stepHistory(1);
}

// ---------------------------------------------------------------------------
// Viewer / editors
// ---------------------------------------------------------------------------

/**
 * Open a file in its full in-app surface. Docs and Sheets get their real
 * editor; everything else gets a full-window viewer. Never leaves Maton.
 */
async function openFile(file) {
  if (file.isFolder) return openFolder(file);

  const editor = nativeEditor(file);
  setDriveState({ openFile: file, openMode: 'open', editor, openError: null });

  const host = await renderViewer(els.viewer);
  if (!host || !editor) return;

  if (editor === 'sheets') await mountSheetsEditor(host, file);
  if (editor === 'docs') await mountDocsEditor(host, file);
}

/** Quick look: a dismissible read-only overlay. A different thing from open. */
async function previewFile(file) {
  if (file.isFolder) return openFolder(file);
  setDriveState({ openFile: file, openMode: 'preview', editor: null, openError: null });
  await renderViewer(els.viewer);
}

function hasUnsavedEdits() {
  if (driveState.openMode !== 'open') return false;
  if (driveState.editor === 'sheets') return sheetsHasUnsavedChanges();
  if (driveState.editor === 'docs') return docsHasUnsavedChanges();
  return false;
}

/** Tear the surface down without prompting — used when the key changes. */
function closeViewerSilently() {
  setDriveState({ openFile: null, openMode: null, editor: null, openError: null });
  els.viewer.hidden = true;
  els.viewer.className = 'dr-viewer';
  els.viewer.innerHTML = '';
}

function closeViewer() {
  if (hasUnsavedEdits() && !confirm('You have unsaved changes. Close anyway?')) return;
  closeViewerSilently();
}

/** Arrow keys and the prev/next buttons step through the current listing. */
function stepViewer(delta) {
  const index = driveState.files.findIndex(f => f.id === driveState.openFile.id);
  const next = driveState.files[index + delta];
  if (!next || next.isFolder) return;
  if (driveState.openMode === 'open') openFile(next);
  else previewFile(next);
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function showContextMenu(file, x, y) {
  els.context.innerHTML = `<div class="dr-menu is-context" data-file-id="${esc(file.id)}">
    ${contextMenuMarkup(file)}
  </div>`;
  els.context.hidden = false;

  const menu = els.context.firstElementChild;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function hideContextMenu() {
  els.context.hidden = true;
  els.context.innerHTML = '';
}

async function runMenuAction(action, file) {
  hideContextMenu();
  switch (action) {
    case 'open': return openFile(file);
    case 'preview': return previewFile(file);
    case 'share': return openShare(file);
    case 'download': return downloadFiles([file]);
    case 'rename': return actions.rename(file);
    case 'copy': return actions.copy(file);
    case 'star': return actions.setStarred([file.id], !file.starred);
    case 'details':
      setDriveState({ detailsFor: file, detailsOpen: true });
      return;
    case 'open-google':
      if (file.webViewLink) window.open(file.webViewLink, '_blank', 'noopener');
      return;
    case 'trash': return actions.trash([file.id], [file.name]);
    case 'restore': return actions.restore([file.id]);
    case 'delete': return actions.deleteForever([file.id]);
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

async function openShare(file) {
  await loadPermissions(file);
}

function closeShare() {
  setDriveState({ shareFile: null, sharePermissions: [] });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SIDEBAR_KEYS = ['view', 'search', 'about'];
const LIST_KEYS = ['files', 'loading', 'error', 'selected', 'view', 'search',
  'sort', 'layout', 'breadcrumbs', 'nextPageToken', 'detailsOpen',
  'history'];
const DETAILS_KEYS = ['detailsFor', 'detailsOpen', 'files'];
const SHARE_KEYS = ['shareFile', 'sharePermissions', 'shareLoading'];
const TRANSFER_KEYS = ['transfer'];
const VIEWER_KEYS = ['openFile', 'openMode', 'editor', 'openError'];

function render() {
  renderDriveSidebar(els.sidebar);
  renderDriveList({ toolbarEl: els.toolbar, listEl: els.list });
  renderDetails(els.details);
  renderShare(els.share);
  renderTransfer(els.transfer);
}

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

    if (keys.some(k => SIDEBAR_KEYS.includes(k))) renderDriveSidebar(els.sidebar);
    if (keys.some(k => LIST_KEYS.includes(k))) renderDriveList({ toolbarEl: els.toolbar, listEl: els.list });
    if (keys.some(k => DETAILS_KEYS.includes(k))) renderDetails(els.details);
    if (keys.some(k => SHARE_KEYS.includes(k))) renderShare(els.share);
    if (keys.some(k => TRANSFER_KEYS.includes(k))) renderTransfer(els.transfer);
    // The viewer repaints itself on open; only a star toggle needs a refresh.
    if (keys.some(k => VIEWER_KEYS.includes(k)) && driveState.openFile
      && driveState.openMode === 'viewer' && keys.includes('files')) {
      renderViewer(els.viewer);
    }
  });
}

function fileById(id) {
  return driveState.files.find(f => f.id === id)
    || (driveState.detailsFor && driveState.detailsFor.id === id ? driveState.detailsFor : null);
}

// ---------------------------------------------------------------------------
// List interactions
// ---------------------------------------------------------------------------

function bindList() {
  els.list.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action]');
    if (trigger && !event.target.closest('[data-file-id]')) {
      if (trigger.dataset.action === 'refresh') return loadFiles({ refresh: true });
      if (trigger.dataset.action === 'load-more') return loadFiles({ append: true });
    }

    const item = event.target.closest('[data-file-id]');
    if (!item) return clearSelection();

    const file = fileById(item.dataset.fileId);
    if (!file) return;

    if (event.target.closest('[data-action="row-menu"]')) {
      event.stopPropagation();
      const rect = event.target.closest('[data-action="row-menu"]').getBoundingClientRect();
      selectOnly(file.id);
      return showContextMenu(file, rect.left, rect.bottom + 4);
    }

    if (event.shiftKey) selectRange(file.id);
    else if (event.ctrlKey || event.metaKey) toggleSelected(file.id);
    else selectOnly(file.id);

    if (driveState.detailsOpen) setDriveState({ detailsFor: file });
  });

  els.list.addEventListener('dblclick', event => {
    const item = event.target.closest('[data-file-id]');
    if (!item) return;
    const file = fileById(item.dataset.fileId);
    if (file) openFile(file);
  });

  els.list.addEventListener('contextmenu', event => {
    const item = event.target.closest('[data-file-id]');
    if (!item) return;
    event.preventDefault();
    const file = fileById(item.dataset.fileId);
    if (!file) return;
    if (!driveState.selected.has(file.id)) selectOnly(file.id);
    showContextMenu(file, event.clientX, event.clientY);
  });

  // --- Drag and drop: move items into a folder ---
  els.list.addEventListener('dragstart', event => {
    const item = event.target.closest('[data-file-id]');
    if (!item) return;
    const id = item.dataset.fileId;
    if (!driveState.selected.has(id)) selectOnly(id);
    driveState.dragIds = selectedIds();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', driveState.dragIds.join(','));
  });

  const overTarget = event => {
    const target = event.target.closest('[data-drop-target="true"]');
    if (!target) return null;
    const id = target.dataset.fileId || target.dataset.crumbId;
    // Dropping a folder into itself is a no-op, not a move.
    if (!id || driveState.dragIds.includes(id)) return null;
    return { target, id };
  };

  els.list.addEventListener('dragover', event => {
    const hit = overTarget(event);
    if (!hit) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    hit.target.classList.add('is-drop-target');
  });

  els.list.addEventListener('dragleave', event => {
    const target = event.target.closest('[data-drop-target="true"]');
    if (target) target.classList.remove('is-drop-target');
  });

  els.list.addEventListener('drop', event => {
    const hit = overTarget(event);
    if (!hit) return;
    event.preventDefault();
    hit.target.classList.remove('is-drop-target');
    const parent = driveState.view === 'folder' ? driveState.folderId : 'root';
    actions.move(driveState.dragIds, hit.id, parent);
    driveState.dragIds = [];
  });

  els.list.addEventListener('dragend', () => {
    els.list.querySelectorAll('.is-drop-target').forEach(n => n.classList.remove('is-drop-target'));
    driveState.dragIds = [];
  });
}

function bindToolbar() {
  els.toolbar.addEventListener('click', event => {
    const crumb = event.target.closest('[data-crumb-id]');
    if (crumb) return navigate({ view: 'folder', folderId: crumb.dataset.crumbId });

    const sortOption = event.target.closest('[data-sort]');
    if (sortOption) {
      setDriveState({ sort: sortOption.dataset.sort });
      localStorage.setItem('driveSort', driveState.sort);
      return loadFiles({ refresh: true });
    }

    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const ids = selectedIds();
    const files = selectedFiles();

    switch (trigger.dataset.action) {
      case 'history-back': goBack(); break;
      case 'history-forward': goForward(); break;
      case 'toggle-sort': {
        const menu = els.toolbar.querySelector('[data-menu="sort"]');
        if (menu) menu.hidden = !menu.hidden;
        break;
      }
      case 'toggle-layout':
        setDriveState({ layout: driveState.layout === 'list' ? 'grid' : 'list' });
        localStorage.setItem('driveLayout', driveState.layout);
        break;
      case 'toggle-details':
        setDriveState({
          detailsOpen: !driveState.detailsOpen,
          detailsFor: driveState.detailsFor || files[0] || null
        });
        break;
      case 'refresh': loadFiles({ refresh: true }); break;
      case 'clear-selection': clearSelection(); break;
      case 'bulk-star': {
        const anyStarred = files.some(f => f.starred);
        actions.setStarred(ids, !anyStarred);
        break;
      }
      case 'bulk-download': downloadFiles(files); break;
      case 'bulk-trash': actions.trash(ids, files.map(f => f.name)); break;
      case 'bulk-restore': actions.restore(ids); break;
      case 'bulk-delete': actions.deleteForever(ids); break;
      default: break;
    }
  });

  // Drop onto a breadcrumb moves items up a level.
  els.toolbar.addEventListener('dragover', event => {
    const target = event.target.closest('[data-drop-target="true"]');
    if (!target) return;
    event.preventDefault();
    target.classList.add('is-drop-target');
  });
  els.toolbar.addEventListener('dragleave', event => {
    const target = event.target.closest('[data-drop-target="true"]');
    if (target) target.classList.remove('is-drop-target');
  });
  els.toolbar.addEventListener('drop', event => {
    const target = event.target.closest('[data-crumb-id]');
    if (!target) return;
    event.preventDefault();
    target.classList.remove('is-drop-target');
    const parent = driveState.view === 'folder' ? driveState.folderId : 'root';
    actions.move(driveState.dragIds, target.dataset.crumbId, parent);
    driveState.dragIds = [];
  });
}

function bindDetails() {
  els.details.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const file = driveState.detailsFor;

    switch (trigger.dataset.action) {
      case 'close-details': setDriveState({ detailsOpen: false }); break;
      case 'open-file': if (file) openFile(file); break;
      case 'preview-file': if (file) previewFile(file); break;
      case 'download-file': if (file) downloadFiles([file]); break;
      case 'share-file': if (file) openShare(file); break;
      default: break;
    }
  });
}

function bindViewer() {
  els.viewer.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const file = driveState.openFile;

    switch (trigger.dataset.action) {
      case 'close-viewer': closeViewer(); break;
      case 'viewer-prev': stepViewer(-1); break;
      case 'viewer-next': stepViewer(1); break;
      case 'viewer-share': if (file) openShare(file); break;
      case 'viewer-star':
        if (file) {
          const starred = !file.starred;
          setDriveState({ openFile: { ...file, starred } });
          actions.setStarred([file.id], starred);
          renderViewer(els.viewer);
        }
        break;
      // Escalate a preview into the full surface, or drop back to a quick look.
      case 'open-full': if (file) openFile(file); break;
      case 'open-preview': if (file) previewFile(file); break;
      default: break;
    }
  });
}

function bindShare() {
  els.share.addEventListener('click', async event => {
    const file = driveState.shareFile;
    if (!file) return;

    if (event.target === els.share) return closeShare();

    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    switch (trigger.dataset.action) {
      case 'close-share': closeShare(); break;
      case 'enable-link': await enableLinkSharing(file); break;
      case 'copy-link':
        if (file.webViewLink) {
          navigator.clipboard.writeText(file.webViewLink)
            .then(() => actions.toast('Link copied to clipboard'))
            .catch(() => actions.toast('Could not copy the link'));
        }
        break;
      default: break;
    }
  });

  els.share.addEventListener('submit', async event => {
    if (!event.target.matches('[data-action="add-person"]')) return;
    event.preventDefault();
    const file = driveState.shareFile;
    const form = event.target;
    const email = form.email.value.trim();
    const role = form.role.value;
    const notify = els.share.querySelector('input[name="notify"]').checked;
    if (!email || !file) return;
    form.email.value = '';
    await addPerson(file, email, role, notify);
  });

  els.share.addEventListener('change', async event => {
    const select = event.target.closest('[data-permission-id]');
    if (!select || !driveState.shareFile) return;
    await changeRole(driveState.shareFile, select.dataset.permissionId, select.value);
  });
}

function bindTransfer() {
  els.transfer.addEventListener('click', event => {
    if (event.target.closest('[data-action="cancel-download"]')) cancelDownload();
  });
}

function bindContext() {
  els.context.addEventListener('click', event => {
    const item = event.target.closest('[data-menu-action]');
    if (!item) return hideContextMenu();
    const menu = els.context.querySelector('[data-file-id]');
    const file = fileById(menu.dataset.fileId);
    if (file) runMenuAction(item.dataset.menuAction, file);
  });

  document.addEventListener('click', event => {
    if (!active) return;
    if (!els.context.hidden && !event.target.closest('#dr-context')) hideContextMenu();
    const sortMenu = els.toolbar.querySelector('[data-menu="sort"]');
    if (sortMenu && !sortMenu.hidden && !event.target.closest('.dr-sort')) sortMenu.hidden = true;
  });
}

function bindSearch() {
  if (!els.search) return;
  els.search.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate({ view: 'mydrive', search: els.search.value.trim() });
    } else if (event.key === 'Escape') {
      els.search.value = '';
      els.search.blur();
      if (driveState.search) navigate({ view: 'mydrive', search: '' });
    }
    event.stopPropagation();
  });
}

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function bindShortcuts() {
  document.addEventListener('keydown', event => {
    if (!active || isTyping(event.target)) return;

    if (event.key === 'Escape') {
      if (!els.context.hidden) return hideContextMenu();
      if (driveState.shareFile) return closeShare();
      if (driveState.openFile) return closeViewer();
      if (driveState.selected.size) return clearSelection();
      return;
    }

    if (driveState.openFile) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); stepViewer(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); stepViewer(1); }
      return;
    }

    if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); return goBack(); }
    if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); return goForward(); }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      return selectAll();
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const files = selectedFiles();

    switch (event.key) {
      case '/':
        event.preventDefault();
        if (els.search) els.search.focus();
        break;
      case 'Enter':
        if (files.length === 1) { event.preventDefault(); openFile(files[0]); }
        break;
      case ' ':
        // Space is Drive's quick-look shortcut.
        if (files.length === 1) { event.preventDefault(); previewFile(files[0]); }
        break;
      case 'Delete':
        if (files.length) {
          event.preventDefault();
          if (driveState.view === 'trash') actions.deleteForever(files.map(f => f.id));
          else actions.trash(files.map(f => f.id), files.map(f => f.name));
        }
        break;
      case 's':
        if (files.length) { event.preventDefault(); actions.setStarred(files.map(f => f.id), !files[0].starred); }
        break;
      case 'n':
        event.preventDefault();
        actions.createFolder(driveState.view === 'folder' ? driveState.folderId : 'root');
        break;
      case 'v':
        event.preventDefault();
        setDriveState({ layout: driveState.layout === 'list' ? 'grid' : 'list' });
        break;
      default:
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export function initDrive(root) {
  if (started) return;
  started = true;

  buildShell(root);
  driveState.layout = localStorage.getItem('driveLayout') || 'list';
  // Newest first unless the user has chosen otherwise.
  driveState.sort = localStorage.getItem('driveSort') || 'modified';

  bindDriveSidebar(els.sidebar, {
    onNavigate: ({ view }) => navigate({ view }),
    onNewFolder: () => actions.createFolder(
      driveState.view === 'folder' ? driveState.folderId : 'root'
    )
  });
  bindList();
  bindToolbar();
  bindDetails();
  bindViewer();
  bindShare();
  bindContext();
  bindTransfer();
  bindSearch();
  bindShortcuts();

  subscribeDrive(queueRender);
  document.addEventListener('drive:changed', () => loadFiles({ refresh: true }));

  // A different API key is a different Drive; drop everything and reload.
  document.addEventListener('maton:key-changed', async () => {
    closeViewerSilently();
    setDriveState({
      about: null, files: [], breadcrumbs: [], view: 'mydrive', folderId: '',
      search: '', nextPageToken: null, detailsFor: null, shareFile: null, error: null,
      history: history.createHistory()
    });
    clearSelection();
    if (!active) return;
    await loadAbout();
    await loadFiles({ refresh: true });
  });
}

export async function activateDrive() {
  active = true;
  document.body.dataset.workspace = 'drive';
  if (els.search) {
    els.search.placeholder = 'Search in Drive';
    els.search.value = driveState.search;
  }
  if (driveState.history.index === -1) {
    setDriveState({
      history: history.push(driveState.history, {
        view: driveState.view, folderId: driveState.folderId, search: driveState.search
      })
    });
  }
  render();
  if (!driveState.about) await loadAbout();
  if (!driveState.files.length && !driveState.loading) await loadFiles();
}

export function deactivateDrive() {
  active = false;
  hideContextMenu();
}

export async function silentSyncDrive() {
  if (!active || driveState.openFile || driveState.shareFile) return;
  await loadFiles({ refresh: true, silent: true });
}
