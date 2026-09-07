// Thin typed wrappers over the /api/gmail/* proxy.

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const key = localStorage.getItem('matonApiKey');
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function apiKeyParam() {
  return encodeURIComponent(localStorage.getItem('matonApiKey') || '');
}

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders(options.headers)
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    body = { error: text };
  }

  if (!response.ok) {
    const message = body.error
      || (body.upstream && (body.upstream.error?.message || body.upstream.message))
      || `Request failed (${response.status})`;
    throw new ApiError(typeof message === 'string' ? message : JSON.stringify(message), response.status, body);
  }
  return body;
}

function jsonPost(url, payload, method = 'POST') {
  return request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
}

export const api = {
  profile: (refresh = false) =>
    request(`/api/gmail/profile${refresh ? '?refresh=true' : ''}`),

  labels: (refresh = false) =>
    request(`/api/gmail/labels${refresh ? '?refresh=true' : ''}`),

  threads({ view = 'inbox', category = '', q = '', label = '', pageToken = '', maxResults = 50, refresh = false }) {
    const params = new URLSearchParams();
    params.set('view', view);
    params.set('maxResults', String(maxResults));
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    if (label) params.set('label', label);
    if (pageToken) params.set('pageToken', pageToken);
    if (refresh) params.set('refresh', 'true');
    return request(`/api/gmail/threads?${params.toString()}`);
  },

  thread(id, historyId = '', refresh = false) {
    const params = new URLSearchParams();
    if (historyId) params.set('historyId', historyId);
    if (refresh) params.set('refresh', 'true');
    const qs = params.toString();
    return request(`/api/gmail/threads/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`);
  },

  modifyThreads: (ids, addLabelIds = [], removeLabelIds = []) =>
    jsonPost('/api/gmail/threads/modify', { ids, addLabelIds, removeLabelIds }),

  trashThreads: (ids, untrash = false) =>
    jsonPost('/api/gmail/threads/trash', { ids, untrash }),

  deleteThreads: ids =>
    jsonPost('/api/gmail/threads/delete', { ids }),

  send: (raw, threadId = null) =>
    jsonPost('/api/gmail/send', { raw, threadId }),

  listDrafts: () => request('/api/gmail/drafts'),

  createDraft: (raw, threadId = null) =>
    jsonPost('/api/gmail/drafts', { raw, threadId }),

  updateDraft: (id, raw, threadId = null) =>
    jsonPost(`/api/gmail/drafts/${encodeURIComponent(id)}`, { raw, threadId }, 'PUT'),

  sendDraft: id =>
    jsonPost(`/api/gmail/drafts/${encodeURIComponent(id)}/send`, {}),

  deleteDraft: id =>
    request(`/api/gmail/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

/**
 * Attachment URLs are used by <img>/<a download>, which cannot send headers,
 * so the key rides along as a query param on these two URLs only.
 */
export function attachmentUrl(messageId, attachment, inline = false) {
  const params = new URLSearchParams();
  params.set('filename', attachment.filename || 'attachment');
  params.set('mimeType', attachment.mimeType || 'application/octet-stream');
  if (inline) params.set('inline', 'true');
  params.set('apiKey', localStorage.getItem('matonApiKey') || '');
  return `/api/gmail/messages/${encodeURIComponent(messageId)}`
    + `/attachments/${encodeURIComponent(attachment.attachmentId)}?${params.toString()}`;
}

export { ApiError };
