// Small shared helpers. No DOM assumptions beyond document.createElement.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Escape a value for interpolation into an innerHTML template.
 * Every piece of Gmail-sourced text goes through this before it hits the DOM.
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

/** Escape for use inside an HTML attribute that is already double-quoted. */
export const attr = esc;

/**
 * Split an RFC 5322 address header into { name, email } parts.
 * Handles `Name <a@b.com>`, `"Last, First" <a@b.com>`, and bare addresses.
 */
export function parseAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) return { name: '', email: '' };

  const angled = value.match(/^(.*?)<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"|"$/g, '').trim();
    const email = angled[2].trim();
    return { name: name || email, email };
  }
  return { name: value, email: value };
}

/** Split a comma-separated address header, respecting quoted display names. */
export function parseAddressList(raw) {
  const value = String(raw || '');
  const out = [];
  let current = '';
  let inQuotes = false;

  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === ',' && !inQuotes) {
      if (current.trim()) out.push(parseAddress(current));
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) out.push(parseAddress(current));
  return out;
}

/** The short name Gmail shows in a list row: first name, or the mailbox. */
export function displayName(raw) {
  const { name, email } = parseAddress(raw);
  if (name && name !== email) return name;
  return email.split('@')[0] || email;
}

export function initials(raw) {
  const { name, email } = parseAddress(raw);
  const source = (name || email || '?').trim();
  return source.charAt(0).toUpperCase() || '?';
}

/**
 * Gmail's list-column date rule: time for today, "MMM d" this year,
 * "M/d/yy" for anything older.
 */
export function formatListDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
}

/** The long form Gmail uses in an open message header. */
export function formatFullDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

/** Relative form for the message header tooltip row, e.g. "3 days ago". */
export function relativeDate(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.round(months / 12)} year${months < 24 ? '' : 's'} ago`;
}

export function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(n) {
  const value = Number(n) || 0;
  if (value >= 1000) return `${Math.floor(value / 1000)},${String(value % 1000).padStart(3, '0')}`;
  return String(value);
}

export function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Build an element from an HTML string. The caller is responsible for escaping. */
export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

/** Strip a plain-text body down to something safe to show as HTML. */
export function textToHtml(text) {
  const escaped = esc(text);
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
  return `<div style="white-space:pre-wrap;font-family:Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#202124">${linked}</div>`;
}

/** Turn an HTML body back into quotable plain text for reply drafts. */
export function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  div.querySelectorAll('script,style').forEach(node => node.remove());
  return (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Base64 that survives non-Latin1 characters. */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export function base64ToBase64Url(base64) {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
