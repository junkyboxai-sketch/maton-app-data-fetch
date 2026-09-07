// Gmail's compose dock: stacked windows, rich-text body, attachments, autosave.

import { icon } from '../icons.js';
import { api, attachmentUrl } from '../api.js';
import {
  esc, formatBytes, htmlToText, debounce, parseAddress, parseAddressList, arrayBufferToBase64
} from '../util.js';
import { state } from '../state.js';
import { toast } from '../actions.js';
import {
  buildRaw, fileToAttachment, quoteMessage, forwardHeader,
  prefixSubject, MAX_ATTACHMENT_BYTES
} from '../mime.js';

const AUTOSAVE_DELAY = 2500;
const MAX_WINDOWS = 3;

let dock = null;
let nextId = 1;

const FORMAT_BUTTONS = [
  { command: 'bold', iconName: 'bold', title: 'Bold (Ctrl+B)' },
  { command: 'italic', iconName: 'italic', title: 'Italic (Ctrl+I)' },
  { command: 'underline', iconName: 'underline', title: 'Underline (Ctrl+U)' },
  { command: 'strikeThrough', iconName: 'strikethrough', title: 'Strikethrough' },
  { command: 'insertUnorderedList', iconName: 'listBulleted', title: 'Bulleted list' },
  { command: 'formatBlock', value: 'blockquote', iconName: 'formatQuote', title: 'Quote' },
  { command: 'createLink', iconName: 'link', title: 'Insert link' }
];

export function initComposeDock(element) {
  dock = element;
  dock.addEventListener('click', onDockClick);
  dock.addEventListener('input', onDockInput);
  dock.addEventListener('change', onDockChange);
  dock.addEventListener('keydown', onDockKeydown);

  // A composer with unsaved text should not vanish silently on reload.
  window.addEventListener('beforeunload', event => {
    if (state.composers.some(c => c.dirty)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function find(id) {
  return state.composers.find(c => c.id === Number(id));
}

function nodeFor(id) {
  return dock.querySelector(`.gm-composer[data-composer-id="${id}"]`);
}

/**
 * Open a composer.
 * @param {object} options
 * @param {'new'|'reply'|'replyAll'|'forward'|'draft'} options.mode
 * @param {object} [options.message]  source message for reply/forward
 * @param {object} [options.draft]    existing draft to resume
 */
export function openComposer(options = {}) {
  const mode = options.mode || 'new';
  const me = (state.profile && state.profile.emailAddress) || '';

  const composer = {
    id: nextId++,
    mode,
    draftId: null,
    threadId: null,
    inReplyTo: '',
    references: '',
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    html: '',
    attachments: [],
    showCc: false,
    showBcc: false,
    minimized: false,
    maximized: false,
    dirty: false,
    saving: false,
    savedAt: null,
    sending: false
  };

  if (mode === 'reply' || mode === 'replyAll') {
    const msg = options.message;
    const from = parseAddress(msg.headers.replyTo || msg.headers.from);
    composer.threadId = msg.threadId;
    composer.inReplyTo = msg.headers.messageId;
    composer.references = msg.headers.references;
    composer.to = from.email;
    composer.subject = prefixSubject(msg.headers.subject, 'Re');
    composer.html = quoteMessage(msg);

    if (mode === 'replyAll') {
      const others = [...parseAddressList(msg.headers.to), ...parseAddressList(msg.headers.cc)]
        .map(a => a.email)
        .filter(email => email && email.toLowerCase() !== me.toLowerCase()
          && email.toLowerCase() !== from.email.toLowerCase());
      composer.cc = Array.from(new Set(others)).join(', ');
      composer.showCc = !!composer.cc;
    }
  } else if (mode === 'forward') {
    const msg = options.message;
    composer.threadId = msg.threadId;
    composer.subject = prefixSubject(msg.headers.subject, 'Fwd');
    composer.html = forwardHeader(msg);
    // Gmail carries the original files along; pull them in the background.
    if (msg.attachments.length) loadForwardedAttachments(composer, msg);
  } else if (mode === 'draft' && options.draft) {
    const msg = options.draft.message;
    composer.draftId = options.draft.id;
    composer.threadId = msg.threadId || null;
    composer.to = msg.headers.to;
    composer.cc = msg.headers.cc;
    composer.bcc = msg.headers.bcc;
    composer.showCc = !!msg.headers.cc;
    composer.showBcc = !!msg.headers.bcc;
    composer.subject = msg.headers.subject;
    composer.html = msg.body.html || esc(msg.body.text || '');
  }

  // Gmail keeps at most three open; the oldest is saved and closed.
  while (state.composers.length >= MAX_WINDOWS) {
    closeComposer(state.composers[0].id, { save: true });
  }

  state.composers.push(composer);
  renderDock();

  const node = nodeFor(composer.id);
  if (node) {
    const focusTarget = composer.to ? node.querySelector('.gm-composer-body') : node.querySelector('[data-field="to"]');
    if (focusTarget) {
      focusTarget.focus();
      if (focusTarget.classList.contains('gm-composer-body')) {
        // Reply bodies start above the quoted text.
        const range = document.createRange();
        range.setStart(focusTarget, 0);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }
  return composer;
}

/**
 * Re-download the source message's attachments so a forward carries them.
 * Anything over the send ceiling is dropped with a notice rather than
 * silently producing a message that cannot be sent.
 */
async function loadForwardedAttachments(composer, msg) {
  let total = 0;
  const skipped = [];

  for (const att of msg.attachments) {
    if (total + att.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(att.filename);
      continue;
    }
    try {
      const response = await fetch(attachmentUrl(msg.id, att, true));
      if (!response.ok) throw new Error('download failed');
      const buffer = await response.arrayBuffer();
      composer.attachments.push({
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        base64: arrayBufferToBase64(buffer)
      });
      total += att.size;
    } catch (e) {
      skipped.push(att.filename);
    }
  }

  if (skipped.length) {
    toast(`Could not attach: ${skipped.join(', ')} (over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit).`);
  }
  if (composer.attachments.length) renderDock();
}

function statusText(composer) {
  if (composer.sending) return 'Sending…';
  if (composer.saving) return 'Saving…';
  if (composer.savedAt) return 'Draft saved';
  return '';
}

function composerMarkup(composer) {
  const classes = [
    'gm-composer',
    composer.minimized ? 'is-minimized' : '',
    composer.maximized ? 'is-maximized' : ''
  ].filter(Boolean).join(' ');

  const title = composer.subject
    || (composer.mode === 'new' ? 'New Message' : 'Message');
  const totalSize = composer.attachments.reduce((sum, a) => sum + a.size, 0);

  return `
    <section class="${classes}" data-composer-id="${composer.id}" aria-label="Compose">
      <header class="gm-composer-head" data-action="toggle-minimize">
        <span class="gm-composer-title">${esc(title)}</span>
        <div class="gm-composer-head-actions">
          <button class="gm-composer-ctl" data-action="minimize"
                  title="${composer.minimized ? 'Expand' : 'Minimize'}">${icon('minimize', { size: 16 })}</button>
          <button class="gm-composer-ctl" data-action="maximize"
                  title="${composer.maximized ? 'Exit full screen' : 'Full screen'}">
            ${icon(composer.maximized ? 'closeFull' : 'openFull', { size: 16 })}
          </button>
          <button class="gm-composer-ctl" data-action="close" title="Save &amp; close">${icon('close', { size: 16 })}</button>
        </div>
      </header>

      <div class="gm-composer-fields">
        <div class="gm-composer-row">
          <input type="text" class="gm-composer-input" data-field="to" placeholder="To"
                 value="${esc(composer.to)}" autocomplete="off" spellcheck="false">
          <div class="gm-composer-toggles">
            ${!composer.showCc ? '<button class="gm-composer-toggle" data-action="show-cc">Cc</button>' : ''}
            ${!composer.showBcc ? '<button class="gm-composer-toggle" data-action="show-bcc">Bcc</button>' : ''}
          </div>
        </div>
        ${composer.showCc ? `
          <div class="gm-composer-row">
            <input type="text" class="gm-composer-input" data-field="cc" placeholder="Cc"
                   value="${esc(composer.cc)}" autocomplete="off" spellcheck="false">
          </div>` : ''}
        ${composer.showBcc ? `
          <div class="gm-composer-row">
            <input type="text" class="gm-composer-input" data-field="bcc" placeholder="Bcc"
                   value="${esc(composer.bcc)}" autocomplete="off" spellcheck="false">
          </div>` : ''}
        <div class="gm-composer-row">
          <input type="text" class="gm-composer-input" data-field="subject" placeholder="Subject"
                 value="${esc(composer.subject)}" autocomplete="off">
        </div>
      </div>

      <div class="gm-composer-body" contenteditable="true" role="textbox"
           aria-multiline="true" aria-label="Message body"></div>

      ${composer.attachments.length ? `
        <div class="gm-composer-attachments">
          ${composer.attachments.map((att, index) => `
            <span class="gm-chip" title="${esc(att.filename)}">
              ${icon('attach', { size: 14 })}
              <span class="gm-chip-name">${esc(att.filename)}</span>
              <span class="gm-chip-size">${esc(formatBytes(att.size))}</span>
              <button class="gm-chip-remove" data-action="remove-attachment"
                      data-index="${index}" aria-label="Remove attachment">${icon('close', { size: 14 })}</button>
            </span>`).join('')}
          <span class="gm-chip-total">${esc(formatBytes(totalSize))} of ${esc(formatBytes(MAX_ATTACHMENT_BYTES))}</span>
        </div>` : ''}

      <footer class="gm-composer-foot">
        <button class="gm-send-btn" data-action="send" ${composer.sending ? 'disabled' : ''}>
          ${composer.sending ? 'Sending…' : 'Send'}
        </button>
        <div class="gm-composer-tools">
          ${FORMAT_BUTTONS.map(btn => `
            <button class="gm-icon-btn gm-tool" data-action="format" data-command="${btn.command}"
                    ${btn.value ? `data-value="${btn.value}"` : ''} title="${esc(btn.title)}">
              ${icon(btn.iconName, { size: 18 })}
            </button>`).join('')}
          <button class="gm-icon-btn gm-tool" data-action="attach" title="Attach files">
            ${icon('attach', { size: 18 })}
          </button>
          <input type="file" class="gm-file-input" data-field="files" multiple hidden>
        </div>
        <div class="gm-composer-status">${esc(statusText(composer))}</div>
        <button class="gm-icon-btn" data-action="discard" title="Discard draft">${icon('delete', { size: 18 })}</button>
      </footer>
    </section>`;
}

/** Re-render the dock, preserving each open body's DOM and caret where possible. */
export function renderDock() {
  if (!dock) return;

  const activeElement = document.activeElement;
  const activeComposerId = activeElement && activeElement.closest
    ? (activeElement.closest('.gm-composer') || {}).dataset?.composerId
    : null;
  const activeField = activeElement && activeElement.dataset ? activeElement.dataset.field : null;
  const selectionStart = activeElement && activeElement.selectionStart;

  dock.innerHTML = state.composers.map(composerMarkup).join('');

  state.composers.forEach(composer => {
    const node = nodeFor(composer.id);
    if (!node) return;
    const body = node.querySelector('.gm-composer-body');
    if (body) body.innerHTML = composer.html;
  });

  if (activeComposerId && activeField) {
    const restored = dock.querySelector(
      `.gm-composer[data-composer-id="${activeComposerId}"] [data-field="${activeField}"]`
    );
    if (restored) {
      restored.focus();
      if (selectionStart !== null && selectionStart !== undefined && restored.setSelectionRange) {
        restored.setSelectionRange(selectionStart, selectionStart);
      }
    }
  }
}

// --- Persistence ------------------------------------------------------------

function toRaw(composer) {
  const body = nodeFor(composer.id) ? nodeFor(composer.id).querySelector('.gm-composer-body') : null;
  const html = body ? body.innerHTML : composer.html;
  return buildRaw({
    to: composer.to,
    cc: composer.cc,
    bcc: composer.bcc,
    subject: composer.subject,
    html,
    text: htmlToText(html),
    attachments: composer.attachments,
    inReplyTo: composer.inReplyTo,
    references: composer.references
  });
}

function syncFromDom(composer) {
  const node = nodeFor(composer.id);
  if (!node) return;
  const body = node.querySelector('.gm-composer-body');
  if (body) composer.html = body.innerHTML;
}

async function saveDraft(composer, { silent = false } = {}) {
  syncFromDom(composer);
  if (!composer.dirty) return;
  // An entirely blank composer is not worth a server round trip.
  if (!composer.to && !composer.subject && !htmlToText(composer.html)) return;

  composer.saving = true;
  if (!silent) updateStatus(composer);

  try {
    const raw = toRaw(composer);
    if (composer.draftId) {
      await api.updateDraft(composer.draftId, raw, composer.threadId);
    } else {
      const created = await api.createDraft(raw, composer.threadId);
      composer.draftId = created.id;
    }
    composer.dirty = false;
    composer.savedAt = Date.now();
  } catch (err) {
    if (!silent) toast(`Draft not saved: ${err.message}`);
  } finally {
    composer.saving = false;
    updateStatus(composer);
  }
}

function updateStatus(composer) {
  const node = nodeFor(composer.id);
  if (!node) return;
  const status = node.querySelector('.gm-composer-status');
  if (status) status.textContent = statusText(composer);
}

const scheduleSave = debounce(composerId => {
  const composer = find(composerId);
  if (composer) saveDraft(composer, { silent: true });
}, AUTOSAVE_DELAY);

export function closeComposer(id, { save = true, discard = false } = {}) {
  const composer = find(id);
  if (!composer) return;

  if (discard && composer.draftId) {
    api.deleteDraft(composer.draftId).catch(() => {});
  } else if (save && composer.dirty) {
    saveDraft(composer, { silent: true });
  }

  state.composers = state.composers.filter(c => c.id !== composer.id);
  renderDock();
  document.dispatchEvent(new CustomEvent('gm:composer-closed', { detail: { discarded: discard } }));
}

async function send(composer) {
  syncFromDom(composer);

  if (!composer.to.trim()) {
    toast('Please specify at least one recipient.');
    return;
  }
  if (!composer.subject.trim() && !confirm('Send this message without a subject?')) return;

  composer.sending = true;
  renderDock();

  try {
    const raw = toRaw(composer);
    if (composer.draftId) {
      await api.updateDraft(composer.draftId, raw, composer.threadId);
      await api.sendDraft(composer.draftId);
    } else {
      await api.send(raw, composer.threadId);
    }
    state.composers = state.composers.filter(c => c.id !== composer.id);
    renderDock();
    toast('Message sent.');
    document.dispatchEvent(new CustomEvent('gm:message-sent'));
  } catch (err) {
    composer.sending = false;
    renderDock();
    toast(`Could not send: ${err.message}`);
  }
}

async function addFiles(composer, fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  let total = composer.attachments.reduce((sum, a) => sum + a.size, 0);
  for (const file of files) {
    if (total + file.size > MAX_ATTACHMENT_BYTES) {
      toast(`${file.name} exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} attachment limit.`);
      continue;
    }
    try {
      composer.attachments.push(await fileToAttachment(file));
      total += file.size;
    } catch (err) {
      toast(err.message);
    }
  }
  composer.dirty = true;
  renderDock();
  scheduleSave(composer.id);
}

// --- Event handling ---------------------------------------------------------

function onDockClick(event) {
  const node = event.target.closest('.gm-composer');
  if (!node) return;
  const composer = find(node.dataset.composerId);
  if (!composer) return;

  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;

  // Clicking the header bar toggles minimise, but its own buttons take priority.
  if (action === 'toggle-minimize' && event.target.closest('.gm-composer-head-actions')) return;

  switch (action) {
    case 'toggle-minimize':
    case 'minimize':
      composer.minimized = !composer.minimized;
      if (!composer.minimized) composer.maximized = composer.maximized && true;
      renderDock();
      break;
    case 'maximize':
      composer.maximized = !composer.maximized;
      composer.minimized = false;
      renderDock();
      break;
    case 'close':
      closeComposer(composer.id, { save: true });
      break;
    case 'discard':
      if (confirm('Discard this draft?')) closeComposer(composer.id, { save: false, discard: true });
      break;
    case 'show-cc':
      composer.showCc = true;
      renderDock();
      break;
    case 'show-bcc':
      composer.showBcc = true;
      renderDock();
      break;
    case 'send':
      send(composer);
      break;
    case 'attach':
      node.querySelector('.gm-file-input').click();
      break;
    case 'remove-attachment':
      composer.attachments.splice(Number(trigger.dataset.index), 1);
      composer.dirty = true;
      renderDock();
      break;
    case 'format': {
      const body = node.querySelector('.gm-composer-body');
      body.focus();
      const command = trigger.dataset.command;
      if (command === 'createLink') {
        const url = prompt('Link URL:', 'https://');
        if (url) document.execCommand('createLink', false, url);
      } else {
        document.execCommand(command, false, trigger.dataset.value || null);
      }
      composer.dirty = true;
      scheduleSave(composer.id);
      break;
    }
    default:
      break;
  }
}

function onDockInput(event) {
  const node = event.target.closest('.gm-composer');
  if (!node) return;
  const composer = find(node.dataset.composerId);
  if (!composer) return;

  const field = event.target.dataset.field;
  if (field && ['to', 'cc', 'bcc', 'subject'].includes(field)) {
    composer[field] = event.target.value;
    if (field === 'subject') {
      const title = node.querySelector('.gm-composer-title');
      if (title) title.textContent = event.target.value || 'New Message';
    }
  } else if (event.target.classList.contains('gm-composer-body')) {
    composer.html = event.target.innerHTML;
  } else {
    return;
  }

  composer.dirty = true;
  composer.savedAt = null;
  updateStatus(composer);
  scheduleSave(composer.id);
}

function onDockChange(event) {
  if (event.target.dataset.field !== 'files') return;
  const node = event.target.closest('.gm-composer');
  const composer = find(node.dataset.composerId);
  if (composer) addFiles(composer, event.target.files);
  event.target.value = '';
}

function onDockKeydown(event) {
  const node = event.target.closest('.gm-composer');
  if (!node) return;
  const composer = find(node.dataset.composerId);
  if (!composer) return;

  // Ctrl/Cmd+Enter sends, Escape minimises — both match Gmail.
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    send(composer);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    composer.minimized = true;
    renderDock();
  }
  event.stopPropagation();
}

export function hasOpenComposers() {
  return state.composers.length > 0;
}
