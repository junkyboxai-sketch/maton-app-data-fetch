// Gmail's left rail: compose button, system views, expandable label list.

import { icon } from '../icons.js';
import { esc, formatCount } from '../util.js';
import { state } from '../state.js';

const PRIMARY_VIEWS = [
  { view: 'inbox', label: 'Inbox', iconName: 'inbox', countFrom: 'INBOX', bold: true },
  { view: 'starred', label: 'Starred', iconName: 'starOutline' },
  { view: 'important', label: 'Important', iconName: 'label' },
  { view: 'sent', label: 'Sent', iconName: 'send' },
  { view: 'drafts', label: 'Drafts', iconName: 'edit', countFrom: 'DRAFT', bold: true }
];

const MORE_VIEWS = [
  { view: 'all', label: 'All Mail', iconName: 'archive' },
  { view: 'spam', label: 'Spam', iconName: 'report' },
  { view: 'trash', label: 'Trash', iconName: 'delete' }
];

let moreExpanded = false;

function countFor(labelId) {
  const label = state.labels.find(l => l.id === labelId);
  if (!label) return 0;
  // Gmail shows unread for Inbox, total for Drafts.
  return labelId === 'DRAFT' ? label.threadsTotal : label.threadsUnread;
}

function navItem({ view, label, iconName, countFrom, bold }) {
  const active = !state.label && state.view === view && !state.search;
  const count = countFrom ? countFor(countFrom) : 0;
  return `
    <a href="#" class="gm-nav-item${active ? ' is-active' : ''}" data-view="${esc(view)}">
      ${icon(iconName, { size: 20 })}
      <span class="gm-nav-label">${esc(label)}</span>
      ${count ? `<span class="gm-nav-count${bold ? ' is-bold' : ''}">${formatCount(count)}</span>` : ''}
    </a>`;
}

function labelItem(label) {
  const active = state.label === label.name;
  const swatch = label.color && label.color.backgroundColor
    ? `style="color:${esc(label.color.backgroundColor)}"`
    : '';
  return `
    <a href="#" class="gm-nav-item${active ? ' is-active' : ''}" data-label="${esc(label.name)}">
      <span class="gm-nav-icon" ${swatch}>${icon('localOffer', { size: 20 })}</span>
      <span class="gm-nav-label" title="${esc(label.name)}">${esc(label.name)}</span>
      ${label.threadsUnread ? `<span class="gm-nav-count is-bold">${formatCount(label.threadsUnread)}</span>` : ''}
    </a>`;
}

export function renderSidebar(container) {
  const userLabels = state.labels
    .filter(l => l.type === 'user')
    .sort((a, b) => a.name.localeCompare(b.name));

  container.innerHTML = `
    <button class="gm-compose-btn" data-action="compose">
      ${icon('edit', { size: 20 })}<span>Compose</span>
    </button>
    <nav class="gm-nav" aria-label="Mailboxes">
      ${PRIMARY_VIEWS.map(navItem).join('')}
      <a href="#" class="gm-nav-item gm-nav-more" data-action="toggle-more">
        ${icon(moreExpanded ? 'expandMore' : 'chevronRight', { size: 20 })}
        <span class="gm-nav-label">${moreExpanded ? 'Less' : 'More'}</span>
      </a>
      <div class="gm-nav-group"${moreExpanded ? '' : ' hidden'}>
        ${MORE_VIEWS.map(navItem).join('')}
      </div>
      ${userLabels.length ? `
        <div class="gm-nav-heading">Labels</div>
        ${userLabels.map(labelItem).join('')}
      ` : ''}
    </nav>`;
}

/** Wire the rail once; re-renders reuse these delegated handlers. */
export function bindSidebar(container, { onNavigate, onCompose, onRerender }) {
  container.addEventListener('click', event => {
    const target = event.target.closest('[data-view], [data-label], [data-action]');
    if (!target) return;
    event.preventDefault();

    const action = target.dataset.action;
    if (action === 'compose') return onCompose();
    if (action === 'toggle-more') {
      moreExpanded = !moreExpanded;
      return onRerender();
    }
    if (target.dataset.label !== undefined) {
      return onNavigate({ label: target.dataset.label, view: 'label' });
    }
    if (target.dataset.view) {
      return onNavigate({ view: target.dataset.view, label: '' });
    }
  });
}
