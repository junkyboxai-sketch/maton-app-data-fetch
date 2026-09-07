const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const gmail = require('../lib/gmail');
const drive = require('../lib/drive');

const MATON_HOST = 'api.maton.ai';
const MATON_CTRL_HOST = 'ctrl.maton.ai';
const CACHE_TTL_MS = 5 * 60 * 1000;
const THREAD_CONCURRENCY = 12;

// ---------------------------------------------------------------------------
// Caching
//
// Every cache key is namespaced by a hash of the caller's API key. Without it a
// warm Lambda instance would serve one account's mail to another account.
// ---------------------------------------------------------------------------

const responseCache = new Map();

function keyspace(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || 'anon')).digest('hex').slice(0, 16);
}

function getCachedData(key, bypass = false) {
  if (bypass) return null;
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedData(key, data) {
  // Keep the map from growing without bound across a long-lived instance.
  if (responseCache.size > 500) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { timestamp: Date.now(), data });
}

function dropCacheNamespace(prefix) {
  Array.from(responseCache.keys())
    .filter(k => k.startsWith(prefix))
    .forEach(k => responseCache.delete(k));
}

// ---------------------------------------------------------------------------
// Auth + upstream transport
// ---------------------------------------------------------------------------

function getApiKey(req, searchParams) {
  if (searchParams && searchParams.get('apiKey')) {
    return searchParams.get('apiKey').trim();
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.headers['x-maton-api-key']) {
    return req.headers['x-maton-api-key'].trim();
  }
  const dotenvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(dotenvPath)) {
    try {
      const lines = fs.readFileSync(dotenvPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line.trim().startsWith('MATON_API_KEY=')) {
          return line.trim().split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
        }
      }
    } catch (e) { /* fall through to env */ }
  }
  return process.env.MATON_API_KEY;
}

function makeMatonRequest(apiKey, urlPath, method = 'GET', bodyObj = null, host = MATON_HOST) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      return resolve({ status: 401, body: { error: 'MATON_API_KEY is not configured.' } });
    }
    const bodyData = bodyObj ? JSON.stringify(bodyObj) : '';
    const options = {
      hostname: host,
      port: 443,
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    };
    if (bodyData) options.headers['Content-Length'] = Buffer.byteLength(bodyData);

    const upstream = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    upstream.on('error', reject);
    if (bodyData) upstream.write(bodyData);
    upstream.end();
  });
}

function streamMatonDownload(apiKey, urlPath, res, filename, mimeType, inline = false) {
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MATON_API_KEY is not configured.' }));
    return;
  }
  const options = {
    hostname: MATON_HOST,
    port: 443,
    path: urlPath,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` }
  };

  const upstream = https.request(options, apiRes => {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': apiRes.headers['content-type'] || mimeType || 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : `attachment; filename="${encodeURIComponent(filename)}"`
    });
    apiRes.pipe(res);
  });

  upstream.on('error', err => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  upstream.end();
}

const G = '/google-mail/gmail/v1/users/me';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [];

function route(method, pattern, handler) {
  const names = [];
  const source = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp('^' + source + '$'), names, handler });
}

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const entry of routes) {
    const match = entry.regex.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (entry.method !== method) continue;
    const params = {};
    entry.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
    return { handler: entry.handler, params };
  }
  return pathMatched ? { methodMismatch: true } : null;
}

// --- Gmail: profile & labels ------------------------------------------------

route('GET', '/api/gmail/profile', async ctx => {
  const cacheKey = `profile_${ctx.ns}`;
  const cached = getCachedData(cacheKey, ctx.refresh);
  if (cached) return ctx.json(200, cached);

  const result = await makeMatonRequest(ctx.apiKey, `${G}/profile`);
  if (result.status === 200) setCachedData(cacheKey, result.body);
  return ctx.json(result.status, result.body);
});

route('GET', '/api/gmail/labels', async ctx => {
  const cacheKey = `labels_${ctx.ns}`;
  const cached = getCachedData(cacheKey, ctx.refresh);
  if (cached) return ctx.json(200, cached);

  const listRes = await makeMatonRequest(ctx.apiKey, `${G}/labels`);
  if (listRes.status !== 200) return ctx.json(listRes.status, listRes.body);

  const labels = listRes.body.labels || [];
  // labels.list omits counts, so hydrate the ones the sidebar actually shows.
  const needCounts = labels.filter(l =>
    l.type === 'user' || ['INBOX', 'STARRED', 'DRAFT', 'SENT', 'TRASH', 'SPAM', 'IMPORTANT'].includes(l.id)
  );

  const hydrated = await gmail.mapLimit(needCounts, THREAD_CONCURRENCY, async label => {
    const res = await makeMatonRequest(ctx.apiKey, `${G}/labels/${encodeURIComponent(label.id)}`);
    return res.status === 200 ? res.body : label;
  });

  const byId = new Map(hydrated.map(l => [l.id, l]));
  const payload = {
    labels: labels.map(l => {
      const full = byId.get(l.id) || l;
      return {
        id: l.id,
        name: l.name,
        type: l.type,
        color: l.color || null,
        messagesUnread: full.messagesUnread || 0,
        messagesTotal: full.messagesTotal || 0,
        threadsUnread: full.threadsUnread || 0,
        threadsTotal: full.threadsTotal || 0
      };
    })
  };

  setCachedData(cacheKey, payload);
  return ctx.json(200, payload);
});

// --- Gmail: thread list -----------------------------------------------------

route('GET', '/api/gmail/threads', async ctx => {
  const view = ctx.query.get('view') || 'inbox';
  const category = ctx.query.get('category') || '';
  const search = ctx.query.get('q') || '';
  const label = ctx.query.get('label') || '';
  const pageToken = ctx.query.get('pageToken') || '';
  const maxResults = Math.min(parseInt(ctx.query.get('maxResults'), 10) || 50, 100);

  const q = gmail.buildQuery({ view, category, search, label });

  let listPath = `${G}/threads?maxResults=${maxResults}&q=${encodeURIComponent(q)}`;
  if (view === 'trash' || view === 'spam' || search) listPath += '&includeSpamTrash=true';
  if (pageToken) listPath += `&pageToken=${encodeURIComponent(pageToken)}`;

  const listRes = await makeMatonRequest(ctx.apiKey, listPath);
  if (listRes.status !== 200) return ctx.json(listRes.status, listRes.body);

  const stubs = listRes.body.threads || [];

  // threads.list only returns ids; hydrate metadata per thread, keyed by
  // historyId so a cached summary is invalidated the moment the thread changes.
  const metadataHeaders = ['From', 'Subject', 'Date', 'To']
    .map(h => `&metadataHeaders=${h}`).join('');

  const summaries = await gmail.mapLimit(stubs, THREAD_CONCURRENCY, async stub => {
    const cacheKey = `tmeta_${ctx.ns}_${stub.id}_${stub.historyId || ''}`;
    const cached = getCachedData(cacheKey, ctx.refresh);
    if (cached) return cached;

    const res = await makeMatonRequest(
      ctx.apiKey,
      `${G}/threads/${stub.id}?format=metadata${metadataHeaders}`
    );
    if (res.status !== 200) return null;

    const summary = gmail.summarizeThread(res.body, stub.historyId);
    if (summary) {
      summary.snippet = stub.snippet || summary.snippet;
      setCachedData(cacheKey, summary);
    }
    return summary;
  });

  return ctx.json(200, {
    threads: summaries.filter(Boolean),
    nextPageToken: listRes.body.nextPageToken || null,
    resultSizeEstimate: listRes.body.resultSizeEstimate || 0,
    query: q
  });
});

// --- Gmail: single thread ---------------------------------------------------

route('GET', '/api/gmail/threads/:id', async ctx => {
  const historyId = ctx.query.get('historyId') || '';
  const cacheKey = `tfull_${ctx.ns}_${ctx.params.id}_${historyId}`;
  if (historyId) {
    const cached = getCachedData(cacheKey, ctx.refresh);
    if (cached) return ctx.json(200, cached);
  }

  const res = await makeMatonRequest(ctx.apiKey, `${G}/threads/${ctx.params.id}?format=full`);
  if (res.status !== 200) return ctx.json(res.status, res.body);

  const messages = (res.body.messages || []).map(gmail.parseMessage);
  const payload = {
    id: res.body.id,
    historyId: res.body.historyId,
    subject: messages.length ? messages[0].headers.subject : '',
    messages
  };

  if (historyId) setCachedData(cacheKey, payload);
  return ctx.json(200, payload);
});

// --- Gmail: mutations -------------------------------------------------------

async function modifyThreads(ctx, ids, addLabelIds, removeLabelIds) {
  const results = await gmail.mapLimit(ids, THREAD_CONCURRENCY, id =>
    makeMatonRequest(ctx.apiKey, `${G}/threads/${id}/modify`, 'POST', {
      addLabelIds: addLabelIds || [],
      removeLabelIds: removeLabelIds || []
    })
  );
  // Summaries embed label state, so they are stale after any modify.
  dropCacheNamespace(`tmeta_${ctx.ns}`);
  dropCacheNamespace(`labels_${ctx.ns}`);
  const failed = results.filter(r => r.status >= 400);
  return { ok: failed.length === 0, failed: failed.length, total: ids.length, error: failed[0] };
}

route('POST', '/api/gmail/threads/modify', async ctx => {
  const body = await readBody(ctx.req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return ctx.json(400, { error: 'ids is required' });

  const result = await modifyThreads(ctx, ids, body.addLabelIds, body.removeLabelIds);
  if (!result.ok) {
    return ctx.json(502, {
      error: `Failed to modify ${result.failed} of ${result.total} threads`,
      upstream: result.error && result.error.body
    });
  }
  return ctx.json(200, { ok: true, modified: ids.length });
});

route('POST', '/api/gmail/threads/trash', async ctx => {
  const body = await readBody(ctx.req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return ctx.json(400, { error: 'ids is required' });

  const action = body.untrash ? 'untrash' : 'trash';
  const results = await gmail.mapLimit(ids, THREAD_CONCURRENCY, id =>
    makeMatonRequest(ctx.apiKey, `${G}/threads/${id}/${action}`, 'POST')
  );
  dropCacheNamespace(`tmeta_${ctx.ns}`);
  dropCacheNamespace(`labels_${ctx.ns}`);

  const failed = results.find(r => r.status >= 400);
  if (failed) return ctx.json(failed.status, failed.body);
  return ctx.json(200, { ok: true, [action + 'ed']: ids.length });
});

route('POST', '/api/gmail/threads/delete', async ctx => {
  const body = await readBody(ctx.req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return ctx.json(400, { error: 'ids is required' });

  const results = await gmail.mapLimit(ids, THREAD_CONCURRENCY, id =>
    makeMatonRequest(ctx.apiKey, `${G}/threads/${id}`, 'DELETE')
  );
  dropCacheNamespace(`tmeta_${ctx.ns}`);
  dropCacheNamespace(`labels_${ctx.ns}`);

  const failed = results.find(r => r.status >= 400);
  if (failed) {
    return ctx.json(failed.status, {
      error: 'Permanent deletion requires the full https://mail.google.com/ scope on the Maton connection.',
      upstream: failed.body
    });
  }
  return ctx.json(200, { ok: true, deleted: ids.length });
});

// --- Gmail: send ------------------------------------------------------------

route('POST', '/api/gmail/send', async ctx => {
  const body = await readBody(ctx.req);
  if (!body.raw) return ctx.json(400, { error: 'raw (base64url RFC 822 message) is required' });

  const payload = { raw: body.raw };
  if (body.threadId) payload.threadId = body.threadId;

  const res = await makeMatonRequest(ctx.apiKey, `${G}/messages/send`, 'POST', payload);
  dropCacheNamespace(`tmeta_${ctx.ns}`);
  dropCacheNamespace(`labels_${ctx.ns}`);
  return ctx.json(res.status, res.body);
});

// --- Gmail: drafts ----------------------------------------------------------

route('GET', '/api/gmail/drafts', async ctx => {
  const listRes = await makeMatonRequest(ctx.apiKey, `${G}/drafts?maxResults=50`);
  if (listRes.status !== 200) return ctx.json(listRes.status, listRes.body);

  const stubs = listRes.body.drafts || [];
  const drafts = await gmail.mapLimit(stubs, THREAD_CONCURRENCY, async stub => {
    const res = await makeMatonRequest(ctx.apiKey, `${G}/drafts/${stub.id}?format=full`);
    if (res.status !== 200) return null;
    return { id: res.body.id, message: gmail.parseMessage(res.body.message || {}) };
  });

  return ctx.json(200, { drafts: drafts.filter(Boolean) });
});

route('POST', '/api/gmail/drafts', async ctx => {
  const body = await readBody(ctx.req);
  if (!body.raw) return ctx.json(400, { error: 'raw is required' });

  const message = { raw: body.raw };
  if (body.threadId) message.threadId = body.threadId;

  const res = await makeMatonRequest(ctx.apiKey, `${G}/drafts`, 'POST', { message });
  dropCacheNamespace(`labels_${ctx.ns}`);
  return ctx.json(res.status, res.body);
});

route('PUT', '/api/gmail/drafts/:id', async ctx => {
  const body = await readBody(ctx.req);
  if (!body.raw) return ctx.json(400, { error: 'raw is required' });

  const message = { raw: body.raw };
  if (body.threadId) message.threadId = body.threadId;

  const res = await makeMatonRequest(ctx.apiKey, `${G}/drafts/${ctx.params.id}`, 'PUT', {
    id: ctx.params.id,
    message
  });
  return ctx.json(res.status, res.body);
});

route('POST', '/api/gmail/drafts/:id/send', async ctx => {
  const res = await makeMatonRequest(ctx.apiKey, `${G}/drafts/send`, 'POST', { id: ctx.params.id });
  dropCacheNamespace(`tmeta_${ctx.ns}`);
  dropCacheNamespace(`labels_${ctx.ns}`);
  return ctx.json(res.status, res.body);
});

route('DELETE', '/api/gmail/drafts/:id', async ctx => {
  const res = await makeMatonRequest(ctx.apiKey, `${G}/drafts/${ctx.params.id}`, 'DELETE');
  dropCacheNamespace(`labels_${ctx.ns}`);
  return ctx.json(res.status, res.body || { ok: true });
});

// --- Gmail: attachments -----------------------------------------------------

route('GET', '/api/gmail/messages/:messageId/attachments/:attachmentId', async ctx => {
  const filename = ctx.query.get('filename') || 'attachment';
  const mimeType = ctx.query.get('mimeType') || 'application/octet-stream';
  const inline = ctx.query.get('inline') === 'true';

  const res = await makeMatonRequest(
    ctx.apiKey,
    `${G}/messages/${ctx.params.messageId}/attachments/${ctx.params.attachmentId}`
  );
  if (res.status !== 200) return ctx.json(res.status, res.body);

  const buffer = Buffer.from(res.body.data || '', 'base64url');
  ctx.res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': buffer.length,
    'Cache-Control': 'private, max-age=600',
    'Content-Disposition': inline
      ? `inline; filename="${encodeURIComponent(filename)}"`
      : `attachment; filename="${encodeURIComponent(filename)}"`
  });
  ctx.res.end(buffer);
});

// --- Drive ------------------------------------------------------------------

const D = '/google-drive/drive/v3';

route('GET', '/api/drive/about', async ctx => {
  const cacheKey = `about_${ctx.ns}`;
  const cached = getCachedData(cacheKey, ctx.refresh);
  if (cached) return ctx.json(200, cached);

  const fields = encodeURIComponent('storageQuota,user(displayName,emailAddress,photoLink)');
  const res = await makeMatonRequest(ctx.apiKey, `${D}/about?fields=${fields}`);
  if (res.status === 200) setCachedData(cacheKey, res.body);
  return ctx.json(res.status, res.body);
});

route('GET', '/api/drive/files', async ctx => {
  const view = ctx.query.get('view') || 'mydrive';
  const parent = ctx.query.get('parent') || '';
  const search = ctx.query.get('search') || '';
  const sort = ctx.query.get('sort') || 'name';
  const pageToken = ctx.query.get('pageToken') || '';
  const pageSize = Math.min(parseInt(ctx.query.get('pageSize'), 10) || 100, 200);

  const cacheKey = `dlist_${ctx.ns}_${view}_${parent}_${search}_${sort}_${pageToken}`;
  const cached = getCachedData(cacheKey, ctx.refresh);
  if (cached) return ctx.json(200, cached);

  const q = drive.buildQuery({ view, parent, search });
  let url = `${D}/files?q=${encodeURIComponent(q)}`
    + `&pageSize=${pageSize}`
    + `&orderBy=${encodeURIComponent(drive.buildOrderBy(sort, view))}`
    + `&fields=${encodeURIComponent(drive.LIST_FIELDS)}`
    + '&supportsAllDrives=true&includeItemsFromAllDrives=true';
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

  const res = await makeMatonRequest(ctx.apiKey, url);
  if (res.status !== 200) return ctx.json(res.status, res.body);

  const payload = {
    files: (res.body.files || []).map(drive.shapeFile),
    nextPageToken: res.body.nextPageToken || null,
    incompleteSearch: !!res.body.incompleteSearch,
    query: q
  };
  setCachedData(cacheKey, payload);
  return ctx.json(200, payload);
});

route('GET', '/api/drive/files/:id', async ctx => {
  const url = `${D}/files/${encodeURIComponent(ctx.params.id)}`
    + `?fields=${encodeURIComponent(drive.FILE_FIELDS)}&supportsAllDrives=true`;
  const res = await makeMatonRequest(ctx.apiKey, url);
  if (res.status !== 200) return ctx.json(res.status, res.body);
  return ctx.json(200, drive.shapeFile(res.body));
});

// Walk the parent chain so the UI can render a real breadcrumb trail for a
// folder reached by deep link or search rather than by clicking down to it.
route('GET', '/api/drive/files/:id/path', async ctx => {
  const trail = [];
  let currentId = ctx.params.id;
  const seen = new Set();

  while (currentId && !seen.has(currentId) && trail.length < 20) {
    seen.add(currentId);
    const url = `${D}/files/${encodeURIComponent(currentId)}`
      + '?fields=id,name,parents&supportsAllDrives=true';
    const res = await makeMatonRequest(ctx.apiKey, url);
    if (res.status !== 200) break;

    trail.unshift({ id: res.body.id, name: res.body.name });
    const parents = res.body.parents || [];
    if (!parents.length) break;
    currentId = parents[0];

    // The root folder's name is the account name; the UI calls it "My Drive".
    if (currentId) {
      const rootCheck = await makeMatonRequest(ctx.apiKey, `${D}/files/${currentId}?fields=id,parents`);
      if (rootCheck.status === 200 && !(rootCheck.body.parents || []).length) {
        trail.unshift({ id: rootCheck.body.id, name: 'My Drive', isRoot: true });
        break;
      }
    }
  }

  return ctx.json(200, { path: trail });
});

route('POST', '/api/drive/folders', async ctx => {
  const body = await readBody(ctx.req);
  if (!body.name || !body.name.trim()) return ctx.json(400, { error: 'name is required' });

  const res = await makeMatonRequest(ctx.apiKey, `${D}/files?supportsAllDrives=true`, 'POST', {
    name: body.name.trim(),
    mimeType: drive.FOLDER_MIME,
    parents: [body.parentId || 'root']
  });
  dropCacheNamespace(`dlist_${ctx.ns}`);
  if (res.status !== 200) return ctx.json(res.status, res.body);
  return ctx.json(200, drive.shapeFile(res.body));
});

route('PATCH', '/api/drive/files/:id', async ctx => {
  const body = await readBody(ctx.req);
  const metadata = {};
  if (typeof body.name === 'string') metadata.name = body.name;
  if (typeof body.starred === 'boolean') metadata.starred = body.starred;
  if (typeof body.trashed === 'boolean') metadata.trashed = body.trashed;

  let url = `${D}/files/${encodeURIComponent(ctx.params.id)}`
    + `?fields=${encodeURIComponent(drive.FILE_FIELDS)}&supportsAllDrives=true`;
  if (body.addParents) url += `&addParents=${encodeURIComponent(body.addParents)}`;
  if (body.removeParents) url += `&removeParents=${encodeURIComponent(body.removeParents)}`;

  const res = await makeMatonRequest(ctx.apiKey, url, 'PATCH', metadata);
  dropCacheNamespace(`dlist_${ctx.ns}`);
  if (res.status !== 200) return ctx.json(res.status, res.body);
  return ctx.json(200, drive.shapeFile(res.body));
});

route('POST', '/api/drive/files/:id/copy', async ctx => {
  const body = await readBody(ctx.req);
  const payload = {};
  if (body.name) payload.name = body.name;
  if (body.parentId) payload.parents = [body.parentId];

  const url = `${D}/files/${encodeURIComponent(ctx.params.id)}/copy`
    + `?fields=${encodeURIComponent(drive.FILE_FIELDS)}&supportsAllDrives=true`;
  const res = await makeMatonRequest(ctx.apiKey, url, 'POST', payload);
  dropCacheNamespace(`dlist_${ctx.ns}`);
  if (res.status !== 200) return ctx.json(res.status, res.body);
  return ctx.json(200, drive.shapeFile(res.body));
});

route('DELETE', '/api/drive/files/:id', async ctx => {
  const res = await makeMatonRequest(
    ctx.apiKey,
    `${D}/files/${encodeURIComponent(ctx.params.id)}?supportsAllDrives=true`,
    'DELETE'
  );
  dropCacheNamespace(`dlist_${ctx.ns}`);
  if (res.status >= 400) return ctx.json(res.status, res.body);
  return ctx.json(200, { ok: true });
});

/** Bulk star / trash / restore / delete / move for the selection toolbar. */
route('POST', '/api/drive/batch', async ctx => {
  const body = await readBody(ctx.req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const action = body.action;
  if (!ids.length) return ctx.json(400, { error: 'ids is required' });

  const results = await gmail.mapLimit(ids, 8, async id => {
    const base = `${D}/files/${encodeURIComponent(id)}`;
    switch (action) {
      case 'trash':
        return makeMatonRequest(ctx.apiKey, `${base}?supportsAllDrives=true`, 'PATCH', { trashed: true });
      case 'restore':
        return makeMatonRequest(ctx.apiKey, `${base}?supportsAllDrives=true`, 'PATCH', { trashed: false });
      case 'star':
        return makeMatonRequest(ctx.apiKey, `${base}?supportsAllDrives=true`, 'PATCH', { starred: true });
      case 'unstar':
        return makeMatonRequest(ctx.apiKey, `${base}?supportsAllDrives=true`, 'PATCH', { starred: false });
      case 'delete':
        return makeMatonRequest(ctx.apiKey, `${base}?supportsAllDrives=true`, 'DELETE');
      case 'move':
        return makeMatonRequest(
          ctx.apiKey,
          `${base}?supportsAllDrives=true&addParents=${encodeURIComponent(body.addParents || '')}`
            + `&removeParents=${encodeURIComponent(body.removeParents || '')}`,
          'PATCH',
          {}
        );
      default:
        return { status: 400, body: { error: `Unknown action: ${action}` } };
    }
  });

  dropCacheNamespace(`dlist_${ctx.ns}`);
  const failed = results.filter(r => r.status >= 400);
  if (failed.length) {
    return ctx.json(502, {
      error: `${failed.length} of ${ids.length} items failed`,
      upstream: failed[0].body
    });
  }
  return ctx.json(200, { ok: true, count: ids.length });
});

/**
 * Stream a file's bytes. Google-native types are exported to a renderable
 * format first, so the viewer never has to leave the app.
 */
route('GET', '/api/drive/files/:id/content', async ctx => {
  const name = ctx.query.get('name') || 'file';
  const mimeType = ctx.query.get('mimeType') || '';
  const inline = ctx.query.get('inline') === 'true';
  const id = encodeURIComponent(ctx.params.id);

  if (drive.isGoogleNative(mimeType)) {
    const format = drive.exportFormat(mimeType, inline ? 'preview' : 'download');
    const filename = name.endsWith(format.extension) ? name : name + format.extension;
    const exportUrl = `${D}/files/${id}/export?mimeType=${encodeURIComponent(format.mimeType)}`;
    return streamMatonDownload(ctx.apiKey, exportUrl, ctx.res, filename, format.mimeType, inline);
  }

  return streamMatonDownload(
    ctx.apiKey,
    `${D}/files/${id}?alt=media&supportsAllDrives=true`,
    ctx.res, name, mimeType, inline
  );
});

// --- Drive sharing ----------------------------------------------------------

route('GET', '/api/drive/files/:id/permissions', async ctx => {
  const fields = encodeURIComponent(
    'permissions(id,type,role,displayName,emailAddress,photoLink,domain,deleted,pendingOwner)'
  );
  const url = `${D}/files/${encodeURIComponent(ctx.params.id)}/permissions`
    + `?fields=${fields}&supportsAllDrives=true`;
  const res = await makeMatonRequest(ctx.apiKey, url);
  if (res.status !== 200) return ctx.json(res.status, res.body);
  return ctx.json(200, { permissions: (res.body.permissions || []).map(drive.shapePermission) });
});

route('POST', '/api/drive/files/:id/permissions', async ctx => {
  const body = await readBody(ctx.req);
  const type = body.type || 'user';
  if (type === 'user' && !body.emailAddress) {
    return ctx.json(400, { error: 'emailAddress is required for a user permission' });
  }

  const payload = { type, role: body.role || 'reader' };
  if (type === 'user' || type === 'group') payload.emailAddress = body.emailAddress;
  if (type === 'domain') payload.domain = body.domain;

  let url = `${D}/files/${encodeURIComponent(ctx.params.id)}/permissions?supportsAllDrives=true`;
  // Drive nags about notification mail for every new user permission.
  url += `&sendNotificationEmail=${body.notify === false ? 'false' : 'true'}`;
  if (body.message) url += `&emailMessage=${encodeURIComponent(body.message)}`;

  const res = await makeMatonRequest(ctx.apiKey, url, 'POST', payload);
  if (res.status >= 400) return ctx.json(res.status, res.body);
  return ctx.json(200, drive.shapePermission(res.body));
});

route('PATCH', '/api/drive/files/:id/permissions/:permissionId', async ctx => {
  const body = await readBody(ctx.req);
  if (!body.role) return ctx.json(400, { error: 'role is required' });

  const url = `${D}/files/${encodeURIComponent(ctx.params.id)}`
    + `/permissions/${encodeURIComponent(ctx.params.permissionId)}?supportsAllDrives=true`;
  const res = await makeMatonRequest(ctx.apiKey, url, 'PATCH', { role: body.role });
  if (res.status >= 400) return ctx.json(res.status, res.body);
  return ctx.json(200, drive.shapePermission(res.body));
});

route('DELETE', '/api/drive/files/:id/permissions/:permissionId', async ctx => {
  const url = `${D}/files/${encodeURIComponent(ctx.params.id)}`
    + `/permissions/${encodeURIComponent(ctx.params.permissionId)}?supportsAllDrives=true`;
  const res = await makeMatonRequest(ctx.apiKey, url, 'DELETE');
  if (res.status >= 400) return ctx.json(res.status, res.body);
  return ctx.json(200, { ok: true });
});

// --- Google Sheets (in-app editor) ------------------------------------------

route('GET', '/api/sheets/:id', async ctx => {
  const fields = encodeURIComponent('spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties))');
  const res = await makeMatonRequest(
    ctx.apiKey,
    `/google-sheets/v4/spreadsheets/${encodeURIComponent(ctx.params.id)}?fields=${fields}`
  );
  return ctx.json(res.status, res.body);
});

route('GET', '/api/sheets/:id/values', async ctx => {
  const range = ctx.query.get('range') || 'A1:Z200';
  const url = `/google-sheets/v4/spreadsheets/${encodeURIComponent(ctx.params.id)}`
    + `/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const res = await makeMatonRequest(ctx.apiKey, url);
  return ctx.json(res.status, res.body);
});

route('PUT', '/api/sheets/:id/values', async ctx => {
  const body = await readBody(ctx.req);
  if (!body.range) return ctx.json(400, { error: 'range is required' });

  const url = `/google-sheets/v4/spreadsheets/${encodeURIComponent(ctx.params.id)}`
    + `/values/${encodeURIComponent(body.range)}?valueInputOption=USER_ENTERED`;
  const res = await makeMatonRequest(ctx.apiKey, url, 'PUT', {
    range: body.range,
    majorDimension: 'ROWS',
    values: body.values || []
  });
  dropCacheNamespace(`dlist_${ctx.ns}`);
  return ctx.json(res.status, res.body);
});

// --- Google Docs (in-app editor) --------------------------------------------

route('GET', '/api/docs/:id', async ctx => {
  const res = await makeMatonRequest(
    ctx.apiKey,
    `/google-docs/v1/documents/${encodeURIComponent(ctx.params.id)}`
  );
  return ctx.json(res.status, res.body);
});

route('POST', '/api/docs/:id/batchUpdate', async ctx => {
  const body = await readBody(ctx.req);
  const requests = Array.isArray(body.requests) ? body.requests : [];
  if (!requests.length) return ctx.json(400, { error: 'requests is required' });

  const res = await makeMatonRequest(
    ctx.apiKey,
    `/google-docs/v1/documents/${encodeURIComponent(ctx.params.id)}:batchUpdate`,
    'POST',
    { requests }
  );
  dropCacheNamespace(`dlist_${ctx.ns}`);
  return ctx.json(res.status, res.body);
});

// --- Maton platform ---------------------------------------------------------

route('GET', '/api/maton/apikey/status', async ctx => {
  return ctx.json(200, {
    configured: !!ctx.apiKey,
    preview: ctx.apiKey ? '...' + ctx.apiKey.slice(-4) : ''
  });
});

route('GET', '/api/maton/connections', async ctx => {
  const res = await makeMatonRequest(ctx.apiKey, '/connections', 'GET', null, MATON_CTRL_HOST);
  return ctx.json(res.status, res.body);
});

route('GET', '/api/maton/searchconsole/sites', async ctx => {
  const res = await makeMatonRequest(ctx.apiKey, '/google-search-console/webmasters/v3/sites');
  return ctx.json(res.status, res.body);
});

route('POST', '/api/maton/searchconsole/performance', async ctx => {
  const body = await readBody(ctx.req);
  if (!body.siteUrl) return ctx.json(400, { error: 'siteUrl is required' });

  const targetUrl = `/google-search-console/webmasters/v3/sites/`
    + `${encodeURIComponent(body.siteUrl)}/searchAnalytics/query`;
  const res = await makeMatonRequest(ctx.apiKey, targetUrl, 'POST', {
    startDate: body.startDate,
    endDate: body.endDate,
    dimensions: body.dimensions || ['query'],
    rowLimit: body.rowLimit || 100
  });
  return ctx.json(res.status, res.body);
});

route('GET', '/api/maton/analytics/accounts', async ctx => {
  const res = await makeMatonRequest(ctx.apiKey, '/google-analytics-admin/v1alpha/accounts');
  return ctx.json(res.status, res.body);
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  const parsedUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const apiKey = getApiKey(req, parsedUrl.searchParams);

  const ctx = {
    req,
    res,
    apiKey,
    ns: keyspace(apiKey),
    query: parsedUrl.searchParams,
    refresh: parsedUrl.searchParams.get('refresh') === 'true',
    params: {},
    json(status, data) {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
  };

  const matched = matchRoute(req.method, parsedUrl.pathname);

  if (!matched) return ctx.json(404, { error: `No route for ${req.method} ${parsedUrl.pathname}` });
  if (matched.methodMismatch) return ctx.json(405, { error: 'Method Not Allowed' });

  // Everything except the status probe needs a key; fail fast with a clear message.
  if (!apiKey && parsedUrl.pathname !== '/api/maton/apikey/status') {
    return ctx.json(401, { error: 'MATON_API_KEY is not configured. Open Settings and add your key.' });
  }

  ctx.params = matched.params;

  try {
    await matched.handler(ctx);
  } catch (err) {
    ctx.json(500, { error: err.message });
  }
};
