let allEmails = [];
let activeFilter = 'inbox';
let currentEmailId = null;

let currentWorkspace = 'mail'; // 'mail' or 'drive', 'connections'
let activeDriveFilter = 'mydrive'; // 'mydrive', 'shared', 'folders', 'files', 'trash'
let allDriveFiles = [];
let driveNavStack = []; // stores { id, name } for folder hierarchy
let currentDriveFile = null;

let activeConnectionsFilter = 'all-connections'; // 'all-connections', 'search-console', 'analytics'
let matonConnections = [];
let isRealtimeSyncEnabled = true;
let realtimeSyncInterval = null;

// Search Console Replica variables
let activeScFilter = 'sc-performance'; // 'sc-performance', 'sc-pages', 'sc-countries'
let scSites = [];
let scCurrentSite = '';
let scChartInstance = null;
let scActiveMetrics = new Set(['clicks', 'impressions', 'ctr', 'position']);
let scPerformanceData = {
  date: [],
  queries: [],
  pages: [],
  countries: [],
  devices: []
};
let scActiveTab = 'queries';
let scIsInitialized = false;

function makeHeaders(customHeaders = {}) {
  const headers = { ...customHeaders };
  const key = localStorage.getItem('matonApiKey');
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

document.addEventListener('DOMContentLoaded', () => {
  // Initial load
  fetchEmails();
  fetchGmailLabels();

  // Workspace Switchers
  document.getElementById('tab-mail').addEventListener('click', () => switchWorkspace('mail'));
  document.getElementById('tab-drive').addEventListener('click', () => switchWorkspace('drive'));
  document.getElementById('tab-connections').addEventListener('click', () => switchWorkspace('connections'));
  document.getElementById('tab-searchconsole').addEventListener('click', () => switchWorkspace('searchconsole'));

  // Refresh and action buttons
  document.getElementById('refresh-btn').addEventListener('click', () => {
    fetchEmails(true);
    fetchGmailLabels();
  });
  document.getElementById('drive-refresh-btn').addEventListener('click', () => fetchDriveFiles(true));
  document.getElementById('drive-sync-btn').addEventListener('click', syncDriveFiles);
  document.getElementById('connections-refresh-btn').addEventListener('click', fetchConnections);
  document.getElementById('back-btn').addEventListener('click', showListPanel);
  document.getElementById('drive-back-btn').addEventListener('click', showDriveListPanel);
  document.getElementById('month-select').addEventListener('change', () => fetchEmails(true));

  // Preview Action Buttons
  document.getElementById('drive-preview-download-btn').addEventListener('click', () => {
    if (currentDriveFile) {
      downloadDriveFile(currentDriveFile.id, currentDriveFile.name, currentDriveFile.mimeType);
    }
  });

  document.getElementById('drive-preview-rename-btn').addEventListener('click', () => {
    if (currentDriveFile) {
      renameDriveFile(currentDriveFile.id, currentDriveFile.name);
    }
  });

  document.getElementById('drive-preview-delete-btn').addEventListener('click', () => {
    if (currentDriveFile) {
      deleteDriveFile(currentDriveFile.id, currentDriveFile.name);
    }
  });

  // Delete Email
  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!currentEmailId) return;

    const isTrash = activeFilter === 'trash';
    const confirmMsg = isTrash 
      ? 'Are you sure you want to permanently delete this email? This action cannot be undone.'
      : 'Are you sure you want to move this email to Trash?';
      
    if (!confirm(confirmMsg)) return;

    const url = isTrash ? `/api/emails/${currentEmailId}` : `/api/emails/${currentEmailId}/trash`;
    const method = isTrash ? 'DELETE' : 'POST';

    try {
      const btn = document.getElementById('delete-btn');
      btn.disabled = true;
      btn.textContent = 'Deleting...';

      const res = await fetch(url, { method, headers: makeHeaders() });
      const responseData = await res.json().catch(() => ({}));

      btn.disabled = false;
      btn.textContent = '🗑 Delete';

      if (!res.ok) {
        throw new Error(responseData.error?.message || responseData.error || 'Failed to delete');
      }

      showListPanel();
      fetchEmails();
    } catch (e) {
      alert(`Error: ${e.message}\n\nNote: Permanent deletion requires the high-level 'https://mail.google.com/' scope, which is not granted to the current connection.`);
    }
  });

  // Search filter
  document.getElementById('search-input').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    if (currentWorkspace === 'mail') {
      filterAndRender(q);
    } else if (currentWorkspace === 'drive') {
      renderDrive(q);
    } else {
      renderConnections(q);
    }
  });

  // Sidebar navigation for Mail
  document.querySelectorAll('#sidebar-nav-mail .nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('#sidebar-nav-mail .nav-item').forEach(nav => nav.classList.remove('active'));
      document.querySelectorAll('#sidebar-nav-mail-custom-labels .nav-item').forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      activeFilter = item.getAttribute('data-filter');
      
      const titles = {
        inbox: 'Inbox',
        starred: 'Starred',
        sent: 'Sent',
        drafts: 'Drafts',
        trash: 'Trash'
      };
      document.getElementById('panel-title').textContent = titles[activeFilter] || 'Inbox';

      fetchEmails();
    });
  });

  // Sidebar navigation for Drive
  document.querySelectorAll('#sidebar-nav-drive .nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('#sidebar-nav-drive .nav-item').forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      activeDriveFilter = item.getAttribute('data-filter');
      
      const titles = {
        mydrive: 'My Drive',
        shared: 'Shared with me',
        folders: 'Folders',
        files: 'Files',
        trash: 'Trash'
      };
      document.getElementById('drive-panel-title').textContent = titles[activeDriveFilter] || 'My Drive';

      if (activeDriveFilter === 'mydrive' || activeDriveFilter === 'shared' || activeDriveFilter === 'trash') {
        driveNavStack = [];
        fetchDriveFiles();
      } else {
        renderDrive();
      }
    });
  });

  // Sidebar navigation for Connections
  document.querySelectorAll('#sidebar-nav-connections .nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('#sidebar-nav-connections .nav-item').forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      activeConnectionsFilter = item.getAttribute('data-filter');
      
      const titles = {
        'all-connections': 'All Integrations',
        'search-console': 'Search Console Properties',
        'analytics': 'Google Analytics Accounts'
      };
      document.getElementById('connections-panel-title').textContent = titles[activeConnectionsFilter] || 'All Integrations';

      renderConnections();
    });
  });

  // Sidebar navigation for Search Console
  document.querySelectorAll('#sidebar-nav-searchconsole .nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('#sidebar-nav-searchconsole .nav-item').forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      activeScFilter = item.getAttribute('data-filter');
      
      const titles = {
        'sc-performance': 'Search Console Performance',
        'sc-pages': 'Search Console Pages',
        'sc-countries': 'Search Console Countries & Devices'
      };
      document.getElementById('searchconsole-panel-title').textContent = titles[activeScFilter] || 'Search Console';
      
      if (activeScFilter === 'sc-performance') {
        switchScTableTab('queries');
      } else if (activeScFilter === 'sc-pages') {
        switchScTableTab('pages');
      } else if (activeScFilter === 'sc-countries') {
        switchScTableTab('countries');
      }
    });
  });

  initRealtimeSync();
  initSettingsModal();
});

function switchWorkspace(workspace) {
  if (workspace === currentWorkspace) return;
  currentWorkspace = workspace;

  const mailTab = document.getElementById('tab-mail');
  const driveTab = document.getElementById('tab-drive');
  const connectionsTab = document.getElementById('tab-connections');
  const searchConsoleTab = document.getElementById('tab-searchconsole');
  
  const mailNav = document.getElementById('sidebar-nav-mail');
  const driveNav = document.getElementById('sidebar-nav-drive');
  const connectionsNav = document.getElementById('sidebar-nav-connections');
  const searchConsoleNav = document.getElementById('sidebar-nav-searchconsole');
  
  const actionBtn = document.getElementById('sidebar-action-btn');
  const searchInput = document.getElementById('search-input');
  
  const mailPanel = document.getElementById('email-list-panel');
  const mailDetailPanel = document.getElementById('email-detail-panel');
  const drivePanel = document.getElementById('drive-list-panel');
  const driveDetailPanel = document.getElementById('drive-detail-panel');
  const connectionsPanel = document.getElementById('connections-list-panel');
  const searchConsolePanel = document.getElementById('searchconsole-panel');
  
  const logoIcon = document.getElementById('app-logo-icon');
  const logoTitle = document.getElementById('app-logo-title');

  searchInput.value = '';

  // Reset tab active classes
  mailTab.classList.remove('active');
  driveTab.classList.remove('active');
  connectionsTab.classList.remove('active');
  searchConsoleTab.classList.remove('active');

  // Hide all sidebars
  mailNav.style.display = 'none';
  driveNav.style.display = 'none';
  connectionsNav.style.display = 'none';
  searchConsoleNav.style.display = 'none';

  // Hide all panels
  mailPanel.style.display = 'none';
  mailDetailPanel.style.display = 'none';
  drivePanel.style.display = 'none';
  driveDetailPanel.style.display = 'none';
  connectionsPanel.style.display = 'none';
  searchConsolePanel.style.display = 'none';

  if (workspace === 'mail') {
    mailTab.classList.add('active');
    mailNav.style.display = 'flex';
    actionBtn.textContent = '＋ Compose';
    actionBtn.style.display = 'block';
    logoIcon.textContent = '✉';
    logoTitle.textContent = 'MatonMail';
    searchInput.placeholder = 'Search emails by subject, sender, or snippet...';
    mailPanel.style.display = 'flex';
    fetchEmails();
  } else if (workspace === 'drive') {
    driveTab.classList.add('active');
    driveNav.style.display = 'flex';
    actionBtn.style.display = 'none';
    logoIcon.textContent = '📁';
    logoTitle.textContent = 'MatonDrive';
    searchInput.placeholder = 'Search shared files and folders...';
    drivePanel.style.display = 'flex';
    fetchDriveFiles();
  } else if (workspace === 'connections') {
    connectionsTab.classList.add('active');
    connectionsNav.style.display = 'flex';
    actionBtn.style.display = 'none';
    logoIcon.textContent = '🔌';
    logoTitle.textContent = 'MatonPortal';
    searchInput.placeholder = 'Search integrations, sites, properties...';
    connectionsPanel.style.display = 'flex';
    fetchConnections();
  } else if (workspace === 'searchconsole') {
    searchConsoleTab.classList.add('active');
    searchConsoleNav.style.display = 'flex';
    actionBtn.style.display = 'none';
    logoIcon.textContent = '🔍';
    logoTitle.textContent = 'MatonConsole';
    searchInput.placeholder = 'Filter search performance...';
    searchConsolePanel.style.display = 'flex';
    initSearchConsoleReplica();
  }
}

function showListPanel() {
  document.getElementById('email-detail-panel').style.display = 'none';
  document.getElementById('email-list-panel').style.display = 'flex';
}

function showDetailPanel() {
  document.getElementById('email-list-panel').style.display = 'none';
  document.getElementById('email-detail-panel').style.display = 'flex';
}

async function fetchEmails(bypassCache = false) {
  const loading = document.getElementById('loading-state');
  const empty = document.getElementById('empty-state');
  const list = document.getElementById('email-list');
  const monthSelect = document.getElementById('month-select');

  loading.style.display = 'flex';
  empty.style.display = 'none';
  list.innerHTML = '';
  showListPanel();

  const month = monthSelect.value;
  let url = `/api/emails?category=${activeFilter}&month=${month}`;
  if (bypassCache) {
    url += '&refresh=true';
  }

  try {
    const res = await fetch(url, { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed to load emails');
    
    allEmails = await res.json();
    loading.style.display = 'none';

    if (activeFilter === 'inbox') {
      document.getElementById('inbox-count').textContent = allEmails.length;
    }
    filterAndRender();
  } catch (e) {
    loading.style.display = 'none';
    empty.style.display = 'flex';
    empty.querySelector('p').textContent = 'Error connecting to Gmail: ' + e.message;
  }
}

function filterAndRender(searchQuery = '') {
  const list = document.getElementById('email-list');
  const empty = document.getElementById('empty-state');
  list.innerHTML = '';

  let filtered = allEmails;

  // Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(email => 
      email.subject.toLowerCase().includes(q) || 
      email.from.toLowerCase().includes(q) || 
      email.snippet.toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  filtered.forEach(email => {
    const item = document.createElement('div');
    item.className = 'email-item';
    
    // Parse Date
    let dateStr = email.date;
    try {
      const d = new Date(email.date);
      dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch(err) {}

    // Extract sender name
    const matches = email.from.match(/^"?([^"<]+)"?\s*/);
    const senderName = matches ? matches[1] : email.from;

    item.innerHTML = `
      <div class="sender">${senderName}</div>
      <div class="content-wrap">
        <span class="subject">${email.subject}</span>
        <span class="snippet"> — ${email.snippet}</span>
      </div>
      <div class="date">${dateStr}</div>
    `;

    item.addEventListener('click', () => openEmail(email.id));
    list.appendChild(item);
  });
}

async function openEmail(id) {
  currentEmailId = id;
  const subject = document.getElementById('detail-subject');
  const from = document.getElementById('detail-from');
  const date = document.getElementById('detail-date');
  const body = document.getElementById('detail-body');
  const avatar = document.getElementById('detail-avatar');

  subject.textContent = 'Loading...';
  from.textContent = '';
  date.textContent = '';
  body.innerHTML = '<div class="spinner"></div>';
  showDetailPanel();

  try {
    const res = await fetch(`/api/emails/${id}`, { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed to load email details');
    
    const email = await res.json();
    
    subject.textContent = email.subject || '(No Subject)';
    from.textContent = email.from || '(Unknown Sender)';
    date.textContent = email.date || '(No Date)';
    
    // Set Avatar letter
    const matches = email.from.match(/^"?([^"<]+)"?\s*/);
    const senderName = matches ? matches[1] : email.from;
    avatar.textContent = senderName.charAt(0).toUpperCase();

    // Use iframe to render HTML email safely
    const iframe = document.createElement('iframe');
    body.innerHTML = '';
    body.appendChild(iframe);
    
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(email.html || `<div style="font-family: sans-serif; white-space: pre-wrap; color: #333;">${email.text || email.snippet}</div>`);
    doc.close();
  } catch (e) {
    body.innerHTML = `<p style="color: red; padding: 20px;">Error loading email: ${e.message}</p>`;
  }
}

// Drive Specific Functions
function showDriveListPanel() {
  document.getElementById('drive-detail-panel').style.display = 'none';
  document.getElementById('drive-list-panel').style.display = 'flex';
}

function showDriveDetailPanel() {
  document.getElementById('drive-list-panel').style.display = 'none';
  document.getElementById('drive-detail-panel').style.display = 'flex';
}

// Shared helper to get file type icon
const getFileIcon = (mimeType = '') => {
  if (mimeType.includes('spreadsheet')) return '📊';
  if (mimeType.includes('document')) return '📄';
  if (mimeType.includes('presentation')) return '🎴';
  if (mimeType.includes('folder')) return '📁';
  return '📄';
};

async function fetchDriveFiles(bypassCache = false) {
  const foldersGrid = document.getElementById('folders-grid');
  const filesList = document.getElementById('drive-files-list');
  
  foldersGrid.innerHTML = '<div class="spinner" style="margin: 20px auto; grid-column: 1/-1;"></div>';
  filesList.innerHTML = '<tr><td colspan="4" style="text-align: center;"><div class="spinner" style="margin: 20px auto;"></div></td></tr>';
  showDriveListPanel();

  let url = '/api/drive/files';
  const params = [];
  if (activeDriveFilter === 'trash') {
    params.push('trashed=true');
  } else {
    if (driveNavStack.length > 0) {
      params.push(`parent=${encodeURIComponent(driveNavStack[driveNavStack.length - 1].id)}`);
    } else {
      if (activeDriveFilter === 'mydrive') {
        params.push('parent=root');
      } else {
        params.push('shared=true');
      }
    }
  }

  if (bypassCache) {
    params.push('refresh=true');
  }

  if (params.length > 0) {
    url += '?' + params.join('&');
  }

  try {
    const res = await fetch(url, { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed to load files');
    
    const data = await res.json();
    allDriveFiles = data.files || [];
    renderDrive();
    renderBreadcrumbs();
  } catch (e) {
    foldersGrid.innerHTML = `<p style="color: red; padding: 10px; grid-column: 1/-1;">Error loading Google Drive: ${e.message}</p>`;
    filesList.innerHTML = `<tr><td colspan="4" style="text-align: center; color: red;">Error: ${e.message}</td></tr>`;
  }
}

function renderBreadcrumbs() {
  const container = document.getElementById('drive-breadcrumbs');
  if (!container) return;
  
  container.innerHTML = '';
  
  // Root breadcrumb
  const rootItem = document.createElement('span');
  rootItem.className = 'breadcrumb-item';
  if (activeDriveFilter === 'trash') {
    rootItem.textContent = 'Trash';
  } else if (activeDriveFilter === 'mydrive') {
    rootItem.textContent = 'My Drive';
  } else {
    rootItem.textContent = 'Shared with me';
  }
  
  if (driveNavStack.length === 0) {
    rootItem.classList.add('active');
  } else {
    rootItem.addEventListener('click', () => {
      driveNavStack = [];
      fetchDriveFiles();
    });
  }
  container.appendChild(rootItem);
  
  // Folders in stack
  driveNavStack.forEach((folder, idx) => {
    const separator = document.createElement('span');
    separator.className = 'breadcrumb-separator';
    separator.textContent = ' > ';
    container.appendChild(separator);
    
    const item = document.createElement('span');
    item.className = 'breadcrumb-item';
    item.textContent = folder.name;
    
    if (idx === driveNavStack.length - 1) {
      item.classList.add('active');
    } else {
      item.addEventListener('click', () => {
        driveNavStack = driveNavStack.slice(0, idx + 1);
        fetchDriveFiles();
      });
    }
    container.appendChild(item);
  });
}

function renderDrive(searchQuery = '') {
  const foldersGrid = document.getElementById('folders-grid');
  const filesList = document.getElementById('drive-files-list');
  const foldersSection = document.getElementById('drive-folders-section');
  const filesSection = document.getElementById('drive-files-section-container');

  foldersGrid.innerHTML = '';
  filesList.innerHTML = '';

  let filtered = allDriveFiles;

  // Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(item => {
      const nameMatch = item.name && item.name.toLowerCase().includes(q);
      const ownerMatch = item.owners && item.owners.length > 0 && item.owners[0].displayName.toLowerCase().includes(q);
      return nameMatch || ownerMatch;
    });
  }

  const folders = filtered.filter(item => item.mimeType === 'application/vnd.google-apps.folder');
  const files = filtered.filter(item => item.mimeType !== 'application/vnd.google-apps.folder');

  // Render Folders Grid
  if (activeDriveFilter === 'files') {
    foldersSection.style.display = 'none';
  } else {
    foldersSection.style.display = 'block';
    
    const foldersToRender = (activeDriveFilter === 'all' && driveNavStack.length === 0) ? folders.slice(0, 8) : folders;
    
    if (foldersToRender.length === 0) {
      foldersGrid.innerHTML = '<p style="color: var(--text-secondary); font-size: 13px; padding: 10px;">No folders found.</p>';
    } else {
      foldersToRender.forEach(folder => {
        const card = document.createElement('div');
        card.className = 'folder-card';
        const ownerName = folder.owners && folder.owners.length > 0 ? folder.owners[0].displayName : 'Shared';
        
        card.innerHTML = `
          <span class="folder-icon">📁</span>
          <div class="folder-info" style="flex: 1; min-width: 0;">
            <span class="folder-name" title="${folder.name}">${folder.name}</span>
            <span class="folder-owner">${ownerName}</span>
          </div>
          <div class="folder-actions" style="display: flex; gap: 4px; flex-shrink: 0;">
            <button class="drive-action-btn rename-btn" title="Rename" style="padding: 4px 6px;">✏️</button>
            <button class="drive-action-btn delete-btn delete" title="Delete" style="padding: 4px 6px;">🗑</button>
          </div>
        `;

        card.addEventListener('click', () => {
          driveNavStack.push({ id: folder.id, name: folder.name });
          fetchDriveFiles();
        });

        card.querySelector('.rename-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          renameDriveFile(folder.id, folder.name);
        });

        card.querySelector('.delete-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          deleteDriveFile(folder.id, folder.name);
        });

        foldersGrid.appendChild(card);
      });
    }
  }

  // Render Files Table
  if (activeDriveFilter === 'folders') {
    filesSection.style.display = 'none';
  } else {
    filesSection.style.display = 'block';
    
    if (files.length === 0) {
      filesList.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 20px;">No files found.</td></tr>';
    } else {
      files.forEach(file => {
        const tr = document.createElement('tr');
        const icon = getFileIcon(file.mimeType);
        const ownerName = file.owners && file.owners.length > 0 ? file.owners[0].displayName : 'Shared';
        
        let dateStr = '(Unknown)';
        if (file.createdTime) {
          try {
            dateStr = new Date(file.createdTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          } catch(e) {}
        }

        tr.innerHTML = `
          <td>
            <div class="drive-item-name" title="${file.name}">
              <span class="drive-item-icon">${icon}</span>
              <span>${file.name}</span>
            </div>
          </td>
          <td><span class="drive-item-owner">${ownerName}</span></td>
          <td><span class="drive-item-date">${dateStr}</span></td>
          <td style="text-align: right;">
            <div class="drive-actions">
              <button class="drive-action-btn open-btn accent" title="Open File">Open</button>
              <button class="drive-action-btn download-btn accent" title="Download">⬇️</button>
              <button class="drive-action-btn copy-btn" title="Make a Copy">📋</button>
              <button class="drive-action-btn rename-btn" title="Rename">✏️</button>
              <button class="drive-action-btn delete-btn delete" title="Delete">🗑</button>
            </div>
          </td>
        `;

        tr.addEventListener('dblclick', () => openDriveFile(file));
        tr.querySelector('.open-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          openDriveFile(file);
        });
        tr.querySelector('.download-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          downloadDriveFile(file.id, file.name, file.mimeType);
        });
        tr.querySelector('.copy-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          copyDriveFile(file.id, file.name);
        });
        tr.querySelector('.rename-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          renameDriveFile(file.id, file.name);
        });
        tr.querySelector('.delete-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          deleteDriveFile(file.id, file.name);
        });

        filesList.appendChild(tr);
      });
    }
  }
}

function openDriveFile(file) {
  currentDriveFile = file;
  
  const detailName = document.getElementById('drive-detail-name');
  const detailOwner = document.getElementById('drive-detail-owner');
  const detailDate = document.getElementById('drive-detail-date');
  const detailBody = document.getElementById('drive-detail-body');
  const detailAvatar = document.getElementById('drive-detail-avatar');
  
  detailName.textContent = file.name || 'File';
  
  const ownerName = file.owners && file.owners.length > 0 ? file.owners[0].displayName : 'Shared';
  detailOwner.textContent = ownerName;
  detailAvatar.textContent = getFileIcon(file.mimeType);
  
  let dateStr = '(Unknown)';
  if (file.createdTime) {
    try {
      dateStr = new Date(file.createdTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch(e) {}
  }
  detailDate.textContent = dateStr;
  
  detailBody.innerHTML = '<div class="spinner"></div>';
  showDriveDetailPanel();
  
  const mime = file.mimeType || '';
  const key = localStorage.getItem('matonApiKey') || '';
  const fileUrl = `/api/drive/files/${file.id}/download?inline=true&name=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.mimeType)}&apiKey=${encodeURIComponent(key)}`;
  
  if (mime.startsWith('image/')) {
    detailBody.innerHTML = `<img src="${fileUrl}" class="drive-preview-image" alt="${file.name}">`;
  } else if (mime.startsWith('audio/')) {
    detailBody.innerHTML = `<audio src="${fileUrl}" class="drive-preview-audio" controls autoplay></audio>`;
  } else if (mime.startsWith('video/')) {
    detailBody.innerHTML = `<video src="${fileUrl}" class="drive-preview-video" controls autoplay></video>`;
  } else if (
    mime === 'application/pdf' || 
    mime.startsWith('text/') || 
    mime.includes('application/vnd.google-apps.document') || 
    mime.includes('application/vnd.google-apps.spreadsheet') || 
    mime.includes('application/vnd.google-apps.presentation')
  ) {
    detailBody.innerHTML = `<iframe src="${fileUrl}" class="drive-preview-iframe"></iframe>`;
  } else {
    detailBody.innerHTML = `
      <div class="drive-preview-fallback">
        <span class="drive-preview-fallback-icon">${getFileIcon(file.mimeType)}</span>
        <span class="drive-preview-fallback-text">In-app preview not supported for this file type</span>
        <button class="compose-btn" id="drive-preview-fallback-download-btn">⬇️ Download File</button>
      </div>
    `;
    document.getElementById('drive-preview-fallback-download-btn').addEventListener('click', () => {
      downloadDriveFile(file.id, file.name, file.mimeType);
    });
  }
}

// Drive Interactive Action Operations
async function syncDriveFiles() {
  const syncBtn = document.getElementById('drive-sync-btn');
  const oldText = syncBtn.textContent;
  syncBtn.disabled = true;
  syncBtn.textContent = '⚡ Syncing...';

  try {
    const res = await fetch('/api/drive/sync', { method: 'POST', headers: makeHeaders() });
    if (!res.ok) throw new Error('Sync failed');
    allDriveFiles = await res.json();
    renderDrive();
    alert('Drive files successfully synced and cached!');
  } catch(e) {
    alert('Failed to sync Drive: ' + e.message);
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = oldText;
  }
}

async function copyDriveFile(id, name) {
  const newName = prompt('Enter name for the copied file:', 'Copy of ' + name);
  if (!newName) return;

  try {
    const res = await fetch(`/api/drive/files/${id}/copy`, {
      method: 'POST',
      headers: makeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: newName })
    });
    if (!res.ok) throw new Error('Copy failed');
    alert('File successfully copied!');
    fetchDriveFiles();
  } catch (e) {
    alert('Error copying file: ' + e.message);
  }
}

async function renameDriveFile(id, currentName) {
  const newName = prompt('Enter new name for the item:', currentName);
  if (!newName || newName === currentName) return;

  try {
    const res = await fetch(`/api/drive/files/${id}`, {
      method: 'PATCH',
      headers: makeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: newName })
    });
    if (!res.ok) throw new Error('Rename failed');
    
    if (currentDriveFile && currentDriveFile.id === id) {
      currentDriveFile.name = newName;
      document.getElementById('drive-detail-name').textContent = newName;
    }

    alert('Item successfully renamed!');
    fetchDriveFiles();
  } catch (e) {
    alert('Error renaming item: ' + e.message);
  }
}

async function deleteDriveFile(id, name) {
  if (!confirm(`Are you sure you want to permanently delete "${name}"? This action cannot be undone.`)) return;

  try {
    const res = await fetch(`/api/drive/files/${id}`, {
      method: 'DELETE',
      headers: makeHeaders()
    });
    if (!res.ok) throw new Error('Delete failed');
    
    if (currentDriveFile && currentDriveFile.id === id) {
      showDriveListPanel();
    }

    alert('Item successfully deleted!');
    fetchDriveFiles();
  } catch (e) {
    alert('Error deleting item: ' + e.message);
  }
}

function downloadDriveFile(id, name, mimeType) {
  const key = localStorage.getItem('matonApiKey') || '';
  window.open(`/api/drive/files/${id}/download?name=${encodeURIComponent(name)}&mimeType=${encodeURIComponent(mimeType)}&apiKey=${encodeURIComponent(key)}`, '_blank');
}

// Connections Specific Functions
async function fetchConnections() {
  const content = document.getElementById('connections-content');
  content.innerHTML = '<div class="spinner" style="margin: 40px auto;"></div>';
  
  try {
    const res = await fetch('/api/maton/connections', { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed to load connections');
    const data = await res.json();
    matonConnections = data.connections || [];
    renderConnections();
  } catch (e) {
    content.innerHTML = `<p style="color: red; padding: 20px;">Error loading connections: ${e.message}</p>`;
  }
}

function renderConnections(searchQuery = '') {
  const content = document.getElementById('connections-content');
  content.innerHTML = '';
  
  const q = searchQuery.toLowerCase();
  
  if (activeConnectionsFilter === 'all-connections') {
    const availableApps = [
      { id: 'google-mail', title: 'Google Mail (Gmail)', desc: 'Access, read, organize, send and delete emails.', logo: '✉️' },
      { id: 'google-drive', title: 'Google Drive', desc: 'Manage, view, download, rename and delete files and folders.', logo: '📁' },
      { id: 'google-docs', title: 'Google Docs', desc: 'Create, view, and read documents in-app.', logo: '📄' },
      { id: 'google-sheets', title: 'Google Sheets', desc: 'Read, write, and manage spreadsheets in-app.', logo: '📊' },
      { id: 'google-slides', title: 'Google Slides', desc: 'Create, view, and read presentations in-app.', logo: '🎴' },
      { id: 'google-search-console', title: 'Google Search Console', desc: 'Monitor search traffic and performance for verified sites.', logo: '🔍' },
      { id: 'google-analytics-admin', title: 'Google Analytics', desc: 'Track and analyze website traffic and property admin accounts.', logo: '📈' }
    ];

    let filteredApps = availableApps;
    if (q) {
      filteredApps = availableApps.filter(app => 
        app.title.toLowerCase().includes(q) || 
        app.desc.toLowerCase().includes(q)
      );
    }
    
    if (filteredApps.length === 0) {
      content.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">No integrations found matching your search.</p>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'connections-grid';
    
    filteredApps.forEach(app => {
      // Find matching active or pending connection
      const conn = matonConnections.find(c => c.app === app.id);
      let statusHtml = '';
      let actionBtnHtml = '';
      let metaHtml = '';
      
      if (conn) {
        const isConnected = conn.status === 'ACTIVE';
        if (isConnected) {
          statusHtml = `<span class="status-badge active">Connected</span>`;
          const email = conn.metadata && conn.metadata.email ? conn.metadata.email : 'Active connection';
          metaHtml = `<div class="connection-card-meta">${email}</div>`;
          actionBtnHtml = `<button class="connection-card-btn" onclick="openAppForConnection('${app.id}')">Open Data Viewer</button>`;
        } else {
          statusHtml = `<span class="status-badge pending">Pending</span>`;
          metaHtml = `<div class="connection-card-meta">Awaiting authorization</div>`;
          actionBtnHtml = `<a href="${conn.url}" target="_blank" class="connection-card-btn connect">Connect via OAuth</a>`;
        }
      } else {
        statusHtml = `<span class="status-badge disconnected">Disconnected</span>`;
        actionBtnHtml = `<a href="https://maton.ai" target="_blank" class="connection-card-btn">Setup on Dashboard</a>`;
      }
      
      const card = document.createElement('div');
      card.className = 'connection-card';
      card.innerHTML = `
        <div>
          <div class="connection-card-header">
            <span class="connection-card-logo">${app.logo}</span>
            ${statusHtml}
          </div>
          <div class="connection-card-body">
            <span class="connection-card-title">${app.title}</span>
            <span class="connection-card-desc">${app.desc}</span>
            ${metaHtml}
          </div>
        </div>
        <div>
          ${actionBtnHtml}
        </div>
      `;
      grid.appendChild(card);
    });
    content.appendChild(grid);
  } else if (activeConnectionsFilter === 'search-console') {
    content.innerHTML = '<div class="spinner" style="margin: 40px auto;"></div>';
    (async () => {
      try {
        const res = await fetch('/api/maton/searchconsole/sites', { headers: makeHeaders() });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || data.error || 'Failed to fetch Search Console sites');
        }
        content.innerHTML = '';
        const sites = data.siteEntry || [];
        
        let filteredSites = sites;
        if (q) {
          filteredSites = sites.filter(s => s.siteUrl.toLowerCase().includes(q));
        }

        if (filteredSites.length === 0) {
          content.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">No verified sites found.</p>';
          return;
        }

        const tableContainer = document.createElement('div');
        tableContainer.className = 'connections-table-container';
        
        const table = document.createElement('table');
        table.className = 'drive-table';
        table.innerHTML = `
          <thead>
            <tr>
              <th>Site URL</th>
              <th>Permission Level</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${filteredSites.map(site => `
              <tr>
                <td><strong>${site.siteUrl}</strong></td>
                <td><span style="color: var(--text-secondary);">${site.permissionLevel}</span></td>
                <td style="text-align: right;"><a href="${site.siteUrl}" target="_blank" class="drive-open-btn">Visit Site</a></td>
              </tr>
            `).join('')}
          </tbody>
        `;
        tableContainer.appendChild(table);
        content.appendChild(tableContainer);
      } catch (e) {
        content.innerHTML = `<p style="color: red; padding: 20px;">Error loading Search Console sites: ${e.message}</p>`;
      }
    })();
  } else if (activeConnectionsFilter === 'analytics') {
    content.innerHTML = '<div class="spinner" style="margin: 40px auto;"></div>';
    (async () => {
      try {
        const res = await fetch('/api/maton/analytics/accounts', { headers: makeHeaders() });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || data.error || 'Failed to fetch Analytics accounts');
        }
        content.innerHTML = '';
        const accounts = data.accounts || [];
        
        let filteredAccounts = accounts;
        if (q) {
          filteredAccounts = accounts.filter(a => a.displayName.toLowerCase().includes(q));
        }

        if (filteredAccounts.length === 0) {
          content.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">No Google Analytics accounts found.</p>';
          return;
        }

        const tableContainer = document.createElement('div');
        tableContainer.className = 'connections-table-container';
        
        const table = document.createElement('table');
        table.className = 'drive-table';
        table.innerHTML = `
          <thead>
            <tr>
              <th>Account Name</th>
              <th>Resource Name</th>
              <th>Region</th>
            </tr>
          </thead>
          <tbody>
            ${filteredAccounts.map(acc => `
              <tr>
                <td><strong>${acc.displayName}</strong></td>
                <td><code style="background-color: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--accent-color);">${acc.name}</code></td>
                <td><span style="color: var(--text-secondary);">${acc.regionCode || 'N/A'}</span></td>
              </tr>
            `).join('')}
          </tbody>
        `;
        tableContainer.appendChild(table);
        content.appendChild(tableContainer);
      } catch (e) {
        content.innerHTML = `<p style="color: red; padding: 20px;">Error loading Analytics accounts: ${e.message}</p>`;
      }
    })();
  }
}

function openAppForConnection(appId) {
  if (appId === 'google-mail') {
    switchWorkspace('mail');
  } else if (appId === 'google-drive') {
    switchWorkspace('drive');
  } else if (appId === 'google-docs') {
    switchWorkspace('drive');
    activeDriveFilter = 'files';
    document.querySelectorAll('#sidebar-nav-drive .nav-item').forEach(nav => {
      nav.classList.remove('active');
      if (nav.getAttribute('data-filter') === 'files') nav.classList.add('active');
    });
    document.getElementById('drive-panel-title').textContent = 'Files';
    fetchDriveFiles().then(() => {
      allDriveFiles = allDriveFiles.filter(f => f.mimeType.includes('document'));
      renderDrive();
    });
  } else if (appId === 'google-sheets') {
    switchWorkspace('drive');
    activeDriveFilter = 'files';
    document.querySelectorAll('#sidebar-nav-drive .nav-item').forEach(nav => {
      nav.classList.remove('active');
      if (nav.getAttribute('data-filter') === 'files') nav.classList.add('active');
    });
    document.getElementById('drive-panel-title').textContent = 'Files';
    fetchDriveFiles().then(() => {
      allDriveFiles = allDriveFiles.filter(f => f.mimeType.includes('spreadsheet'));
      renderDrive();
    });
  } else if (appId === 'google-slides') {
    switchWorkspace('drive');
    activeDriveFilter = 'files';
    document.querySelectorAll('#sidebar-nav-drive .nav-item').forEach(nav => {
      nav.classList.remove('active');
      if (nav.getAttribute('data-filter') === 'files') nav.classList.add('active');
    });
    document.getElementById('drive-panel-title').textContent = 'Files';
    fetchDriveFiles().then(() => {
      allDriveFiles = allDriveFiles.filter(f => f.mimeType.includes('presentation'));
      renderDrive();
    });
  } else if (appId === 'google-search-console') {
    activeConnectionsFilter = 'search-console';
    document.querySelectorAll('#sidebar-nav-connections .nav-item').forEach(nav => {
      nav.classList.remove('active');
      if (nav.getAttribute('data-filter') === 'search-console') nav.classList.add('active');
    });
    document.getElementById('connections-panel-title').textContent = 'Search Console Properties';
    renderConnections();
  } else if (appId === 'google-analytics-admin') {
    activeConnectionsFilter = 'analytics';
    document.querySelectorAll('#sidebar-nav-connections .nav-item').forEach(nav => {
      nav.classList.remove('active');
      if (nav.getAttribute('data-filter') === 'analytics') nav.classList.add('active');
    });
    document.getElementById('connections-panel-title').textContent = 'Google Analytics Accounts';
    renderConnections();
  }
}

// Settings Modal Logic
function initSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const btn = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('close-settings-btn');
  const cancelBtn = document.getElementById('cancel-settings-btn');
  const saveBtn = document.getElementById('save-apikey-btn');
  const input = document.getElementById('apikey-input');
  const toggleVisibilityBtn = document.getElementById('toggle-apikey-visibility-btn');
  const statusText = document.getElementById('apikey-status-text');

  checkApiKeyStatus();

  btn.addEventListener('click', () => {
    modal.style.display = 'flex';
    input.value = '';
    checkApiKeyStatus();
  });

  const closeModal = () => {
    modal.style.display = 'none';
  };

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  toggleVisibilityBtn.addEventListener('click', () => {
    if (input.type === 'password') {
      input.type = 'text';
      toggleVisibilityBtn.textContent = '🙈';
    } else {
      input.type = 'password';
      toggleVisibilityBtn.textContent = '👁️';
    }
  });

  saveBtn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) {
      alert('Please enter a valid API key');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      localStorage.setItem('matonApiKey', key);
      const res = await fetch('/api/maton/apikey', {
        method: 'POST',
        headers: makeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ apiKey: key })
      });

      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to save key');
      }

      alert('Maton API Key successfully updated! Refreshing data...');
      closeModal();
      checkApiKeyStatus();
      
      // Reload current workspace data
      if (currentWorkspace === 'mail') {
        fetchEmails();
      } else if (currentWorkspace === 'drive') {
        fetchDriveFiles();
      } else if (currentWorkspace === 'connections') {
        fetchConnections();
      }
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
      alert('Error saving key: ' + e.message);
    }
  });

  async function checkApiKeyStatus() {
    try {
      const res = await fetch('/api/maton/apikey/status', { headers: makeHeaders() });
      if (!res.ok) throw new Error('Status check failed');
      const data = await res.json();
      
      const localKey = localStorage.getItem('matonApiKey');
      const isConfigured = data.configured || !!localKey;
      const preview = localKey ? '...' + localKey.slice(-4) : data.preview;

      if (isConfigured) {
        statusText.textContent = `Status: Configured (${preview})`;
        statusText.className = 'status-indicator configured';
      } else {
        statusText.textContent = 'Status: Not Configured';
        statusText.className = 'status-indicator not-configured';
      }
    } catch (e) {
      statusText.textContent = 'Status: Error checking key';
      statusText.className = 'status-indicator not-configured';
    }
  }
}

async function fetchGmailLabels() {
  const container = document.getElementById('sidebar-nav-mail-custom-labels');
  if (!container) return;
  
  try {
    const res = await fetch('/api/emails/labels', { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed to load labels');
    const data = await res.json();
    
    container.innerHTML = '';
    const labels = data.labels || [];
    
    // Sort labels by name
    labels.sort((a, b) => a.name.localeCompare(b.name));
    
    // Filter to only user-created labels (type is 'user')
    const userLabels = labels.filter(label => label.type === 'user');
    
    if (userLabels.length === 0) {
      container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary); padding: 0 16px;">No labels found</div>';
      return;
    }
    
    userLabels.forEach(label => {
      const item = document.createElement('a');
      item.href = '#';
      item.className = 'nav-item';
      item.setAttribute('data-filter', `label_${label.id}`);
      item.innerHTML = `<span class="icon">🏷️</span> ${label.name}`;
      
      item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('#sidebar-nav-mail .nav-item').forEach(nav => nav.classList.remove('active'));
        document.querySelectorAll('#sidebar-nav-mail-custom-labels .nav-item').forEach(nav => nav.classList.remove('active'));
        
        item.classList.add('active');
        activeFilter = `label_${label.id}`;
        document.getElementById('panel-title').textContent = label.name;
        
        fetchEmails();
      });
      
      container.appendChild(item);
    });
  } catch (e) {
    container.innerHTML = `<div style="font-size: 11px; color: #ef4444; padding: 0 16px;">Error loading labels</div>`;
  }
}

// Real-time sync controllers and silent background updates
function initRealtimeSync() {
  const toggle = document.getElementById('realtime-sync-toggle');
  if (!toggle) return;

  // Load from localStorage
  isRealtimeSyncEnabled = localStorage.getItem('realtimeSync') !== 'false';
  toggle.checked = isRealtimeSyncEnabled;

  toggle.addEventListener('change', (e) => {
    isRealtimeSyncEnabled = e.target.checked;
    localStorage.setItem('realtimeSync', isRealtimeSyncEnabled);
    updateRealtimeSyncState();
  });

  updateRealtimeSyncState();
}

function updateRealtimeSyncState() {
  const statusLabel = document.getElementById('realtime-sync-status');
  if (!statusLabel) return;

  if (isRealtimeSyncEnabled) {
    statusLabel.textContent = 'Live Sync';
    startRealtimeSync();
  } else {
    statusLabel.textContent = 'Manual Sync';
    stopRealtimeSync();
  }
}

function startRealtimeSync() {
  stopRealtimeSync(); // safety clear

  realtimeSyncInterval = setInterval(async () => {
    const pulseDot = document.getElementById('realtime-pulse');
    if (pulseDot) pulseDot.classList.add('active');

    try {
      if (currentWorkspace === 'mail') {
        await fetchEmailsSilent();
      } else if (currentWorkspace === 'drive') {
        await fetchDriveFilesSilent();
      } else if (currentWorkspace === 'connections') {
        await fetchConnectionsSilent();
      }
    } catch (e) {
      console.warn('Real-time sync error:', e);
    } finally {
      setTimeout(() => {
        if (pulseDot) pulseDot.classList.remove('active');
      }, 1000);
    }
  }, 8000); // pull every 8 seconds
}

function stopRealtimeSync() {
  if (realtimeSyncInterval) {
    clearInterval(realtimeSyncInterval);
    realtimeSyncInterval = null;
  }
  const pulseDot = document.getElementById('realtime-pulse');
  if (pulseDot) pulseDot.classList.remove('active');
}

async function fetchEmailsSilent() {
  const detailPanel = document.getElementById('email-detail-panel');
  if (detailPanel && detailPanel.style.display === 'flex') return;

  const monthSelect = document.getElementById('month-select');
  const month = monthSelect ? monthSelect.value : '';
  const url = `/api/emails?category=${activeFilter}&month=${month}&refresh=true`;

  try {
    const res = await fetch(url, { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed silent fetch');
    const data = await res.json();
    allEmails = data;

    if (activeFilter === 'inbox') {
      const inboxCount = document.getElementById('inbox-count');
      if (inboxCount) inboxCount.textContent = allEmails.length;
    }

    const searchQuery = document.getElementById('search-input').value.trim();
    filterAndRender(searchQuery);
  } catch (e) {
    console.warn('Silent email refresh failed:', e.message);
  }
}

async function fetchDriveFilesSilent() {
  const detailPanel = document.getElementById('drive-detail-panel');
  if (detailPanel && detailPanel.style.display === 'flex') return;

  let url = '/api/drive/files';
  const params = ['refresh=true'];
  if (activeDriveFilter === 'trash') {
    params.push('trashed=true');
  } else {
    if (driveNavStack.length > 0) {
      params.push(`parent=${encodeURIComponent(driveNavStack[driveNavStack.length - 1].id)}`);
    } else {
      if (activeDriveFilter === 'mydrive') {
        params.push('parent=root');
      } else {
        params.push('shared=true');
      }
    }
  }

  if (params.length > 0) {
    url += '?' + params.join('&');
  }

  try {
    const res = await fetch(url, { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed silent fetch');
    const data = await res.json();
    allDriveFiles = data.files || [];

    const searchQuery = document.getElementById('search-input').value.trim();
    renderDrive(searchQuery);
  } catch (e) {
    console.warn('Silent drive refresh failed:', e.message);
  }
}

async function fetchConnectionsSilent() {
  if (activeConnectionsFilter !== 'all-connections') return;

  try {
    const res = await fetch('/api/maton/connections', { headers: makeHeaders() });
    if (!res.ok) throw new Error('Failed silent fetch');
    const data = await res.json();
    matonConnections = data.connections || [];

    const searchQuery = document.getElementById('search-input').value.trim();
    renderConnections(searchQuery);
  } catch (e) {
    console.warn('Silent connections refresh failed:', e.message);
  }
}

// Search Console Replica Logic

function initSearchConsoleReplica() {
  if (scIsInitialized) return;
  scIsInitialized = true;

  // DOM elements setup
  const siteSelect = document.getElementById('sc-site-select');
  const dateSelect = document.getElementById('sc-date-select');
  const refreshBtn = document.getElementById('sc-refresh-btn');
  const searchInput = document.getElementById('sc-table-search');

  // Load properties list
  fetchSearchConsoleSites();

  // Site select handler
  siteSelect.addEventListener('change', (e) => {
    scCurrentSite = e.target.value;
    if (scCurrentSite) {
      fetchScPerformanceData();
    } else {
      document.getElementById('sc-dashboard-view').style.display = 'none';
      document.getElementById('sc-empty-state').style.display = 'flex';
      document.getElementById('sc-empty-message').textContent = 'Please select a property to view performance metrics.';
    }
  });

  // Date select handler
  dateSelect.addEventListener('change', () => {
    if (scCurrentSite) {
      fetchScPerformanceData();
    }
  });

  // Refresh btn handler
  refreshBtn.addEventListener('click', () => {
    if (scCurrentSite) {
      fetchScPerformanceData();
    }
  });

  // Scorecards selection handlers (metrics toggling)
  document.querySelectorAll('.sc-kpi-card').forEach(card => {
    card.addEventListener('click', () => {
      const metric = card.getAttribute('data-metric');
      if (scActiveMetrics.has(metric)) {
        if (scActiveMetrics.size === 1) return;
        scActiveMetrics.delete(metric);
        card.classList.remove('active');
      } else {
        scActiveMetrics.add(metric);
        card.classList.add('active');
      }
      updateScChartVisibility();
    });
  });

  // Tabs navigation
  document.querySelectorAll('.sc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sc-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      scActiveTab = tab.getAttribute('data-tab');
      
      const scSidebarMap = {
        'queries': 'sc-performance',
        'pages': 'sc-pages',
        'countries': 'sc-countries',
        'devices': 'sc-countries',
        'dates': 'sc-performance'
      };
      
      const targetSidebarFilter = scSidebarMap[scActiveTab];
      if (targetSidebarFilter) {
        document.querySelectorAll('#sidebar-nav-searchconsole .nav-item').forEach(nav => {
          nav.classList.remove('active');
          if (nav.getAttribute('data-filter') === targetSidebarFilter) {
            nav.classList.add('active');
            const titles = {
              'sc-performance': 'Search Console Performance',
              'sc-pages': 'Search Console Pages',
              'sc-countries': 'Search Console Countries & Devices'
            };
            document.getElementById('searchconsole-panel-title').textContent = titles[targetSidebarFilter] || 'Search Console';
          }
        });
      }

      renderScTable();
    });
  });

  // Table search handler
  searchInput.addEventListener('input', () => {
    renderScTable();
  });
}

async function fetchSearchConsoleSites() {
  const select = document.getElementById('sc-site-select');
  select.innerHTML = '<option value="">Loading sites...</option>';

  try {
    const res = await fetch('/api/maton/searchconsole/sites', { headers: makeHeaders() });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to fetch sites');

    const sites = data.siteEntry || [];
    scSites = sites;

    if (sites.length === 0) {
      select.innerHTML = '<option value="">No verified sites found</option>';
      document.getElementById('sc-empty-message').innerHTML = 'No verified properties found on this Search Console account.<br><br><span style="font-size: 13px; color: var(--text-secondary);">Verify properties in your Google Search Console dashboard first.</span>';
      return;
    }

    select.innerHTML = '<option value="">Select a property...</option>';
    sites.forEach(site => {
      const opt = document.createElement('option');
      opt.value = site.siteUrl;
      opt.textContent = site.siteUrl;
      select.appendChild(opt);
    });

    select.value = sites[0].siteUrl;
    scCurrentSite = sites[0].siteUrl;
    fetchScPerformanceData();
  } catch (e) {
    select.innerHTML = '<option value="">Error loading sites</option>';
    document.getElementById('sc-empty-message').innerHTML = `Error: ${e.message}<br><br><span style="font-size: 13px; color: var(--text-secondary);">Make sure you have set a valid Maton API Key in the settings modal ⚙️.</span>`;
  }
}

function getGscDateRange(rangeType) {
  const end = new Date();
  end.setDate(end.getDate() - 2);
  
  const start = new Date();
  start.setDate(end.getDate());

  switch(rangeType) {
    case '7d':
      start.setDate(end.getDate() - 7);
      break;
    case '28d':
      start.setDate(end.getDate() - 28);
      break;
    case '3m':
      start.setMonth(end.getMonth() - 3);
      break;
    case '6m':
      start.setMonth(end.getMonth() - 6);
      break;
    case '12m':
      start.setFullYear(end.getFullYear() - 1);
      break;
    default:
      start.setDate(end.getDate() - 28);
  }

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0]
  };
}

async function fetchScPerformanceData() {
  if (!scCurrentSite) return;

  const loading = document.getElementById('sc-loading-state');
  const empty = document.getElementById('sc-empty-state');
  const dashboard = document.getElementById('sc-dashboard-view');

  loading.style.display = 'flex';
  empty.style.display = 'none';
  dashboard.style.display = 'none';

  const range = getGscDateRange(document.getElementById('sc-date-select').value);

  try {
    const dimensionsList = ['date', 'query', 'page', 'country', 'device'];
    const requests = dimensionsList.map(dim => {
      return fetch('/api/maton/searchconsole/performance', {
        method: 'POST',
        headers: makeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          siteUrl: scCurrentSite,
          startDate: range.startDate,
          endDate: range.endDate,
          dimensions: [dim],
          rowLimit: 250
        })
      }).then(async res => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Failed fetching data for ${dim}`);
        return { dimension: dim, data: body.rows || [] };
      });
    });

    const results = await Promise.all(requests);
    
    results.forEach(res => {
      scPerformanceData[res.dimension] = res.data;
    });

    let totalClicks = 0;
    let totalImpressions = 0;
    let sumCtr = 0;
    let sumPos = 0;
    const dateRows = scPerformanceData.date;

    dateRows.forEach(row => {
      totalClicks += row.clicks || 0;
      totalImpressions += row.impressions || 0;
      sumCtr += row.ctr || 0;
      sumPos += row.position || 0;
    });

    const rowCount = dateRows.length || 1;
    const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) : 0;
    const avgPosition = rowCount > 0 ? (sumPos / rowCount) : 0;

    const formatNum = (num) => {
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return num.toLocaleString();
    };

    document.getElementById('kpi-clicks-val').textContent = formatNum(totalClicks);
    document.getElementById('kpi-impressions-val').textContent = formatNum(totalImpressions);
    document.getElementById('kpi-ctr-val').textContent = (avgCtr * 100).toFixed(1) + '%';
    document.getElementById('kpi-position-val').textContent = avgPosition.toFixed(1);

    loading.style.display = 'none';
    dashboard.style.display = 'flex';

    renderScChart();
    renderScTable();

  } catch(e) {
    loading.style.display = 'none';
    empty.style.display = 'flex';
    document.getElementById('sc-empty-message').innerHTML = `Failed to retrieve Google Search Console performance data.<br><br>
    <span style="font-size: 13px; color: #ef4444;">Error details: ${e.message}</span><br><br>
    <span style="font-size: 13px; color: var(--text-secondary);">Ensure your Maton API Key is fully configured and the connected account has access to "${scCurrentSite}".</span>`;
  }
}

function renderScChart() {
  const ctx = document.getElementById('sc-chart').getContext('2d');
  
  if (scChartInstance) {
    scChartInstance.destroy();
  }

  const dateRows = [...scPerformanceData.date].sort((a, b) => {
    const d1 = a.keys && a.keys[0] ? a.keys[0] : '';
    const d2 = b.keys && b.keys[0] ? b.keys[0] : '';
    return d1.localeCompare(d2);
  });

  const labels = dateRows.map(row => {
    const rawDate = row.keys && row.keys[0] ? row.keys[0] : '';
    if (!rawDate) return '';
    try {
      const d = new Date(rawDate);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch(e) {
      return rawDate;
    }
  });

  const datasets = [];

  if (scActiveMetrics.has('clicks')) {
    datasets.push({
      label: 'Clicks',
      data: dateRows.map(row => row.clicks || 0),
      borderColor: '#4285f4',
      backgroundColor: 'rgba(66, 133, 244, 0.05)',
      fill: true,
      tension: 0.3,
      yAxisID: 'y'
    });
  }

  if (scActiveMetrics.has('impressions')) {
    datasets.push({
      label: 'Impressions',
      data: dateRows.map(row => row.impressions || 0),
      borderColor: '#a546df',
      backgroundColor: 'rgba(165, 70, 223, 0.05)',
      fill: true,
      tension: 0.3,
      yAxisID: 'y'
    });
  }

  if (scActiveMetrics.has('ctr')) {
    datasets.push({
      label: 'CTR (%)',
      data: dateRows.map(row => (row.ctr || 0) * 100),
      borderColor: '#0f9d58',
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.3,
      yAxisID: 'y1'
    });
  }

  if (scActiveMetrics.has('position')) {
    datasets.push({
      label: 'Average Position',
      data: dateRows.map(row => row.position || 0),
      borderColor: '#e37400',
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.3,
      yAxisID: 'y2'
    });
  }

  scChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                if (context.dataset.label.includes('CTR')) {
                  label += context.parsed.y.toFixed(2) + '%';
                } else if (context.dataset.label.includes('Position')) {
                  label += context.parsed.y.toFixed(1);
                } else {
                  label += context.parsed.y.toLocaleString();
                }
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: '#a0a5b5',
            font: {
              family: 'Outfit',
              size: 11
            }
          }
        },
        y: {
          type: 'linear',
          display: scActiveMetrics.has('clicks') || scActiveMetrics.has('impressions'),
          position: 'left',
          grid: {
            color: '#2e303f'
          },
          ticks: {
            color: '#a0a5b5',
            font: {
              family: 'Outfit',
              size: 11
            }
          }
        },
        y1: {
          type: 'linear',
          display: scActiveMetrics.has('ctr'),
          position: 'right',
          grid: {
            drawOnChartArea: false
          },
          ticks: {
            color: '#a0a5b5',
            font: {
              family: 'Outfit',
              size: 11
            },
            callback: function(value) {
              return value + '%';
            }
          }
        },
        y2: {
          type: 'linear',
          display: scActiveMetrics.has('position'),
          position: 'right',
          reverse: true,
          grid: {
            drawOnChartArea: false
          },
          ticks: {
            color: '#a0a5b5',
            font: {
              family: 'Outfit',
              size: 11
            }
          }
        }
      }
    }
  });
}

function updateScChartVisibility() {
  if (!scChartInstance) return;
  renderScChart();
}

function renderScTable() {
  const headers = document.getElementById('sc-table-headers');
  const body = document.getElementById('sc-table-body');
  const searchInput = document.getElementById('sc-table-search');

  headers.innerHTML = '';
  body.innerHTML = '';

  const q = searchInput.value.toLowerCase().trim();
  const rows = scPerformanceData[scActiveTab] || [];

  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 20px;">No records available.</td></tr>';
    return;
  }

  const tabTitles = {
    queries: 'Query',
    pages: 'Page',
    countries: 'Country',
    devices: 'Device',
    dates: 'Date'
  };
  const primaryColName = tabTitles[scActiveTab] || 'Item';

  headers.innerHTML = `
    <th>Rank</th>
    <th>${primaryColName}</th>
    <th class="numeric">Clicks</th>
    <th class="numeric">Impressions</th>
    <th class="numeric">CTR</th>
    <th class="numeric">Position</th>
  `;

  let maxClicks = 1;
  let maxImpressions = 1;
  rows.forEach(row => {
    if (row.clicks > maxClicks) maxClicks = row.clicks;
    if (row.impressions > maxImpressions) maxImpressions = row.impressions;
  });

  const filtered = rows.filter(row => {
    const keyVal = row.keys && row.keys[0] ? row.keys[0] : '';
    return keyVal.toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 20px;">No matching records found.</td></tr>';
    return;
  }

  filtered.forEach((row, index) => {
    let rawItem = row.keys && row.keys[0] ? row.keys[0] : '(Unknown)';
    
    let displayItem = rawItem;
    if (scActiveTab === 'pages') {
      try {
        const u = new URL(rawItem);
        displayItem = u.pathname + u.search + u.hash;
      } catch(e) {}
    } else if (scActiveTab === 'dates') {
      try {
        displayItem = new Date(rawItem).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      } catch(e) {}
    } else if (scActiveTab === 'countries') {
      displayItem = rawItem.toUpperCase();
    } else if (scActiveTab === 'devices') {
      displayItem = rawItem.charAt(0).toUpperCase() + rawItem.slice(1);
    }

    const clicksPct = Math.min(100, (row.clicks / maxClicks) * 100);
    const impressionsPct = Math.min(100, (row.impressions / maxImpressions) * 100);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color: var(--text-secondary); font-family: monospace; font-size: 12px; width: 60px;">#${index + 1}</td>
      <td title="${rawItem}" style="max-width: 320px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">${displayItem}</td>
      <td class="numeric" style="width: 140px;">
        <div>${row.clicks.toLocaleString()}</div>
        <div class="sc-progress-bar-container">
          <div class="sc-progress-bar" style="width: ${clicksPct}%; background-color: var(--sc-clicks);"></div>
        </div>
      </td>
      <td class="numeric" style="width: 140px;">
        <div>${row.impressions.toLocaleString()}</div>
        <div class="sc-progress-bar-container">
          <div class="sc-progress-bar" style="width: ${impressionsPct}%; background-color: var(--sc-impressions);"></div>
        </div>
      </td>
      <td class="numeric" style="width: 80px; font-family: monospace;">${((row.ctr || 0) * 100).toFixed(1)}%</td>
      <td class="numeric" style="width: 80px; font-family: monospace;">${(row.position || 0).toFixed(1)}</td>
    `;
    body.appendChild(tr);
  });
}

function switchScTableTab(tabName) {
  const tabs = document.querySelectorAll('.sc-tabs .sc-tab');
  tabs.forEach(tab => {
    tab.classList.remove('active');
    if (tab.getAttribute('data-tab') === tabName) {
      tab.classList.add('active');
    }
  });
  scActiveTab = tabName;
  renderScTable();
}




