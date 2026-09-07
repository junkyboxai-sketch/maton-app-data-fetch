// Builds RFC 822 messages for Gmail's messages.send / drafts endpoints, which
// accept a single base64url-encoded MIME blob.

import {
  utf8ToBase64, base64ToBase64Url, arrayBufferToBase64, esc, parseAddress, parseAddressList
} from './util.js';

const CRLF = '\r\n';

// Vercel caps a serverless request body at ~4.5 MB and base64 inflates by a
// third, so the practical ceiling for total attachments is a little over 3 MB.
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function isAscii(str) {
  return /^[\x20-\x7E]*$/.test(str);
}

/** RFC 2047 encoded-word, needed for non-ASCII subjects and display names. */
function encodeHeaderValue(value) {
  const text = String(value || '');
  if (isAscii(text)) return text;
  return `=?UTF-8?B?${utf8ToBase64(text)}?=`;
}

/**
 * Encode the display name of each address while leaving the mailbox intact.
 * Splitting is quote-aware, so `"Muller, Jan" <j@x.de>` stays one recipient.
 */
function encodeAddressList(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return parseAddressList(value)
    .map(({ name, email }) => {
      if (!name || name === email) return email;
      return `${encodeHeaderValue(name)} <${email}>`;
    })
    .join(', ');
}

function wrapBase64(base64) {
  return (base64.match(/.{1,76}/g) || []).join(CRLF);
}

// Kept short so the Content-Type header stays inside the 78-column
// line limit RFC 5322 recommends, without needing header folding.
let boundarySeq = 0;
function randomBoundary(prefix) {
  boundarySeq = (boundarySeq + 1) % 1296;
  const unique = Math.random().toString(36).slice(2, 10) + boundarySeq.toString(36).padStart(2, '0');
  return `=_mtn_${prefix}_${unique}`;
}

function textPart(mimeType, content) {
  return [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(utf8ToBase64(content))
  ].join(CRLF);
}

function attachmentPart(attachment) {
  return [
    `Content-Type: ${attachment.mimeType || 'application/octet-stream'}; name="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    wrapBase64(attachment.base64)
  ].join(CRLF);
}

/**
 * @param {object} message
 * @param {string} message.to        comma-separated recipients
 * @param {string} [message.cc]
 * @param {string} [message.bcc]
 * @param {string} [message.from]    omit to let Gmail fill in the account
 * @param {string} message.subject
 * @param {string} message.html      body as HTML
 * @param {string} [message.text]    plain-text alternative
 * @param {Array}  [message.attachments] { filename, mimeType, base64 }
 * @param {string} [message.inReplyTo]   Message-ID being replied to
 * @param {string} [message.references]  existing References header
 * @returns {string} base64url-encoded message
 */
export function buildRaw(message) {
  const attachments = message.attachments || [];
  const altBoundary = randomBoundary('alt');
  const mixedBoundary = randomBoundary('mix');

  const headers = [];
  if (message.from) headers.push(`From: ${encodeAddressList(message.from)}`);
  headers.push(`To: ${encodeAddressList(message.to)}`);
  if (message.cc) headers.push(`Cc: ${encodeAddressList(message.cc)}`);
  if (message.bcc) headers.push(`Bcc: ${encodeAddressList(message.bcc)}`);
  headers.push(`Subject: ${encodeHeaderValue(message.subject || '')}`);
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${message.inReplyTo}`);
    const references = [message.references, message.inReplyTo].filter(Boolean).join(' ');
    headers.push(`References: ${references}`);
  }
  headers.push('MIME-Version: 1.0');

  const alternative = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    textPart('text/plain', message.text || ''),
    `--${altBoundary}`,
    textPart('text/html', message.html || ''),
    `--${altBoundary}--`
  ].join(CRLF);

  let body;
  if (attachments.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    body = [
      '',
      `--${mixedBoundary}`,
      alternative,
      ...attachments.flatMap(att => [`--${mixedBoundary}`, attachmentPart(att)]),
      `--${mixedBoundary}--`
    ].join(CRLF);
  } else {
    body = CRLF + alternative;
  }

  return base64ToBase64Url(utf8ToBase64(headers.join(CRLF) + body));
}

/** Read a File into the { filename, mimeType, base64 } shape buildRaw expects. */
export function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      base64: arrayBufferToBase64(reader.result)
    });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/** Gmail's attribution line plus the quoted original, as HTML. */
export function quoteMessage(msg) {
  const { name, email } = parseAddress(msg.headers.from);
  const when = msg.internalDate
    ? new Date(msg.internalDate).toLocaleString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short',
        day: 'numeric', hour: 'numeric', minute: '2-digit'
      })
    : msg.headers.date;

  const attribution = `On ${esc(when)}, ${esc(name)} &lt;<a href="mailto:${esc(email)}">${esc(email)}</a>&gt; wrote:`;
  const quoted = msg.body.html || `<div style="white-space:pre-wrap">${esc(msg.body.text || msg.snippet)}</div>`;

  return `<br><br><div class="gmail_quote">`
    + `<div dir="ltr" class="gmail_attr">${attribution}</div>`
    + `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">`
    + `${quoted}</blockquote></div>`;
}

/** "Fwd:"-style forwarded header block. */
export function forwardHeader(msg) {
  const rows = [
    ['From', msg.headers.from],
    ['Date', msg.headers.date],
    ['Subject', msg.headers.subject],
    ['To', msg.headers.to]
  ].filter(([, value]) => value);

  const list = rows
    .map(([key, value]) => `<div><b>${key}:</b> ${esc(value)}</div>`)
    .join('');
  const quoted = msg.body.html || `<div style="white-space:pre-wrap">${esc(msg.body.text || msg.snippet)}</div>`;

  return `<br><br><div class="gmail_quote">`
    + `<div class="gmail_attr">---------- Forwarded message ---------</div>`
    + `${list}<br>${quoted}</div>`;
}

/** Prefix a subject once, so "Re: Re: x" never happens. */
export function prefixSubject(subject, prefix) {
  const value = String(subject || '');
  const pattern = new RegExp(`^\\s*${prefix}:\\s*`, 'i');
  return pattern.test(value) ? value : `${prefix}: ${value}`;
}
