// The thread list: toolbar, inbox category tabs, rows, pagination.

import { icon } from '../icons.js';
import { esc, displayName, formatListDate, formatCount } from '../util.js';
import { state, isSelected } from '../state.js';

const PAGE_SIZE = 50;

const CATEGORIES = [
  { id: 'primary', label: 'Primary', iconName: 'inbox' },
  { id: 'social', label: 'Social', iconName: 'people' },
  { id: 'promotions', label: 'Promotions', iconName: 'localOffer' },
  { id: 'updates', label: 'Updates', iconName: 'infoOutline' },
  { id: 'forums', label: 'Forums', iconName: 'formatQuote' }
];

const EMPTY_COPY = {
  inbox: ['Your inbox is empty', 'Nothing here. Enjoy the quiet.'],
  starred: ['No starred conversations', 'Stars let you give a conversation a special status.'],
  important: ['Nothing marked important', 'Gmail flags conversations it predicts are important.'],
  sent: ['No sent mail', 'Messages you send will appear here.'],
  drafts: ['No drafts', 'Messages you have not sent yet are saved here.'],
  trash: ['Trash is empty', 'Deleted conversations land here before they are removed.'],
  spam: ['No spam', 'Nothing has been flagged as spam.'],
  all: ['No mail', 'This account has no messages.']
};

/** "Sarah", "Sarah, me", "Sarah, Ben 3" — Gmail's sender column. */
function senderSummary(thread) {
  const names = [];
  const seen = new Set();
  thread.participants.forEach(raw => {
    const name = displayName(raw);
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  });

  let label;
  if (!names.length) label = '(unknown)';
  else if (names.length <= 2) label = names.join(', ');
  else label = `${names[0]}, .., ${names[names.length - 1]}`;

  return thread.messageCount > 1
    ? `${esc(label)} <span class="gm-row-count">${thread.messageCount}</span>`
    : esc(label);
}

function rowLabels(thread) {
  if (state.view !== 'all' && !state.search) return '';
  const chips = [];
  if (thread.labelIds.includes('INBOX')) chips.push('Inbox');
  if (thread.labelIds.includes('SENT')) chips.push('Sent');
  if (thread.labelIds.includes('DRAFT')) chips.push('Draft');
  if (thread.labelIds.includes('SPAM')) chips.push('Spam');
  if (thread.labelIds.includes('TRASH')) chips.push('Trash');
  return chips.map(name => `<span class="gm-row-chip">${esc(name)}</span>`).join('');
}

function threadRow(thread, index) {
  const selected = isSelected(thread.id);
  const classes = [
    'gm-row',
    thread.unread ? 'is-unread' : 'is-read',
    selected ? 'is-selected' : '',
    state.cursorIndex === index ? 'is-cursor' : ''
  ].filter(Boolean).join(' ');

  return `
    <div class="${classes}" data-thread-id="${esc(thread.id)}" data-index="${index}"
         data-history-id="${esc(thread.historyId || '')}" role="row" tabindex="-1">
      <button class="gm-row-check" data-action="select" role="checkbox"
              aria-checked="${selected}" aria-label="Select conversation">
        ${icon(selected ? 'checkboxChecked' : 'checkboxBlank')}
      </button>
      <button class="gm-row-star${thread.starred ? ' is-on' : ''}" data-action="star"
              aria-label="${thread.starred ? 'Remove star' : 'Add star'}">
        ${icon(thread.starred ? 'star' : 'starOutline')}
      </button>
      <span class="gm-row-sender">${senderSummary(thread)}</span>
      <span class="gm-row-body">
        ${rowLabels(thread)}
        ${state.view === 'drafts' || thread.isDraft ? '<span class="gm-row-draft">Draft</span>' : ''}
        <span class="gm-row-subject">${esc(thread.subject || '(no subject)')}</span>
        <span class="gm-row-snippet">${thread.snippet ? '&nbsp;&ndash;&nbsp;' + esc(thread.snippet) : ''}</span>
      </span>
      <span class="gm-row-attach">${thread.hasAttachments ? icon('attach', { size: 16 }) : ''}</span>
      <span class="gm-row-date" title="${esc(new Date(thread.date || 0).toString())}">
        ${esc(formatListDate(thread.date))}
      </span>
      <span class="gm-row-actions">
        ${state.view === 'trash'
          ? `<button class="gm-icon-btn" data-action="untrash" title="Move to inbox">${icon('inbox')}</button>`
          : `<button class="gm-icon-btn" data-action="archive" title="Archive">${icon('archive')}</button>`}
        <button class="gm-icon-btn" data-action="trash" title="Delete">${icon('delete')}</button>
        <button class="gm-icon-btn" data-action="toggle-read"
                title="${thread.unread ? 'Mark as read' : 'Mark as unread'}">
          ${icon(thread.unread ? 'markRead' : 'markUnread')}
        </button>
      </span>
    </div>`;
}

function draftRow(draft, index) {
  const msg = draft.message;
  const to = msg.headers.to ? displayName(msg.headers.to) : '(no recipient)';
  return `
    <div class="gm-row is-read" data-draft-id="${esc(draft.id)}" data-index="${index}" role="row" tabindex="-1">
      <span class="gm-row-check is-disabled">${icon('checkboxBlank')}</span>
      <span class="gm-row-star"></span>
      <span class="gm-row-sender"><span class="gm-row-draft">Draft</span> ${esc(to)}</span>
      <span class="gm-row-body">
        <span class="gm-row-subject">${esc(msg.headers.subject || '(no subject)')}</span>
        <span class="gm-row-snippet">${msg.snippet ? '&nbsp;&ndash;&nbsp;' + esc(msg.snippet) : ''}</span>
      </span>
      <span class="gm-row-attach">${msg.attachments.length ? icon('attach', { size: 16 }) : ''}</span>
      <span class="gm-row-date">${esc(formatListDate(msg.internalDate))}</span>
      <span class="gm-row-actions">
        <button class="gm-icon-btn" data-action="discard-draft" title="Discard draft">${icon('delete')}</button>
      </span>
    </div>`;
}

function toolbar() {
  const count = state.selected.size;
  const total = state.resultSizeEstimate;
  const rowCount = state.view === 'drafts' ? state.drafts.length : state.threads.length;
  const start = rowCount ? state.pageIndex * PAGE_SIZE + 1 : 0;
  const end = state.pageIndex * PAGE_SIZE + rowCount;
  const allSelected = count > 0 && count === state.threads.length;

  const selectionActions = count ? `
    <span class="gm-toolbar-divider"></span>
    ${state.view === 'trash'
      ? `<button class="gm-icon-btn" data-action="bulk-untrash" title="Move to inbox">${icon('inbox')}</button>`
      : `<button class="gm-icon-btn" data-action="bulk-archive" title="Archive">${icon('archive')}</button>`}
    <button class="gm-icon-btn" data-action="bulk-spam" title="Report spam">${icon('report')}</button>
    <button class="gm-icon-btn" data-action="bulk-trash" title="Delete">${icon('delete')}</button>
    <span class="gm-toolbar-divider"></span>
    <button class="gm-icon-btn" data-action="bulk-read" title="Mark as read">${icon('markRead')}</button>
    <button class="gm-icon-btn" data-action="bulk-unread" title="Mark as unread">${icon('markUnread')}</button>
    ${state.view === 'trash'
      ? `<button class="gm-icon-btn" data-action="bulk-delete" title="Delete forever">${icon('report')}</button>`
      : ''}
  ` : '';

  return `
    <div class="gm-toolbar-left">
      <button class="gm-icon-btn gm-select-all" data-action="select-all"
              role="checkbox" aria-checked="${allSelected}" title="Select">
        ${icon(count ? 'checkboxChecked' : 'checkboxBlank')}
      </button>
      <button class="gm-icon-btn" data-action="refresh" title="Refresh">${icon('refresh')}</button>
      ${selectionActions}
      ${count ? `<span class="gm-selection-count">${count} selected</span>` : ''}
    </div>
    <div class="gm-toolbar-right">
      <span class="gm-range">${rowCount ? `${formatCount(start)}&ndash;${formatCount(end)}` : '0'}${
        total ? ` of ${formatCount(total)}` : ''
      }</span>
      <button class="gm-icon-btn" data-action="prev-page" title="Newer"
              ${state.pageIndex === 0 ? 'disabled' : ''}>${icon('chevronLeft')}</button>
      <button class="gm-icon-btn" data-action="next-page" title="Older"
              ${state.nextPageToken ? '' : 'disabled'}>${icon('chevronRight')}</button>
    </div>`;
}

function categoryTabs() {
  if (state.view !== 'inbox' || state.search || state.label) return '';
  return `<div class="gm-tabs" role="tablist">
    ${CATEGORIES.map(cat => `
      <button class="gm-tab${state.category === cat.id ? ' is-active' : ''}"
              data-category="${cat.id}" role="tab"
              aria-selected="${state.category === cat.id}">
        ${icon(cat.iconName, { size: 20 })}<span>${esc(cat.label)}</span>
      </button>`).join('')}
  </div>`;
}

function emptyState() {
  const [title, body] = EMPTY_COPY[state.view] || ['No conversations', ''];
  if (state.search) {
    return `<div class="gm-empty">
      ${icon('search', { size: 48 })}
      <h3>No messages matched your search</h3>
      <p>Try a different term, or check the spelling.</p>
    </div>`;
  }
  return `<div class="gm-empty">
    ${icon('inbox', { size: 48 })}
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
  </div>`;
}

export function renderList({ toolbarEl, listEl }) {
  toolbarEl.innerHTML = toolbar();

  if (state.loading) {
    listEl.innerHTML = categoryTabs() + '<div class="gm-progress" role="progressbar"></div>';
    return;
  }

  if (state.error) {
    listEl.innerHTML = `<div class="gm-empty gm-empty-error">
      ${icon('report', { size: 48 })}
      <h3>Could not load mail</h3>
      <p>${esc(state.error)}</p>
      <button class="gm-btn" data-action="refresh">Try again</button>
    </div>`;
    return;
  }

  const rows = state.view === 'drafts'
    ? state.drafts.map(draftRow).join('')
    : state.threads.map(threadRow).join('');

  const isEmpty = state.view === 'drafts' ? !state.drafts.length : !state.threads.length;

  listEl.innerHTML = categoryTabs()
    + (isEmpty ? emptyState() : `<div class="gm-rows" role="grid">${rows}</div>`);
}

export { PAGE_SIZE, CATEGORIES };
