// Gmail domain helpers: parsing, MIME extraction, thread shaping.

function b64urlToUtf8(data) {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch (e) {
    return '';
  }
}

function headerMap(headers = []) {
  const map = {};
  headers.forEach(h => {
    const name = String(h.name || '').toLowerCase();
    // Multi-valued headers (References, Received) keep the first occurrence.
    if (map[name] === undefined) map[name] = h.value || '';
  });
  return map;
}

// Walks a Gmail payload tree, collecting the best text/html bodies plus every
// attachment (including inline images referenced by cid:).
function walkPayload(part, out) {
  if (!part) return out;
  const mime = part.mimeType || '';
  const filename = part.filename || '';
  const disposition = (headerMap(part.headers)['content-disposition'] || '').toLowerCase();
  const contentId = (headerMap(part.headers)['content-id'] || '').replace(/^<|>$/g, '');
  const isAttachment = !!filename || disposition.startsWith('attachment');

  if (isAttachment && part.body && part.body.attachmentId) {
    out.attachments.push({
      attachmentId: part.body.attachmentId,
      filename: filename || 'attachment',
      mimeType: mime || 'application/octet-stream',
      size: part.body.size || 0,
      contentId: contentId || null,
      inline: !!contentId || disposition.startsWith('inline')
    });
  } else if (mime === 'text/plain' && part.body && part.body.data) {
    out.text += b64urlToUtf8(part.body.data);
  } else if (mime === 'text/html' && part.body && part.body.data) {
    out.html += b64urlToUtf8(part.body.data);
  }

  if (Array.isArray(part.parts)) {
    part.parts.forEach(child => walkPayload(child, out));
  }
  return out;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

// Point cid: references at our own attachment proxy so inline images render.
function rewriteInlineImages(html, messageId, attachments) {
  if (!html) return html;
  let result = html;
  attachments.filter(a => a.contentId).forEach(att => {
    const url = `/api/gmail/messages/${messageId}/attachments/${att.attachmentId}`
      + `?inline=true&mimeType=${encodeURIComponent(att.mimeType)}`
      + `&filename=${encodeURIComponent(att.filename)}`;
    const cid = att.contentId.replace(REGEX_SPECIALS, '\\$&');
    result = result.replace(new RegExp('cid:' + cid, 'gi'), url);
  });
  return result;
}

function parseMessage(msg) {
  const payload = msg.payload || {};
  const h = headerMap(payload.headers);
  const out = walkPayload(payload, { text: '', html: '', attachments: [] });

  // Single-part messages carry their body on the payload itself.
  if (!out.text && !out.html && payload.body && payload.body.data) {
    const raw = b64urlToUtf8(payload.body.data);
    if (payload.mimeType === 'text/html') out.html = raw;
    else out.text = raw;
  }

  const labelIds = msg.labelIds || [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds,
    internalDate: msg.internalDate ? Number(msg.internalDate) : null,
    snippet: msg.snippet || '',
    unread: labelIds.includes('UNREAD'),
    starred: labelIds.includes('STARRED'),
    isDraft: labelIds.includes('DRAFT'),
    sizeEstimate: msg.sizeEstimate || 0,
    headers: {
      from: h.from || '',
      to: h.to || '',
      cc: h.cc || '',
      bcc: h.bcc || '',
      replyTo: h['reply-to'] || '',
      subject: h.subject || '',
      date: h.date || '',
      messageId: h['message-id'] || '',
      references: h.references || '',
      inReplyTo: h['in-reply-to'] || ''
    },
    body: {
      text: out.text,
      html: rewriteInlineImages(out.html, msg.id, out.attachments)
    },
    // Inline images are rendered in the body, so they stay out of the chip row.
    attachments: out.attachments.filter(a => !(a.inline && a.contentId))
  };
}

function payloadHasAttachment(part) {
  if (!part) return false;
  if (part.filename && part.body && part.body.attachmentId) {
    const disposition = (headerMap(part.headers)['content-disposition'] || '').toLowerCase();
    if (!disposition.startsWith('inline')) return true;
  }
  if (Array.isArray(part.parts)) return part.parts.some(payloadHasAttachment);
  return false;
}

// Lightweight shape for the thread list: everything a row needs, nothing more.
function summarizeThread(thread, historyId) {
  const messages = thread.messages || [];
  if (!messages.length) return null;

  const labelIds = new Set();
  const participants = [];
  const seen = new Set();
  let unread = false;
  let starred = false;
  let hasAttachments = false;
  let isDraft = false;

  messages.forEach(msg => {
    (msg.labelIds || []).forEach(l => labelIds.add(l));
    if ((msg.labelIds || []).includes('UNREAD')) unread = true;
    if ((msg.labelIds || []).includes('STARRED')) starred = true;
    if ((msg.labelIds || []).includes('DRAFT')) isDraft = true;

    const from = headerMap((msg.payload || {}).headers).from || '';
    if (from && !seen.has(from)) {
      seen.add(from);
      participants.push(from);
    }
    if (payloadHasAttachment(msg.payload)) hasAttachments = true;
  });

  const last = messages[messages.length - 1];
  const firstHeaders = headerMap((messages[0].payload || {}).headers);

  return {
    id: thread.id,
    historyId: historyId || thread.historyId || null,
    subject: firstHeaders.subject || '',
    snippet: last.snippet || thread.snippet || '',
    participants,
    messageCount: messages.length,
    date: last.internalDate ? Number(last.internalDate) : null,
    labelIds: Array.from(labelIds),
    unread,
    starred,
    hasAttachments,
    isDraft
  };
}

// Gmail's own query strings for the built-in views.
const VIEW_QUERIES = {
  inbox: 'in:inbox',
  starred: 'is:starred',
  important: 'is:important',
  sent: 'in:sent',
  drafts: 'in:drafts',
  trash: 'in:trash',
  spam: 'in:spam',
  all: 'in:anywhere -in:spam -in:trash'
};

function buildQuery({ view, category, search, label }) {
  if (search) return search;
  const parts = [];
  if (label) {
    parts.push('label:' + (/\s/.test(label) ? `"${label}"` : label));
  } else {
    parts.push(VIEW_QUERIES[view] || VIEW_QUERIES.inbox);
  }
  if (view === 'inbox' && category) {
    parts.push(`category:${category}`);
  }
  return parts.join(' ');
}

// Bounded-concurrency map so a 50-thread page does not open 50 sockets at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  parseMessage,
  summarizeThread,
  buildQuery,
  mapLimit,
  headerMap,
  VIEW_QUERIES
};
