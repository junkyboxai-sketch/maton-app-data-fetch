const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = 3000;
const dotenvPath = 'C:\\OpenClaw\\.env';

function loadEnv() {
  if (!fs.existsSync(dotenvPath)) return {};
  const content = fs.readFileSync(dotenvPath, 'utf8');
  const env = {};
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    env[key] = val;
  });
  return env;
}

const env = loadEnv();
let apiKey = env.MATON_API_KEY;

if (!apiKey) {
  console.warn('[WARNING] MATON_API_KEY not found in .env. Please configure it inside the web portal settings.');
}

// Persistent ID-based cache for email details
const emailCachePath = 'C:\\OpenClaw\\email_details_cache.json';
let emailDetailsCache = {};
try {
  if (fs.existsSync(emailCachePath)) {
    emailDetailsCache = JSON.parse(fs.readFileSync(emailCachePath, 'utf8'));
    console.log(`[INFO] Loaded ${Object.keys(emailDetailsCache).length} cached email details from disk.`);
  }
} catch (err) {
  console.warn('[WARNING] Failed to load email details cache:', err.message);
}

function saveEmailDetailsCache() {
  try {
    const dir = path.dirname(emailCachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(emailCachePath, JSON.stringify(emailDetailsCache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[WARNING] Failed to save email details cache:', err.message);
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

function makeMatonRequest(urlPath, method = 'GET', bodyObj = null) {
  return new Promise((resolve, reject) => {
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

function streamMatonDownload(urlPath, res, filename, mimeType, inline = false) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // Extract API key dynamically from headers or query parameters if sent
  const headerKey = req.headers['authorization']?.startsWith('Bearer ') 
    ? req.headers['authorization'].substring(7).trim() 
    : (req.headers['x-maton-api-key'] || url.searchParams.get('apiKey'));
  if (headerKey) {
    apiKey = headerKey;
  }
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/styles.css') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(fs.readFileSync(path.join(__dirname, 'styles.css')));
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/app.js') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(fs.readFileSync(path.join(__dirname, 'app.js')));
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/emails/labels') {
    if (req.method === 'GET') {
      try {
        console.log('API Request: Fetching Gmail labels list...');
        const result = await makeMatonRequest('/google-mail/gmail/v1/users/me/labels');
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/emails') {
    if (req.method === 'GET') {
      try {
        const category = url.searchParams.get('category') || 'inbox';
        const month = url.searchParams.get('month') || '';
        const bypassCache = url.searchParams.get('refresh') === 'true';

        const cacheKey = `emails_${category}_${month}`;
        const cached = getCachedData(cacheKey, bypassCache);
        if (cached) {
          console.log(`[CACHE HIT] Serving emails for key "${cacheKey}"...`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached));
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

        console.log(`API Request: Fetching list of messages with query: "${q}"...`);
        const listRes = await makeMatonRequest(`/google-mail/gmail/v1/users/me/messages?maxResults=40&includeSpamTrash=true&q=${encodeURIComponent(q)}`);
        if (listRes.status !== 200) {
          res.writeHead(listRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(listRes.body));
          return;
        }

        const messages = listRes.body.messages || [];
        
        let hasNewDetails = false;
        // Fetch details in parallel
        const emailList = await Promise.all(
          messages.slice(0, 40).map(async (msg) => {
            try {
              if (emailDetailsCache[msg.id] && emailDetailsCache[msg.id].subject) {
                return emailDetailsCache[msg.id];
              }

              const detailRes = await makeMatonRequest(`/google-mail/gmail/v1/users/me/messages/${msg.id}`);
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
              console.error(`Error fetching detail for message ${msg.id}:`, err.message);
            }
            return null;
          })
        );

        const finalEmailList = emailList.filter(email => email !== null);
        if (hasNewDetails) {
          saveEmailDetailsCache();
        }

        setCachedData(cacheKey, finalEmailList);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalEmailList));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/drive/shared') {
    if (req.method === 'GET') {
      try {
        const dataPath = path.join(__dirname, 'shared_files.json');
        if (fs.existsSync(dataPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(fs.readFileSync(dataPath));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Shared files list not found' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/drive/files') {
    if (req.method === 'GET') {
      try {
        const parent = url.searchParams.get('parent') || '';
        const trashed = url.searchParams.get('trashed') === 'true';
        const shared = url.searchParams.get('shared') === 'true';
        const search = url.searchParams.get('search') || '';
        const bypassCache = url.searchParams.get('refresh') === 'true';

        const cacheKey = `drive_${parent}_${trashed}_${shared}_${search}`;
        const cached = getCachedData(cacheKey, bypassCache);
        if (cached) {
          console.log(`[CACHE HIT] Serving drive files for key "${cacheKey}"...`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached));
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
        console.log(`API Request: Fetching files with query: "${q}"...`);

        const fields = 'nextPageToken,files(id,name,mimeType,owners,createdTime,webViewLink,parents,size)';
        const driveUrl = `/google-drive/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=100&fields=${encodeURIComponent(fields)}`;
        
        const result = await makeMatonRequest(driveUrl);
        
        if (result.status === 200) {
          setCachedData(cacheKey, result.body);
        }

        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/drive/sync') {
    if (req.method === 'POST') {
      try {
        console.log('API Request: Syncing shared files from Maton...');
        const fields = 'nextPageToken,files(id,name,mimeType,owners,createdTime,webViewLink)';
        let allFiles = [];
        let pageToken = null;
        let success = true;

        do {
          let driveUrl = `/google-drive/drive/v3/files?q=sharedWithMe%3Dtrue&pageSize=100&fields=${encodeURIComponent(fields)}`;
          if (pageToken) {
            driveUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
          }

          const result = await makeMatonRequest(driveUrl);
          if (result.status !== 200) {
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.body));
            success = false;
            break;
          }

          if (result.body.files) {
            allFiles.push(...result.body.files);
          }
          pageToken = result.body.nextPageToken;
        } while (pageToken);

        if (success) {
          fs.writeFileSync(
            path.join(__dirname, 'shared_files.json'),
            JSON.stringify(allFiles, null, 2),
            'utf8'
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(allFiles));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname.startsWith('/api/drive/files/')) {
    const parts = url.pathname.split('/');
    const id = parts[4];
    const action = parts[5];

    if (req.method === 'POST' && action === 'copy') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const bodyObj = bodyData ? JSON.parse(bodyData) : {};
          console.log(`API Request: Copying file ${id} with name: ${bodyObj.name}...`);
          
          const copyRes = await makeMatonRequest(`/google-drive/drive/v3/files/${id}/copy`, 'POST', bodyObj);
          res.writeHead(copyRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(copyRes.body));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.method === 'PATCH' && !action) {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const bodyObj = bodyData ? JSON.parse(bodyData) : {};
          console.log(`API Request: Renaming file ${id} to: ${bodyObj.name}...`);
          
          const patchRes = await makeMatonRequest(`/google-drive/drive/v3/files/${id}`, 'PATCH', bodyObj);
          res.writeHead(patchRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(patchRes.body));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.method === 'DELETE' && !action) {
      try {
        console.log(`API Request: Deleting file ${id}...`);
        const delRes = await makeMatonRequest(`/google-drive/drive/v3/files/${id}`, 'DELETE');
        res.writeHead(delRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(delRes.body || {}));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (req.method === 'GET' && action === 'download') {
      try {
        const name = url.searchParams.get('name') || 'file';
        const mimeType = url.searchParams.get('mimeType') || '';
        const inline = url.searchParams.get('inline') === 'true';
        
        console.log(`API Request: Downloading file ${id} (MimeType: ${mimeType}, Inline: ${inline})...`);

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
          streamMatonDownload(exportUrl, res, filename, exportMime, inline);
        } else {
          const downloadUrl = `/google-drive/drive/v3/files/${id}?alt=media`;
          streamMatonDownload(downloadUrl, res, name, mimeType, inline);
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/maton/apikey/status') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: !!apiKey,
        preview: apiKey ? '...' + apiKey.slice(-4) : ''
      }));
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/maton/apikey') {
    if (req.method === 'POST') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', () => {
        try {
          const bodyObj = JSON.parse(bodyData);
          if (!bodyObj.apiKey || !bodyObj.apiKey.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'API Key is required' }));
            return;
          }
          
          const newKey = bodyObj.apiKey.trim();
          
          // Save to .env
          let content = '';
          const dir = path.dirname(dotenvPath);
          if (!fs.existsSync(dir)) {
            try {
              fs.mkdirSync(dir, { recursive: true });
            } catch(e) {}
          }

          if (fs.existsSync(dotenvPath)) {
            try {
              content = fs.readFileSync(dotenvPath, 'utf8');
            } catch(e) {}
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
          
          try {
            fs.writeFileSync(dotenvPath, lines.join('\n'), 'utf8');
          } catch (writeErr) {
            console.warn('[WARNING] Failed to write API key to C:\\OpenClaw\\.env:', writeErr.message);
            try {
              fs.writeFileSync(path.join(__dirname, '.env'), lines.join('\n'), 'utf8');
            } catch (localErr) {
              console.warn('[WARNING] Failed to write API key to local .env fallback:', localErr.message);
            }
          }
          
          // Update in-memory
          apiKey = newKey;
          console.log('[INFO] MATON_API_KEY successfully updated dynamically.');
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/maton/connections') {
    if (req.method === 'GET') {
      try {
        console.log('API Request: Fetching all Maton connections...');
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
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/maton/searchconsole/sites') {
    if (req.method === 'GET') {
      try {
        console.log('API Request: Fetching Search Console sites...');
        const result = await makeMatonRequest('/google-search-console/webmasters/v3/sites');
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/maton/searchconsole/performance') {
    if (req.method === 'POST') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const bodyObj = bodyData ? JSON.parse(bodyData) : {};
          const { siteUrl, startDate, endDate, dimensions, rowLimit } = bodyObj;
          if (!siteUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'siteUrl is required' }));
            return;
          }
          const payload = {
            startDate: startDate,
            endDate: endDate,
            dimensions: dimensions || ['query'],
            rowLimit: rowLimit || 100
          };
          console.log(`API Request: Fetching Search Console performance for ${siteUrl}...`);
          const targetUrl = `/google-search-console/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
          const result = await makeMatonRequest(targetUrl, 'POST', payload);
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.body));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname === '/api/maton/analytics/accounts') {
    if (req.method === 'GET') {
      try {
        console.log('API Request: Fetching Google Analytics accounts...');
        const result = await makeMatonRequest('/google-analytics-admin/v1alpha/accounts');
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else if (url.pathname.startsWith('/api/emails/')) {
    const parts = url.pathname.split('/');
    const id = parts[3];
    const isTrashAction = parts[4] === 'trash';

    if (req.method === 'POST' && isTrashAction) {
      try {
        console.log(`API Request: Trashing email ${id}...`);
        const trashRes = await makeMatonRequest(`/google-mail/gmail/v1/users/me/messages/${id}/trash`, 'POST');
        res.writeHead(trashRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(trashRes.body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (req.method === 'DELETE' && !isTrashAction) {
      try {
        console.log(`API Request: Permanently deleting email ${id}...`);
        const delRes = await makeMatonRequest(`/google-mail/gmail/v1/users/me/messages/${id}`, 'DELETE');
        res.writeHead(delRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(delRes.body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (req.method === 'GET' && !isTrashAction) {
      try {
        console.log(`API Request: Fetching email detail for ${id}...`);
        if (emailDetailsCache[id] && (emailDetailsCache[id].html || emailDetailsCache[id].text)) {
          console.log(`[CACHE HIT] Serving full email body for ${id}...`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(emailDetailsCache[id]));
          return;
        }

        const detailRes = await makeMatonRequest(`/google-mail/gmail/v1/users/me/messages/${id}`);
        if (detailRes.status !== 200) {
          res.writeHead(detailRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(detailRes.body));
          return;
        }

        const payload = detailRes.body.payload || {};
        const headers = payload.headers || [];
        const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
        const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

        const parsedContent = parseMessageParts(payload);

        // Fallback to top level body if no parts exist
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(detailObj));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`[INFO] Server running at http://localhost:${PORT}`);
});
