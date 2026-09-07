// The Mail workspace lives in src/ as ES modules and is reached through
// window.MatonMail (see src/boot.js). Everything below owns the other tabs.

let currentWorkspace = 'mail'; // 'mail' | 'drive' | 'connections' | 'searchconsole'

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
  // Mail boots itself from src/boot.js.

  // Workspace Switchers
  document.getElementById('tab-mail').addEventListener('click', () => switchWorkspace('mail'));
  document.getElementById('tab-drive').addEventListener('click', () => switchWorkspace('drive'));
  document.getElementById('tab-connections').addEventListener('click', () => switchWorkspace('connections'));
  document.getElementById('tab-searchconsole').addEventListener('click', () => switchWorkspace('searchconsole'));

  // Refresh and action buttons
  document.getElementById('connections-refresh-btn').addEventListener('click', fetchConnections);

  // Sidebar compose button only applies to Mail.
  document.getElementById('sidebar-action-btn').addEventListener('click', () => {
    if (currentWorkspace === 'mail' && window.MatonMail) window.MatonMail.compose();
  });

  // Search filter. Mail and Drive own their own search boxes (both submit on
  // Enter); the shell only live-filters the Connections list.
  document.getElementById('search-input').addEventListener('input', (e) => {
    if (currentWorkspace === 'connections') {
      renderConnections(e.target.value.trim());
    }
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
  // The API key dialog lives in src/settings.js and is wired by src/boot.js.

  // Switching keys invalidates everything the non-module tabs have loaded.
  document.addEventListener('maton:key-changed', () => {
    matonConnections = [];
    scIsInitialized = false;
    if (currentWorkspace === 'connections') fetchConnections();
  });
});

function switchWorkspace(workspace) {
  if (workspace === currentWorkspace) return;
  currentWorkspace = workspace;

  const mailTab = document.getElementById('tab-mail');
  const driveTab = document.getElementById('tab-drive');
  const connectionsTab = document.getElementById('tab-connections');
  const searchConsoleTab = document.getElementById('tab-searchconsole');
  
  const connectionsNav = document.getElementById('sidebar-nav-connections');
  const searchConsoleNav = document.getElementById('sidebar-nav-searchconsole');
  
  const actionBtn = document.getElementById('sidebar-action-btn');
  const searchInput = document.getElementById('search-input');
  
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

  // Hide all sidebars (Mail and Drive render their own rails)
  connectionsNav.style.display = 'none';
  searchConsoleNav.style.display = 'none';

  // Hide all panels. The Mail and Drive workspaces are shown/hidden by the
  // body[data-workspace] attribute that gmail.css and drive.css key off.
  document.body.dataset.workspace = workspace;
  connectionsPanel.style.display = 'none';
  searchConsolePanel.style.display = 'none';

  if (workspace === 'mail') {
    mailTab.classList.add('active');
    actionBtn.textContent = '＋ Compose';
    actionBtn.style.display = 'block';
    logoIcon.textContent = 'M';
    logoTitle.textContent = 'Maton Mail';
    if (window.MatonMail) window.MatonMail.activate();
    return;
  }

  if (window.MatonMail) window.MatonMail.deactivate();

  if (workspace === 'drive') {
    driveTab.classList.add('active');
    actionBtn.style.display = 'none';
    logoIcon.textContent = 'D';
    logoTitle.textContent = 'Maton Drive';
    if (window.MatonDrive) window.MatonDrive.activate();
    return;
  }

  if (window.MatonDrive) window.MatonDrive.deactivate();

  if (workspace === 'connections') {
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
  } else if (appId === 'google-docs' || appId === 'google-sheets' || appId === 'google-slides') {
    // Docs, Sheets and Slides all live in Drive; its own search finds them.
    switchWorkspace('drive');
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
        if (window.MatonMail) await window.MatonMail.silentSync();
      } else if (currentWorkspace === 'drive') {
        if (window.MatonDrive) await window.MatonDrive.silentSync();
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




