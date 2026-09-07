// The open conversation: stacked messages, expandable, with attachment chips.

import { icon } from '../icons.js';
import { attachmentUrl } from '../api.js';
import {
  esc, parseAddress, parseAddressList, displayName, initials,
  formatFullDate, formatListDate, relativeDate, formatBytes, textToHtml
} from '../util.js';
import { state } from '../state.js';

// Messages the user has expanded this session, keyed by message id.
const expanded = new Set();

function isExpandable(messages) {
  return messages.length > 1;
}

function avatar(from) {
  const { name } = parseAddress(from);
  const letter = initials(from);
  // Deterministic hue so the same sender keeps the same colour.
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `<span class="gm-avatar" style="background:hsl(${hash},45%,45%)" aria-hidden="true">${esc(letter)}</span>`;
}

function recipientLine(msg) {
  const me = state.profile && state.profile.emailAddress;
  const recipients = parseAddressList(msg.headers.to);
  if (!recipients.length) return 'to me';

  const labels = recipients.map(r => (me && r.email.toLowerCase() === me.toLowerCase() ? 'me' : (r.name || r.email)));
  const cc = parseAddressList(msg.headers.cc);
  const shown = labels.slice(0, 3).join(', ');
  const extra = labels.length > 3 ? `, +${labels.length - 3}` : '';
  const ccNote = cc.length ? `, cc: ${esc(cc.map(c => c.name || c.email).slice(0, 2).join(', '))}` : '';
  return `to ${esc(shown)}${extra}${ccNote}`;
}

function attachmentChips(msg) {
  if (!msg.attachments.length) return '';
  return `
    <div class="gm-attachments">
      <div class="gm-attachments-head">
        ${icon('attach', { size: 16 })}
        <span>${msg.attachments.length} attachment${msg.attachments.length > 1 ? 's' : ''}</span>
      </div>
      <div class="gm-attachment-grid">
        ${msg.attachments.map(att => {
          const href = attachmentUrl(msg.id, att, false);
          const isImage = (att.mimeType || '').startsWith('image/');
          const preview = isImage
            ? `<img src="${esc(attachmentUrl(msg.id, att, true))}" alt="" loading="lazy">`
            : `<span class="gm-attachment-ext">${esc((att.filename.split('.').pop() || 'file').slice(0, 4).toUpperCase())}</span>`;
          return `
            <a class="gm-attachment" href="${esc(href)}" download="${esc(att.filename)}"
               title="${esc(att.filename)} — ${esc(formatBytes(att.size))}">
              <span class="gm-attachment-preview">${preview}</span>
              <span class="gm-attachment-meta">
                <span class="gm-attachment-name">${esc(att.filename)}</span>
                <span class="gm-attachment-size">${esc(formatBytes(att.size))}</span>
              </span>
              <span class="gm-attachment-download">${icon('download', { size: 18 })}</span>
            </a>`;
        }).join('')}
      </div>
    </div>`;
}

function messageBlock(msg, { open }) {
  const { name, email } = parseAddress(msg.headers.from);
  const collapsed = !open;

  return `
    <article class="gm-message${collapsed ? ' is-collapsed' : ''}" data-message-id="${esc(msg.id)}">
      <header class="gm-message-head" data-action="toggle-message">
        ${avatar(msg.headers.from)}
        <div class="gm-message-who">
          <div class="gm-message-line">
            <span class="gm-message-name">${esc(name || email)}</span>
            <span class="gm-message-email">&lt;${esc(email)}&gt;</span>
          </div>
          <div class="gm-message-to">${recipientLine(msg)}</div>
        </div>
        <div class="gm-message-preview">${esc(msg.snippet)}</div>
        <div class="gm-message-meta">
          ${msg.attachments.length ? icon('attach', { size: 16 }) : ''}
          <span class="gm-message-date" title="${esc(formatFullDate(msg.internalDate))}">
            ${esc(collapsed ? formatListDate(msg.internalDate) : formatFullDate(msg.internalDate))}
          </span>
          <span class="gm-message-relative">${esc(relativeDate(msg.internalDate))}</span>
          <button class="gm-icon-btn gm-message-star${msg.starred ? ' is-on' : ''}"
                  data-action="star-message" aria-label="Star">
            ${icon(msg.starred ? 'star' : 'starOutline', { size: 18 })}
          </button>
          <button class="gm-icon-btn" data-action="reply-message" aria-label="Reply">
            ${icon('reply', { size: 18 })}
          </button>
        </div>
      </header>
      <div class="gm-message-body">
        <iframe class="gm-message-frame" title="Message body"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
        ${attachmentChips(msg)}
        <div class="gm-message-actions">
          <button class="gm-btn gm-btn-outline" data-action="reply">
            ${icon('reply', { size: 18 })}<span>Reply</span>
          </button>
          <button class="gm-btn gm-btn-outline" data-action="reply-all">
            ${icon('replyAll', { size: 18 })}<span>Reply all</span>
          </button>
          <button class="gm-btn gm-btn-outline" data-action="forward">
            ${icon('forward', { size: 18 })}<span>Forward</span>
          </button>
        </div>
      </div>
    </article>`;
}

const FRAME_STYLES = `
  <style>
    html,body{margin:0;padding:0}
    body{font-family:Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.5;
         color:#202124;word-wrap:break-word;overflow-wrap:break-word}
    img{max-width:100%;height:auto}
    table{max-width:100%}
    a{color:#1a73e8}
    blockquote.gmail_quote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368}
    pre{white-space:pre-wrap;word-wrap:break-word}
  </style>`;

/** Write a message body into its sandboxed frame and size the frame to fit. */
function hydrateFrame(frame, msg) {
  const body = msg.body.html || textToHtml(msg.body.text || msg.snippet);
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">`
    + `<base target="_blank">${FRAME_STYLES}</head><body>${body}</body></html>`;

  const resize = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      frame.style.height = Math.max(doc.body.scrollHeight, 20) + 'px';
    } catch (e) {
      frame.style.height = '400px';
    }
  };

  frame.addEventListener('load', () => {
    resize();
    // Remote images settle after load; re-measure once they do.
    try {
      frame.contentDocument.querySelectorAll('img').forEach(img => {
        if (!img.complete) img.addEventListener('load', resize, { once: true });
      });
    } catch (e) { /* cross-origin body, keep the initial height */ }
    setTimeout(resize, 300);
  });
}

export function renderThread(container) {
  const thread = state.openThread;

  if (state.threadLoading || !thread) {
    container.innerHTML = `
      <div class="gm-thread-bar">
        <button class="gm-icon-btn" data-action="back" title="Back">${icon('chevronLeft')}</button>
      </div>
      <div class="gm-progress" role="progressbar"></div>`;
    return;
  }

  const messages = thread.messages;
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  const expandable = isExpandable(messages);

  container.innerHTML = `
    <div class="gm-thread-bar">
      <button class="gm-icon-btn" data-action="back" title="Back to list">${icon('chevronLeft')}</button>
      <span class="gm-toolbar-divider"></span>
      ${state.view === 'trash'
        ? `<button class="gm-icon-btn" data-action="untrash" title="Move to inbox">${icon('inbox')}</button>`
        : `<button class="gm-icon-btn" data-action="archive" title="Archive">${icon('archive')}</button>`}
      <button class="gm-icon-btn" data-action="spam" title="Report spam">${icon('report')}</button>
      <button class="gm-icon-btn" data-action="trash" title="Delete">${icon('delete')}</button>
      <span class="gm-toolbar-divider"></span>
      <button class="gm-icon-btn" data-action="unread" title="Mark as unread">${icon('markUnread')}</button>
      <button class="gm-icon-btn" data-action="print" title="Print">${icon('print')}</button>
    </div>

    <div class="gm-thread-scroll">
      <div class="gm-thread-head">
        <h2 class="gm-thread-subject">${esc(thread.subject || '(no subject)')}</h2>
        <div class="gm-thread-head-right">
          ${messages.length > 1 ? `<span class="gm-thread-count">${messages.length}</span>` : ''}
          <button class="gm-icon-btn" data-action="print-thread" title="Print all">${icon('print')}</button>
        </div>
      </div>

      ${expandable && messages.length > 2 ? `
        <button class="gm-expand-all" data-action="expand-all">
          ${icon('moreHoriz', { size: 18 })}
          <span>Show all ${messages.length} messages</span>
        </button>` : ''}

      <div class="gm-messages">
        ${messages.map(msg => messageBlock(msg, {
          open: !expandable || msg.id === lastId || expanded.has(msg.id) || msg.unread
        })).join('')}
      </div>

      <div class="gm-thread-footer">
        <button class="gm-btn gm-btn-outline" data-action="reply" data-message-id="${esc(lastId || '')}">
          ${icon('reply', { size: 18 })}<span>Reply</span>
        </button>
        <button class="gm-btn gm-btn-outline" data-action="reply-all" data-message-id="${esc(lastId || '')}">
          ${icon('replyAll', { size: 18 })}<span>Reply all</span>
        </button>
        <button class="gm-btn gm-btn-outline" data-action="forward" data-message-id="${esc(lastId || '')}">
          ${icon('forward', { size: 18 })}<span>Forward</span>
        </button>
      </div>
    </div>`;

  // Bodies are written after the markup lands so each frame exists first.
  container.querySelectorAll('.gm-message').forEach(node => {
    if (node.classList.contains('is-collapsed')) return;
    const msg = messages.find(m => m.id === node.dataset.messageId);
    const frame = node.querySelector('.gm-message-frame');
    if (msg && frame) hydrateFrame(frame, msg);
  });
}

/** Expand a collapsed message in place, loading its body on demand. */
export function expandMessage(container, messageId) {
  const thread = state.openThread;
  if (!thread) return;
  const node = container.querySelector(`.gm-message[data-message-id="${CSS.escape(messageId)}"]`);
  if (!node) return;

  const wasCollapsed = node.classList.contains('is-collapsed');
  node.classList.toggle('is-collapsed');

  if (wasCollapsed) {
    expanded.add(messageId);
    const msg = thread.messages.find(m => m.id === messageId);
    const frame = node.querySelector('.gm-message-frame');
    if (msg && frame && !frame.srcdoc) hydrateFrame(frame, msg);
  } else {
    expanded.delete(messageId);
  }
}

export function expandAll(container) {
  const thread = state.openThread;
  if (!thread) return;
  thread.messages.forEach(msg => expanded.add(msg.id));
  renderThread(container);
}

export function resetExpanded() {
  expanded.clear();
}

/** Open the browser print dialog with just the conversation. */
export function printThread() {
  const thread = state.openThread;
  if (!thread) return;

  const html = thread.messages.map(msg => {
    const { name, email } = parseAddress(msg.headers.from);
    return `<div style="margin:0 0 24px;padding:0 0 24px;border-bottom:1px solid #ddd">
      <div style="font-size:13px;color:#5f6368">
        <b style="color:#202124">${esc(name || email)}</b> &lt;${esc(email)}&gt;<br>
        ${esc(formatFullDate(msg.internalDate))}<br>
        ${recipientLine(msg)}
      </div>
      <div style="margin-top:12px">${msg.body.html || textToHtml(msg.body.text || msg.snippet)}</div>
    </div>`;
  }).join('');

  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>${esc(thread.subject || 'Conversation')}</title>`
    + `<style>body{font-family:Roboto,Arial,sans-serif;font-size:13px;padding:24px}`
    + `img{max-width:100%}</style></head><body>`
    + `<h2 style="font-size:20px;font-weight:400">${esc(thread.subject || '(no subject)')}</h2>`
    + `${html}</body></html>`;

  frame.addEventListener('load', () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  });
}

export { displayName };
