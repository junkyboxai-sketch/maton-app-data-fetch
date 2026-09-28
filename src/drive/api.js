// Typed wrappers over the /api/drive, /api/sheets and /api/docs proxy routes.

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const key = localStorage.getItem('matonApiKey');
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

class DriveError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.body = body;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: authHeaders(options.headers) });
  const text = await response.text();

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    body = { error: text };
  }

  if (!response.ok) {
    const upstream = body.upstream && (body.upstream.error?.message || body.upstream.message);
    const message = body.error || upstream || `Request failed (${response.status})`;
    throw new DriveError(typeof message === 'string' ? message : JSON.stringify(message), response.status, body);
  }
  return body;
}

function send(url, payload, method = 'POST') {
  return request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
}

export const driveApi = {
  about: (refresh = false) => request(`/api/drive/about${refresh ? '?refresh=true' : ''}`),

  list({ view = 'mydrive', parent = '', search = '', sort = 'name', pageToken = '', refresh = false }) {
    const params = new URLSearchParams({ view, sort });
    if (parent) params.set('parent', parent);
    if (search) params.set('search', search);
    if (pageToken) params.set('pageToken', pageToken);
    if (refresh) params.set('refresh', 'true');
    return request(`/api/drive/files?${params.toString()}`);
  },

  file: id => request(`/api/drive/files/${encodeURIComponent(id)}`),

  path: id => request(`/api/drive/files/${encodeURIComponent(id)}/path`),

  /** Flatten a folder into ZIP-ready entries, each with its archive path. */
  tree: id => request(`/api/drive/files/${encodeURIComponent(id)}/tree`),

  createFolder: (name, parentId) => send('/api/drive/folders', { name, parentId }),

  update: (id, patch) => send(`/api/drive/files/${encodeURIComponent(id)}`, patch, 'PATCH'),

  copy: (id, name, parentId) => send(`/api/drive/files/${encodeURIComponent(id)}/copy`, { name, parentId }),

  remove: id => request(`/api/drive/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  batch: (ids, action, extra = {}) => send('/api/drive/batch', { ids, action, ...extra }),

  permissions: id => request(`/api/drive/files/${encodeURIComponent(id)}/permissions`),

  addPermission: (id, payload) => send(`/api/drive/files/${encodeURIComponent(id)}/permissions`, payload),

  updatePermission: (id, permissionId, role) =>
    send(`/api/drive/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { role }, 'PATCH'),

  removePermission: (id, permissionId) =>
    request(`/api/drive/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: 'DELETE' })
};

export const sheetsApi = {
  meta: id => request(`/api/sheets/${encodeURIComponent(id)}`),
  values: (id, range) =>
    request(`/api/sheets/${encodeURIComponent(id)}/values?range=${encodeURIComponent(range)}`),
  setValues: (id, range, values) =>
    send(`/api/sheets/${encodeURIComponent(id)}/values`, { range, values }, 'PUT')
};

export const docsApi = {
  get: id => request(`/api/docs/${encodeURIComponent(id)}`),
  batchUpdate: (id, requests) => send(`/api/docs/${encodeURIComponent(id)}/batchUpdate`, { requests })
};

/**
 * Content URLs feed <img>, <iframe>, <video> and download links, none of
 * which can set headers, so the key rides as a query param here only.
 */
export function contentUrl(file, inline = true) {
  const params = new URLSearchParams({
    name: file.name || 'file',
    mimeType: file.mimeType || '',
    apiKey: localStorage.getItem('matonApiKey') || ''
  });
  if (inline) params.set('inline', 'true');
  return `/api/drive/files/${encodeURIComponent(file.id)}/content?${params.toString()}`;
}

export { DriveError };
