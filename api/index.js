const fs = require('fs');
const path = require('path');
const https = require('https');

// Persistent ID-based cache for email details
const emailCachePath = path.join('/tmp', 'email_details_cache.json');
let emailDetailsCache = {};
try {
  if (fs.existsSync(emailCachePath)) {
    emailDetailsCache = JSON.parse(fs.readFileSync(emailCachePath, 'utf8'));
  }
} catch (err) {
  // Ignore filesystem errors on serverless
}

function saveEmailDetailsCache() {
  try {
    fs.writeFileSync(emailCachePath, JSON.stringify(emailDetailsCache, null, 2), 'utf8');
  } catch (err) {
    // Ignore filesystem errors on serverless
  }
}

// In-memory caching store
const responseCache = new Map();

function getCachedData(key, bypass = false) {
  if (bypass) return null;
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > 3600000) { // 1 hour expiration
    responseCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedData(key, data) {
  responseCache.set(key, {
    timestamp: Date.now(),
    data: data
  });
}

function getApiKey(req, searchParams) {
  // 1. Check query parameter
  if (searchParams && searchParams.get('apiKey')) {
    return searchParams.get('apiKey').trim();
  }
  // 2. Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  // 3. Check custom header
  if (req.headers['x-maton-api-key']) {
    return req.headers['x-maton-api-key'].trim();
  }
  // 4. Fallback to process.env or local .env file
  const dotenvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(dotenvPath)) {
    try {
      const content = fs.readFileSync(dotenvPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim().startsWith('MATON_API_KEY=')) {
          return line.trim().split('=')[1].trim().replace(/^['"]|['"]$/g, '');
        }
      }
    } catch(e) {}
  }
  return process.env.MATON_API_KEY;
}

function makeMatonRequest(apiKey, urlPath, method = 'GET', bodyObj = null) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      return resolve({ status: 401, body: { error: 'MATON_API_KEY is not configured.' } });
    }
    const bodyData = bodyObj ? JSON.stringify(bodyObj) : '';
    const options = {
      hostname: 'api.maton.ai',
      port: 443,
      path: urlPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    };
    if (bodyData) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

function streamMatonDownload(apiKey, urlPath, res, filename, mimeType, inline = false) {
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MATON_API_KEY is not configured.' }));
    return;
  }
  const options = {
    hostname: 'api.maton.ai',
    port: 443,
    path: urlPath,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    }
  };

  const req = https.request(options, apiRes => {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': apiRes.headers['content-type'] || mimeType || 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : `attachment; filename="${encodeURIComponent(filename)}"`
    });
    apiRes.pipe(res);
  });

  req.on('error', err => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  req.end();
}

function getPartBody(part) {
  if (part.body && part.body.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  return '';
}

function parseMessageParts(part, result = { text: '', html: '' }) {
  if (part.mimeType === 'text/plain') {
    result.text += getPartBody(part);
  } else if (part.mimeType === 'text/html') {
    result.html += getPartBody(part);
  }
  
  if (part.parts) {
    part.parts.forEach(child => parseMessageParts(child, result));
  }
  return result;
}

module.exports = async (req, res) => {
  const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;
  
  const apiKey = getApiKey(req, searchParams);

  res.json = (data) => {
    res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  if (pathname === '/api/emails/labels') {
    if (req.method === 'GET') {
      try {
        const result = await makeMatonRequest(apiKey, '/google-mail/gmail/v1/users/me/labels');
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/emails') {
    if (req.method === 'GET') {
      try {
        const category = searchParams.get('category') || 'inbox';
        const month = searchParams.get('month') || '';
        const bypassCache = searchParams.get('refresh') === 'true';

        const cacheKey = `emails_${category}_${month}`;
        const cached = getCachedData(cacheKey, bypassCache);
        if (cached) {
          res.status(200).json(cached);
          return;
        }

        let q = '';
        if (category === 'starred') {
          q = 'is:starred';
        } else if (category === 'sent') {
          q = 'is:sent';
        } else if (category === 'drafts') {
          q = 'label:DRAFT';
        } else if (category === 'trash') {
          q = 'label:TRASH';
        } else if (category.startsWith('label_')) {
          const labelId = category.substring(6);
          q = `label:${labelId}`;
        } else {
          q = 'label:INBOX';
        }

        if (month) {
          const parts = month.split('-');
          const year = parseInt(parts[0], 10);
          const mon = parseInt(parts[1], 10);
          
          const after = `${month}-01`;
          let nextYear = year;
          let nextMon = mon + 1;
          if (nextMon > 12) {
            nextMon = 1;
            nextYear = year + 1;
          }
          const before = `${nextYear}-${String(nextMon).padStart(2, '0')}-01`;
          q += ` after:${after} before:${before}`;
        }

        const listRes = await makeMatonRequest(apiKey, `/google-mail/gmail/v1/users/me/messages?maxResults=40&includeSpamTrash=true&q=${encodeURIComponent(q)}`);
        if (listRes.status !== 200) {
          res.status(listRes.status).json(listRes.body);
          return;
        }

        const messages = listRes.body.messages || [];
        let hasNewDetails = false;
        
        const emailList = await Promise.all(
          messages.slice(0, 40).map(async (msg) => {
            try {
              if (emailDetailsCache[msg.id] && emailDetailsCache[msg.id].subject) {
                return emailDetailsCache[msg.id];
              }

              const detailRes = await makeMatonRequest(apiKey, `/google-mail/gmail/v1/users/me/messages/${msg.id}`);
              if (detailRes.status === 200) {
                const headers = detailRes.body.payload.headers || [];
                const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
                const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
                const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

                const cachedObj = {
                  id: msg.id,
                  subject: subjectHeader ? subjectHeader.value : '(No Subject)',
                  from: fromHeader ? fromHeader.value : '(Unknown Sender)',
                  date: dateHeader ? dateHeader.value : '(No Date)',
                  snippet: detailRes.body.snippet || ''
                };

                emailDetailsCache[msg.id] = cachedObj;
                hasNewDetails = true;
                return cachedObj;
              }
            } catch (err) {
              // Ignore
            }
            return null;
          })
        );

        const finalEmailList = emailList.filter(email => email !== null);
        if (hasNewDetails) {
          saveEmailDetailsCache();
        }

        setCachedData(cacheKey, finalEmailList);
        res.status(200).json(finalEmailList);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/drive/shared') {
    if (req.method === 'GET') {
      try {
        const dataPath = path.join(process.cwd(), 'shared_files.json');
        if (fs.existsSync(dataPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(fs.readFileSync(dataPath));
        } else {
          res.status(404).json({ error: 'Shared files list not found' });
        }
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/drive/files') {
    if (req.method === 'GET') {
      try {
        const parent = searchParams.get('parent') || '';
        const trashed = searchParams.get('trashed') === 'true';
        const shared = searchParams.get('shared') === 'true';
        const search = searchParams.get('search') || '';
        const bypassCache = searchParams.get('refresh') === 'true';

        const cacheKey = `drive_${parent}_${trashed}_${shared}_${search}`;
        const cached = getCachedData(cacheKey, bypassCache);
        if (cached) {
          res.status(200).json(cached);
          return;
        }

        let qParts = [];

        if (trashed) {
          qParts.push('trashed = true');
        } else {
          qParts.push('trashed = false');
          if (parent) {
            qParts.push(`'${parent}' in parents`);
          } else if (shared) {
            qParts.push('sharedWithMe = true');
          } else {
            qParts.push('sharedWithMe = true');
          }
        }

        if (search) {
          qParts.push(`name contains '${search.replace(/'/g, "\\'")}'`);
        }

        const q = qParts.join(' and ');
        const fields = 'nextPageToken,files(id,name,mimeType,owners,createdTime,webViewLink,parents,size)';
        const driveUrl = `/google-drive/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=100&fields=${encodeURIComponent(fields)}`;
        
        const result = await makeMatonRequest(apiKey, driveUrl);
        if (result.status === 200) {
          setCachedData(cacheKey, result.body);
        }
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/drive/sync') {
    if (req.method === 'POST') {
      try {
        const fields = 'nextPageToken,files(id,name,mimeType,owners,createdTime,webViewLink)';
        let allFiles = [];
        let pageToken = null;
        let success = true;

        do {
          let driveUrl = `/google-drive/drive/v3/files?q=sharedWithMe%3Dtrue&pageSize=100&fields=${encodeURIComponent(fields)}`;
          if (pageToken) {
            driveUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
          }

          const result = await makeMatonRequest(apiKey, driveUrl);
          if (result.status !== 200) {
            res.status(result.status).json(result.body);
            success = false;
            break;
          }

          if (result.body.files) {
            allFiles.push(...result.body.files);
          }
          pageToken = result.body.nextPageToken;
        } while (pageToken);

        if (success) {
          try {
            fs.writeFileSync(
              path.join(process.cwd(), 'shared_files.json'),
              JSON.stringify(allFiles, null, 2),
              'utf8'
            );
          } catch(e) {}
          res.status(200).json(allFiles);
        }
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname.startsWith('/api/drive/files/')) {
    const parts = pathname.split('/');
    const id = parts[4];
    const action = parts[5];

    if (req.method === 'POST' && action === 'copy') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const bodyObj = bodyData ? JSON.parse(bodyData) : {};
          const copyRes = await makeMatonRequest(apiKey, `/google-drive/drive/v3/files/${id}/copy`, 'POST', bodyObj);
          res.status(copyRes.status).json(copyRes.body);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
    } else if (req.method === 'PATCH' && !action) {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const bodyObj = bodyData ? JSON.parse(bodyData) : {};
          const patchRes = await makeMatonRequest(apiKey, `/google-drive/drive/v3/files/${id}`, 'PATCH', bodyObj);
          res.status(patchRes.status).json(patchRes.body);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
    } else if (req.method === 'DELETE' && !action) {
      try {
        const delRes = await makeMatonRequest(apiKey, `/google-drive/drive/v3/files/${id}`, 'DELETE');
        res.status(delRes.status).json(delRes.body || {});
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else if (req.method === 'GET' && action === 'download') {
      try {
        const name = searchParams.get('name') || 'file';
        const mimeType = searchParams.get('mimeType') || '';
        const inline = searchParams.get('inline') === 'true';
        
        if (mimeType.includes('application/vnd.google-apps.')) {
          let exportMime = 'application/pdf';
          let extension = '.pdf';
          if (!inline) {
            if (mimeType.includes('document')) {
              exportMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
              extension = '.docx';
            } else if (mimeType.includes('spreadsheet')) {
              exportMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
              extension = '.xlsx';
            } else if (mimeType.includes('presentation')) {
              exportMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
              extension = '.pptx';
            }
          }
          const filename = name.endsWith(extension) ? name : name + extension;
          const exportUrl = `/google-drive/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}`;
          streamMatonDownload(apiKey, exportUrl, res, filename, exportMime, inline);
        } else {
          const downloadUrl = `/google-drive/drive/v3/files/${id}?alt=media`;
          streamMatonDownload(apiKey, downloadUrl, res, name, mimeType, inline);
        }
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  } else if (pathname === '/api/maton/apikey/status') {
    if (req.method === 'GET') {
      res.status(200).json({
        configured: !!apiKey,
        preview: apiKey ? '...' + apiKey.slice(-4) : ''
      });
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/maton/apikey') {
    if (req.method === 'POST') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', () => {
        try {
          const bodyObj = JSON.parse(bodyData);
          if (!bodyObj.apiKey || !bodyObj.apiKey.trim()) {
            res.status(400).json({ error: 'API Key is required' });
            return;
          }
          const newKey = bodyObj.apiKey.trim();
          
          const dotenvPath = path.join(process.cwd(), '.env');
          try {
            let content = '';
            if (fs.existsSync(dotenvPath)) {
              content = fs.readFileSync(dotenvPath, 'utf8');
            }
            let lines = content.split(/\r?\n/);
            let updated = false;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].trim().startsWith('MATON_API_KEY=')) {
                lines[i] = `MATON_API_KEY=${newKey}`;
                updated = true;
                break;
              }
            }
            if (!updated) {
              lines.push(`MATON_API_KEY=${newKey}`);
            }
            fs.writeFileSync(dotenvPath, lines.join('\n'), 'utf8');
          } catch(e) {}
          
          res.status(200).json({ success: true });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/maton/connections') {
    if (req.method === 'GET') {
      try {
        if (!apiKey) {
          res.status(401).json({ error: 'MATON_API_KEY is not configured.' });
          return;
        }
        const options = {
          hostname: 'ctrl.maton.ai',
          port: 443,
          path: '/connections',
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        };

        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        apiReq.on('error', err => {
          res.status(500).json({ error: err.message });
        });
        apiReq.end();
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/maton/searchconsole/sites') {
    if (req.method === 'GET') {
      try {
        const result = await makeMatonRequest(apiKey, '/google-search-console/webmasters/v3/sites');
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/maton/searchconsole/performance') {
    if (req.method === 'POST') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const bodyObj = bodyData ? JSON.parse(bodyData) : {};
          const { siteUrl, startDate, endDate, dimensions, rowLimit } = bodyObj;
          if (!siteUrl) {
            res.status(400).json({ error: 'siteUrl is required' });
            return;
          }
          const payload = {
            startDate: startDate,
            endDate: endDate,
            dimensions: dimensions || ['query'],
            rowLimit: rowLimit || 100
          };
          const targetUrl = `/google-search-console/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
          const result = await makeMatonRequest(apiKey, targetUrl, 'POST', payload);
          res.status(result.status).json(result.body);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname === '/api/maton/analytics/accounts') {
    if (req.method === 'GET') {
      try {
        const result = await makeMatonRequest(apiKey, '/google-analytics-admin/v1alpha/accounts');
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(405).end('Method Not Allowed');
    }
  } else if (pathname.startsWith('/api/emails/')) {
    const parts = pathname.split('/');
    const id = parts[3];
    const isTrashAction = parts[4] === 'trash';

    if (req.method === 'POST' && isTrashAction) {
      try {
        const trashRes = await makeMatonRequest(apiKey, `/google-mail/gmail/v1/users/me/messages/${id}/trash`, 'POST');
        res.status(trashRes.status).json(trashRes.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else if (req.method === 'DELETE' && !isTrashAction) {
      try {
        const delRes = await makeMatonRequest(apiKey, `/google-mail/gmail/v1/users/me/messages/${id}`, 'DELETE');
        res.status(delRes.status).json(delRes.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else if (req.method === 'GET' && !isTrashAction) {
      try {
        if (emailDetailsCache[id] && (emailDetailsCache[id].html || emailDetailsCache[id].text)) {
          res.status(200).json(emailDetailsCache[id]);
          return;
        }

        const detailRes = await makeMatonRequest(apiKey, `/google-mail/gmail/v1/users/me/messages/${id}`);
        if (detailRes.status !== 200) {
          res.status(detailRes.status).json(detailRes.body);
          return;
        }

        const payload = detailRes.body.payload || {};
        const headers = payload.headers || [];
        const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
        const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

        const parsedContent = parseMessageParts(payload);

        if (!parsedContent.text && !parsedContent.html && payload.body && payload.body.data) {
          const rawBody = Buffer.from(payload.body.data, 'base64url').toString('utf8');
          if (payload.mimeType === 'text/html') {
            parsedContent.html = rawBody;
          } else {
            parsedContent.text = rawBody;
          }
        }

        const detailObj = {
          id: id,
          subject: subjectHeader ? subjectHeader.value : '(No Subject)',
          from: fromHeader ? fromHeader.value : '(Unknown Sender)',
          date: dateHeader ? dateHeader.value : '(No Date)',
          snippet: detailRes.body.snippet || '',
          text: parsedContent.text,
          html: parsedContent.html
        };

        emailDetailsCache[id] = detailObj;
        saveEmailDetailsCache();

        res.status(200).json(detailObj);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  } else {
    res.status(404).end('Not Found');
  }
};
