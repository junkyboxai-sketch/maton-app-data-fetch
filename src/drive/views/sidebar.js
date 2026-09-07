// Drive's left rail: New button, the five views, and the storage meter.

import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { driveState } from '../state.js';
import { formatFileSize, quotaPercent } from '../util.js';

const VIEWS = [
  { view: 'mydrive', label: 'My Drive', iconName: 'driveLogo' },
  { view: 'shared', label: 'Shared with me', iconName: 'people' },
  { view: 'recent', label: 'Recent', iconName: 'schedule' },
  { view: 'starred', label: 'Starred', iconName: 'starOutline' },
  { view: 'trash', label: 'Trash', iconName: 'delete' }
];

function navItem({ view, label, iconName }) {
  // A folder drilled into from My Drive keeps My Drive highlighted.
  const active = !driveState.search
    && (driveState.view === view || (driveState.view === 'folder' && view === 'mydrive'));
  return `
    <a href="#" class="dr-nav-item${active ? ' is-active' : ''}" data-view="${esc(view)}"
       data-drop-target="false">
      ${icon(iconName, { size: 20 })}
      <span class="dr-nav-label">${esc(label)}</span>
    </a>`;
}

function storageMeter() {
  const quota = driveState.about && driveState.about.storageQuota;
  if (!quota) return '';

  const used = Number(quota.usage || 0);
  const limit = Number(quota.limit || 0);
  const percent = quotaPercent(quota);

  return `
    <div class="dr-storage">
      <div class="dr-storage-head">${icon('cloud', { size: 20 })}<span>Storage</span></div>
      <div class="dr-storage-bar"><div class="dr-storage-fill" style="width:${percent.toFixed(1)}%"></div></div>
      <div class="dr-storage-text">
        ${esc(formatFileSize(used))}${limit ? ` of ${esc(formatFileSize(limit))} used` : ' used'}
      </div>
    </div>`;
}

export function renderDriveSidebar(container) {
  container.innerHTML = `
    <button class="dr-new-btn" data-action="new-folder">
      ${icon('createFolder', { size: 20 })}<span>New folder</span>
    </button>
    <nav class="dr-nav" aria-label="Drive views">
      ${VIEWS.map(navItem).join('')}
    </nav>
    ${storageMeter()}`;
}

export function bindDriveSidebar(container, { onNavigate, onNewFolder }) {
  container.addEventListener('click', event => {
    const target = event.target.closest('[data-view], [data-action]');
    if (!target) return;
    event.preventDefault();

    if (target.dataset.action === 'new-folder') return onNewFolder();
    if (target.dataset.view) return onNavigate({ view: target.dataset.view });
  });
}
