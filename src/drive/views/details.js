// The right-hand details panel: preview thumbnail, sharing summary, metadata.

import { icon } from '../../icons.js';
import { esc, initials } from '../../util.js';
import { driveState } from '../state.js';
import { contentUrl } from '../api.js';
import { fileType, formatFileSize, formatFullDate } from '../util.js';

function previewBlock(file) {
  const type = fileType(file.mimeType);

  if (file.thumbnailLink && !file.isFolder) {
    return `<div class="dr-details-preview">
      <img src="${esc(file.thumbnailLink)}" alt="" referrerpolicy="no-referrer" loading="lazy">
    </div>`;
  }
  if (type.kind === 'image') {
    return `<div class="dr-details-preview">
      <img src="${esc(contentUrl(file, true))}" alt="" loading="lazy">
    </div>`;
  }
  return `<div class="dr-details-preview is-glyph" style="color:${type.color}">
    ${icon(type.icon, { size: 64 })}
  </div>`;
}

function person(entry) {
  if (!entry) return '';
  const name = entry.name || entry.email || 'Unknown';
  return `<span class="dr-person">
    <span class="dr-person-avatar">${esc(initials(name))}</span>
    <span class="dr-person-name">${esc(name)}</span>
  </span>`;
}

function row(label, value) {
  if (!value) return '';
  return `<div class="dr-detail-row">
    <dt>${esc(label)}</dt>
    <dd>${value}</dd>
  </div>`;
}

export function renderDetails(container) {
  if (!driveState.detailsOpen) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const file = driveState.detailsFor;

  if (!file) {
    container.innerHTML = `
      <div class="dr-details-head">
        <h3>Details</h3>
        <button class="dr-icon-btn" data-action="close-details" title="Close">${icon('close', { size: 20 })}</button>
      </div>
      <div class="dr-details-empty">
        ${icon('infoOutline', { size: 40 })}
        <p>Select an item to see its details.</p>
      </div>`;
    return;
  }

  const type = fileType(file.mimeType);
  const sharedWith = file.shared
    ? 'Shared — open Share to manage access'
    : (file.ownedByMe ? 'Private — only you' : 'Shared with you');

  container.innerHTML = `
    <div class="dr-details-head">
      <h3 title="${esc(file.name)}">${esc(file.name)}</h3>
      <button class="dr-icon-btn" data-action="close-details" title="Close">${icon('close', { size: 20 })}</button>
    </div>

    ${previewBlock(file)}

    <div class="dr-details-actions">
      <button class="dr-btn dr-btn-primary" data-action="open-file">
        ${icon(file.isFolder ? 'folder' : 'openInFull', { size: 18 })}<span>Open</span>
      </button>
      ${file.isFolder ? '' : `
        <button class="dr-btn" data-action="preview-file">
          ${icon('visibility', { size: 18 })}<span>Preview</span>
        </button>`}
      ${file.capabilities.canShare !== false ? `
        <button class="dr-btn" data-action="share-file">
          ${icon('personAdd', { size: 18 })}<span>Share</span>
        </button>` : ''}
    </div>

    <dl class="dr-details-list">
      ${row('Type', esc(type.label))}
      ${row('Size', file.isFolder ? '—' : esc(formatFileSize(file.size)))}
      ${row('Owner', person(file.owner))}
      ${row('Modified', esc(formatFullDate(file.modifiedTime))
        + (file.modifiedBy ? ` by ${esc(file.modifiedBy.name || file.modifiedBy.email)}` : ''))}
      ${row('Created', esc(formatFullDate(file.createdTime)))}
      ${file.sharedWithMeTime ? row('Shared with me', esc(formatFullDate(file.sharedWithMeTime))) : ''}
      ${row('Access', esc(sharedWith))}
      ${row('Starred', file.starred ? 'Yes' : 'No')}
    </dl>

    ${file.webViewLink ? `
      <div class="dr-details-footer">
        <a class="dr-link" href="${esc(file.webViewLink)}" target="_blank" rel="noopener noreferrer">
          ${icon('openInNew', { size: 16 })}<span>Open in Google Drive</span>
        </a>
      </div>` : ''}`;
}
