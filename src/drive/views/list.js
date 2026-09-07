// The file browser: breadcrumbs, toolbar, selection bar, list and grid layouts.

import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { driveState, isSelected } from '../state.js';
import { fileType, formatFileSize, formatDriveDate } from '../util.js';

const VIEW_TITLES = {
  mydrive: 'My Drive',
  shared: 'Shared with me',
  recent: 'Recent',
  starred: 'Starred',
  trash: 'Trash'
};

const SORT_OPTIONS = [
  { id: 'modified', label: 'Last modified' },
  { id: 'created', label: 'Date created' },
  { id: 'name', label: 'Name' },
  { id: 'size', label: 'Size' }
];

// Only a name sort groups folders above files. Sorting by a date means the
// user wants strict newest-to-oldest across everything, folders included.
const DATE_SORTS = ['modified', 'created'];

const EMPTY_COPY = {
  mydrive: ['A place for all of your files', 'Folders you create will show up here.'],
  shared: ['Nothing shared with you', 'Files other people share will appear here.'],
  recent: ['No recent files', 'Files you open will show up here.'],
  starred: ['No starred files', 'Add stars to things you want to find quickly.'],
  trash: ['Trash is empty', 'Items you delete land here first.'],
  folder: ['This folder is empty', 'Nothing has been added to it yet.']
};

// --- Breadcrumbs ------------------------------------------------------------

function breadcrumbs() {
  if (driveState.search) {
    return `<div class="dr-crumbs">
      <span class="dr-crumb is-current">Search results for “${esc(driveState.search)}”</span>
    </div>`;
  }

  const trail = driveState.breadcrumbs;
  if (driveState.view !== 'folder' || !trail.length) {
    return `<div class="dr-crumbs">
      <span class="dr-crumb is-current">${esc(VIEW_TITLES[driveState.view] || 'My Drive')}</span>
    </div>`;
  }

  return `<div class="dr-crumbs">
    ${trail.map((crumb, index) => {
      const last = index === trail.length - 1;
      return `
        ${index ? `<span class="dr-crumb-sep">${icon('chevronRight', { size: 18 })}</span>` : ''}
        <span class="dr-crumb${last ? ' is-current' : ''}"
              ${last ? '' : `data-crumb-id="${esc(crumb.id)}" data-drop-target="true" role="button" tabindex="0"`}>
          ${esc(crumb.name)}
        </span>`;
    }).join('')}
  </div>`;
}

// --- Toolbar ----------------------------------------------------------------

function toolbar() {
  const count = driveState.selected.size;

  if (count) {
    const inTrash = driveState.view === 'trash';
    const anyStarred = driveState.files.some(f => driveState.selected.has(f.id) && f.starred);
    return `
      <div class="dr-toolbar is-selection">
        <button class="dr-icon-btn" data-action="clear-selection" title="Clear selection">
          ${icon('close', { size: 20 })}
        </button>
        <span class="dr-selection-count">${count} selected</span>
        <span class="dr-toolbar-gap"></span>
        ${inTrash ? `
          <button class="dr-icon-btn" data-action="bulk-restore" title="Restore">${icon('restore', { size: 20 })}</button>
          <button class="dr-icon-btn" data-action="bulk-delete" title="Delete forever">${icon('delete', { size: 20 })}</button>
        ` : `
          <button class="dr-icon-btn" data-action="bulk-star" title="${anyStarred ? 'Remove star' : 'Add star'}">
            ${icon(anyStarred ? 'star' : 'starOutline', { size: 20 })}
          </button>
          <button class="dr-icon-btn" data-action="bulk-trash" title="Move to trash">${icon('delete', { size: 20 })}</button>
        `}
      </div>`;
  }

  const sortLabel = (SORT_OPTIONS.find(s => s.id === driveState.sort) || SORT_OPTIONS[0]).label;
  return `
    <div class="dr-toolbar">
      ${breadcrumbs()}
      <span class="dr-toolbar-gap"></span>
      <div class="dr-sort">
        <button class="dr-chip" data-action="toggle-sort">
          <span>${esc(sortLabel)}</span>${icon('expandMore', { size: 18 })}
        </button>
        <div class="dr-menu" data-menu="sort" hidden>
          ${SORT_OPTIONS.map(option => `
            <button class="dr-menu-item${driveState.sort === option.id ? ' is-active' : ''}"
                    data-sort="${option.id}">${esc(option.label)}</button>`).join('')}
        </div>
      </div>
      <button class="dr-icon-btn" data-action="toggle-layout"
              title="${driveState.layout === 'list' ? 'Grid view' : 'List view'}">
        ${icon(driveState.layout === 'list' ? 'gridView' : 'listView', { size: 20 })}
      </button>
      <button class="dr-icon-btn" data-action="refresh" title="Refresh">${icon('refresh', { size: 20 })}</button>
      <button class="dr-icon-btn${driveState.detailsOpen ? ' is-on' : ''}" data-action="toggle-details"
              title="View details">${icon('infoOutline', { size: 20 })}</button>
    </div>`;
}

// --- Rows and cards ---------------------------------------------------------

function ownerLabel(file) {
  if (!file.owner) return '—';
  return file.ownedByMe ? 'me' : (file.owner.name || file.owner.email);
}

function fileIcon(file, size) {
  const type = fileType(file.mimeType);
  return `<span class="dr-file-icon" style="color:${type.color}">${icon(type.icon, { size })}</span>`;
}

function listRow(file, index) {
  const selected = isSelected(file.id);
  return `
    <div class="dr-row${selected ? ' is-selected' : ''}" role="row" tabindex="-1"
         data-file-id="${esc(file.id)}" data-index="${index}"
         data-is-folder="${file.isFolder}" draggable="true"
         ${file.isFolder ? 'data-drop-target="true"' : ''}>
      <div class="dr-cell dr-cell-name">
        ${fileIcon(file, 20)}
        <span class="dr-name" title="${esc(file.name)}">${esc(file.name)}</span>
        ${file.starred ? `<span class="dr-star-mark" title="Starred">${icon('star', { size: 16 })}</span>` : ''}
        ${file.shared ? `<span class="dr-shared-mark" title="Shared">${icon('people', { size: 16 })}</span>` : ''}
      </div>
      <div class="dr-cell dr-cell-owner">${esc(ownerLabel(file))}</div>
      <div class="dr-cell dr-cell-modified">${esc(formatDriveDate(file.modifiedTime))}</div>
      <div class="dr-cell dr-cell-size">${file.isFolder ? '—' : esc(formatFileSize(file.size))}</div>
      <div class="dr-cell dr-cell-actions">
        <button class="dr-icon-btn dr-row-action" data-action="row-menu" title="More actions">
          ${icon('moreVert', { size: 20 })}
        </button>
      </div>
    </div>`;
}

function gridCard(file, index) {
  const selected = isSelected(file.id);
  const type = fileType(file.mimeType);
  const thumb = file.thumbnailLink && !file.isFolder
    ? `<img class="dr-card-thumb" src="${esc(file.thumbnailLink)}" alt="" loading="lazy"
            referrerpolicy="no-referrer">`
    : `<span class="dr-card-glyph" style="color:${type.color}">${icon(type.icon, { size: 48 })}</span>`;

  return `
    <div class="dr-card${selected ? ' is-selected' : ''}${file.isFolder ? ' is-folder' : ''}"
         role="gridcell" tabindex="-1" data-file-id="${esc(file.id)}" data-index="${index}"
         data-is-folder="${file.isFolder}" draggable="true"
         ${file.isFolder ? 'data-drop-target="true"' : ''}>
      <div class="dr-card-head">
        ${fileIcon(file, 18)}
        <span class="dr-card-name" title="${esc(file.name)}">${esc(file.name)}</span>
        ${file.starred ? `<span class="dr-star-mark">${icon('star', { size: 14 })}</span>` : ''}
        <button class="dr-icon-btn dr-row-action" data-action="row-menu" title="More actions">
          ${icon('moreVert', { size: 18 })}
        </button>
      </div>
      <div class="dr-card-body">${thumb}</div>
    </div>`;
}

// --- Context menu -----------------------------------------------------------

export function contextMenuMarkup(file) {
  const inTrash = driveState.view === 'trash';
  const canShare = file.capabilities.canShare !== false;
  const item = (action, iconName, label, extra = '') =>
    `<button class="dr-menu-item" data-menu-action="${action}" ${extra}>
       ${icon(iconName, { size: 18 })}<span>${esc(label)}</span>
     </button>`;

  if (inTrash) {
    return item('restore', 'restore', 'Restore')
      + item('delete', 'delete', 'Delete forever');
  }

  // Open and Preview are deliberately separate: Open gives the full in-app
  // surface (an editor for Docs and Sheets), Preview is a quick look.
  return item('open', file.isFolder ? 'folder' : 'openInFull', 'Open')
    + (file.isFolder ? '' : item('preview', 'visibility', 'Preview'))
    + (canShare ? item('share', 'personAdd', 'Share') : '')
    + (file.isFolder ? '' : item('download', 'download', 'Download'))
    + '<div class="dr-menu-sep"></div>'
    + item('rename', 'edit', 'Rename')
    + (file.isFolder ? '' : item('copy', 'contentCopy', 'Make a copy'))
    + item('star', file.starred ? 'star' : 'starOutline', file.starred ? 'Remove star' : 'Add star')
    + item('details', 'infoOutline', 'File details')
    + (file.webViewLink ? item('open-google', 'openInNew', 'Open in Google Drive') : '')
    + '<div class="dr-menu-sep"></div>'
    + item('trash', 'delete', 'Move to trash');
}

// --- Empty / loading --------------------------------------------------------

function emptyState() {
  if (driveState.search) {
    return `<div class="dr-empty">
      ${icon('search', { size: 48 })}
      <h3>No results found</h3>
      <p>No files or folders matched “${esc(driveState.search)}”.</p>
    </div>`;
  }
  const [title, body] = EMPTY_COPY[driveState.view] || EMPTY_COPY.mydrive;
  return `<div class="dr-empty">
    ${icon('driveLogo', { size: 48 })}
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
  </div>`;
}

function listHeader() {
  if (driveState.layout !== 'list') return '';
  return `
    <div class="dr-head-row" role="row">
      <div class="dr-cell dr-cell-name">Name</div>
      <div class="dr-cell dr-cell-owner">Owner</div>
      <div class="dr-cell dr-cell-modified">
        ${driveState.view === 'recent' ? 'Last opened' : 'Last modified'}
      </div>
      <div class="dr-cell dr-cell-size">File size</div>
      <div class="dr-cell dr-cell-actions"></div>
    </div>`;
}

// --- Entry point ------------------------------------------------------------

export function renderDriveList({ toolbarEl, listEl }) {
  toolbarEl.innerHTML = toolbar();

  if (driveState.loading) {
    listEl.innerHTML = '<div class="dr-progress" role="progressbar"></div>';
    return;
  }

  if (driveState.error) {
    listEl.innerHTML = `<div class="dr-empty dr-empty-error">
      ${icon('report', { size: 48 })}
      <h3>Could not load Drive</h3>
      <p>${esc(driveState.error)}</p>
      <button class="dr-btn" data-action="refresh">Try again</button>
    </div>`;
    return;
  }

  if (!driveState.files.length) {
    listEl.innerHTML = emptyState();
    return;
  }

  const byDate = DATE_SORTS.includes(driveState.sort);
  const folders = driveState.files.filter(f => f.isFolder);
  const files = driveState.files.filter(f => !f.isFolder);
  let index = -1;

  if (driveState.layout === 'grid') {
    const grid = items => `<div class="dr-grid" role="grid">${
      items.map(f => gridCard(f, ++index)).join('')
    }</div>`;
    const section = (title, items) => items.length
      ? `<div class="dr-group-title">${esc(title)}</div>${grid(items)}`
      : '';

    // The server already returned everything in date order; keep that order
    // intact rather than re-grouping it into Folders / Files sections.
    listEl.innerHTML = byDate
      ? grid(driveState.files)
      : section('Folders', folders) + section('Files', files);
  } else {
    const rows = byDate ? driveState.files : [...folders, ...files];
    listEl.innerHTML = listHeader()
      + `<div class="dr-rows" role="rowgroup">${rows.map(f => listRow(f, ++index)).join('')}</div>`;
  }

  if (driveState.nextPageToken) {
    listEl.insertAdjacentHTML('beforeend',
      '<div class="dr-more"><button class="dr-btn" data-action="load-more">Load more</button></div>');
  }
}

export { VIEW_TITLES, SORT_OPTIONS };
