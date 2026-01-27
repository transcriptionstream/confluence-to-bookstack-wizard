// API helpers
const api = {
  async getConfig() {
    const res = await fetch('/api/config');
    return res.json();
  },

  async saveConfig(config) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  },

  async testConnection(config) {
    const res = await fetch('/api/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  },

  async getExports() {
    const res = await fetch('/api/exports');
    return res.json();
  },

  async startImport(folder, exportType) {
    const res = await fetch(`/api/import/${encodeURIComponent(folder)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportType }),
    });
    return res.json();
  },

  async cancelJob(jobId) {
    const res = await fetch(`/api/job/${jobId}/cancel`, { method: 'POST' });
    return res.json();
  },

  async getShelves() {
    const res = await fetch('/api/shelves');
    return res.json();
  },

  async deleteShelf(id) {
    const res = await fetch(`/api/shelves/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async getBooks() {
    const res = await fetch('/api/books');
    return res.json();
  },

  async deleteBook(id) {
    const res = await fetch(`/api/books/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async getPages() {
    const res = await fetch('/api/pages');
    return res.json();
  },

  async deletePage(id) {
    const res = await fetch(`/api/pages/${id}`, { method: 'DELETE' });
    return res.json();
  },
};

// State
let currentStep = 1;
let currentJobId = null;
let eventSource = null;
let selectedExport = null;
let bookstackUrl = '';
let currentTab = 'shelves';

// Counters
const counters = {
  shelves: 0,
  books: 0,
  chapters: 0,
  pages: 0,
};

// DOM Elements
const elements = {
  steps: document.querySelectorAll('.step-content'),
  stepIndicators: document.querySelectorAll('.step-indicator'),
  configForm: document.getElementById('config-form'),
  testBtn: document.getElementById('test-connection'),
  connectionStatus: document.getElementById('connection-status'),
  exportsList: document.getElementById('exports-list'),
  exportsLoading: document.getElementById('exports-loading'),
  noExports: document.getElementById('no-exports'),
  importPathDisplay: document.getElementById('import-path-display'),
  logOutput: document.getElementById('log-output'),
  progressBar: document.getElementById('import-progress-bar'),
  phaseLabel: document.getElementById('phase-label'),
  progressPercent: document.getElementById('progress-percent'),
  importingFolder: document.getElementById('importing-folder'),
  contentModal: document.getElementById('content-modal'),
  contentList: document.getElementById('content-list'),
  contentLoading: document.getElementById('content-loading'),
  noContent: document.getElementById('no-content'),
  extractionProgress: document.getElementById('extraction-progress'),
  extractionProgressBar: document.getElementById('extraction-progress-bar'),
  extractionStatus: document.getElementById('extraction-status'),
};

// Initialize
async function init() {
  await loadConfig();
  setupEventListeners();
}

// Load saved configuration
async function loadConfig() {
  try {
    const config = await api.getConfig();
    if (config.configured) {
      document.getElementById('bookstack-url').value = config.url || '';
      document.getElementById('import-path').value = config.path || './import';
      bookstackUrl = config.url?.replace('/api', '') || '';
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// Setup event listeners
function setupEventListeners() {
  // Config form
  elements.configForm.addEventListener('submit', handleConfigSubmit);
  elements.testBtn.addEventListener('click', handleTestConnection);

  // Navigation
  document.getElementById('back-to-config').addEventListener('click', () => goToStep(1));
  document.getElementById('refresh-exports').addEventListener('click', loadExports);
  document.getElementById('cancel-import').addEventListener('click', handleCancelImport);
  document.getElementById('start-another').addEventListener('click', () => {
    resetState();
    goToStep(2);
    loadExports();
  });

  // Manage content modal
  document.getElementById('manage-content').addEventListener('click', showContentModal);
  document.getElementById('close-content-modal').addEventListener('click', hideContentModal);
  document.querySelector('.modal-backdrop').addEventListener('click', hideContentModal);

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadContentForTab();
    });
  });
}

// Handle config form submission
async function handleConfigSubmit(e) {
  e.preventDefault();

  const config = {
    url: document.getElementById('bookstack-url').value,
    id: document.getElementById('api-id').value,
    secret: document.getElementById('api-secret').value,
    path: document.getElementById('import-path').value,
  };

  try {
    const result = await api.saveConfig(config);
    if (result.success) {
      bookstackUrl = config.url.replace('/api', '');
      goToStep(2);
      loadExports();
    }
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// Handle test connection
async function handleTestConnection() {
  const config = {
    url: document.getElementById('bookstack-url').value,
    id: document.getElementById('api-id').value,
    secret: document.getElementById('api-secret').value,
  };

  elements.connectionStatus.textContent = 'Testing...';
  elements.connectionStatus.className = 'text-sm text-gray-600';

  try {
    const result = await api.testConnection(config);
    if (result.success) {
      elements.connectionStatus.textContent = `Connected! Found ${result.shelfCount} shelves.`;
      elements.connectionStatus.className = 'text-sm text-green-600';
    } else {
      elements.connectionStatus.textContent = result.error || 'Connection failed';
      elements.connectionStatus.className = 'text-sm text-red-600';
    }
  } catch (err) {
    elements.connectionStatus.textContent = 'Connection failed';
    elements.connectionStatus.className = 'text-sm text-red-600';
  }
}

// Load exports list
async function loadExports() {
  elements.exportsLoading.classList.remove('hidden');
  elements.exportsList.classList.add('hidden');
  elements.noExports.classList.add('hidden');

  try {
    const data = await api.getExports();
    elements.importPathDisplay.textContent = data.path;

    if (data.exports.length === 0) {
      elements.noExports.classList.remove('hidden');
    } else {
      renderExports(data.exports);
      elements.exportsList.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to load exports:', err);
    elements.noExports.classList.remove('hidden');
  } finally {
    elements.exportsLoading.classList.add('hidden');
  }
}

// Render exports list
function renderExports(exports) {
  elements.exportsList.innerHTML = exports.map(exp => `
    <div class="export-card" data-name="${exp.name}" data-type="${exp.exportType}">
      <div class="export-info">
        <span class="export-name">${exp.spaceName || exp.name}</span>
        <span class="export-meta">
          ${exp.type === 'zip' ? exp.size : `${exp.pageCount || 0} pages`}
          ${exp.spaceName && exp.name !== exp.spaceName ? ` - ${exp.name}` : ''}
        </span>
      </div>
      <span class="export-type-badge ${exp.exportType}">${exp.type === 'zip' ? 'ZIP' : exp.exportType.toUpperCase()}</span>
    </div>
  `).join('');

  // Add click handlers
  elements.exportsList.querySelectorAll('.export-card').forEach(card => {
    card.addEventListener('click', () => handleExportSelect(card));
  });
}

// Handle export selection
async function handleExportSelect(card) {
  const name = card.dataset.name;
  const type = card.dataset.type;

  // Check if it's a ZIP file that needs extraction
  if (name.endsWith('.zip')) {
    await extractZipWithProgress(name);
    return;
  }

  // Deselect all and select this one
  elements.exportsList.querySelectorAll('.export-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');

  selectedExport = { name, type };

  // Start import
  startImport(name, type);
}

// Extract ZIP file with progress
async function extractZipWithProgress(zipName) {
  elements.extractionProgress.classList.remove('hidden');
  elements.extractionProgressBar.style.width = '0%';
  elements.extractionStatus.textContent = 'Connecting...';

  const eventSource = new EventSource(`/api/extract/${encodeURIComponent(zipName)}/stream`);

  eventSource.addEventListener('connected', (e) => {
    console.log('Connected to extraction stream');
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    elements.extractionProgressBar.style.width = `${data.percent || 0}%`;
    elements.extractionStatus.textContent = data.message;
  });

  eventSource.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    eventSource.close();

    elements.extractionProgress.classList.add('hidden');

    if (data.success) {
      // Reload exports and auto-select the extracted folder
      loadExports().then(() => {
        setTimeout(() => {
          const card = elements.exportsList.querySelector(`[data-name="${data.folderName}"]`);
          if (card) {
            handleExportSelect(card);
          }
        }, 100);
      });
    } else {
      alert('Extraction failed: ' + (data.error || 'Unknown error'));
    }
  });

  eventSource.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      alert('Extraction failed: ' + (data.error || 'Unknown error'));
    } catch {
      console.error('Extraction stream error');
    }
    eventSource.close();
    elements.extractionProgress.classList.add('hidden');
  });

  eventSource.onerror = () => {
    eventSource.close();
    elements.extractionProgress.classList.add('hidden');
  };
}

// Start import process
async function startImport(folder, exportType) {
  goToStep(3);
  elements.importingFolder.textContent = folder;
  resetCounters();
  elements.logOutput.innerHTML = '';

  try {
    const result = await api.startImport(folder, exportType);
    if (result.error) {
      addLog(`Error: ${result.error}`, 'error');
      return;
    }

    currentJobId = result.jobId;
    connectToJobEvents(result.jobId);
  } catch (err) {
    addLog(`Failed to start import: ${err.message}`, 'error');
  }
}

// Connect to job events via SSE
function connectToJobEvents(jobId) {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`/api/job/${jobId}/events`);

  eventSource.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    console.log('Job status:', data);
  });

  eventSource.addEventListener('start', (e) => {
    const data = JSON.parse(e.data);
    elements.phaseLabel.textContent = `${data.phase}: ${data.message}`;
    addLog(`[${data.phase}] ${data.message}`, 'info');
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    updateProgress(data);
  });

  eventSource.addEventListener('success', (e) => {
    const data = JSON.parse(e.data);
    addLog(`[${data.phase}] ${data.message}`, 'success');
  });

  eventSource.addEventListener('error', (e) => {
    const data = JSON.parse(e.data);
    addLog(`[${data.phase}] ${data.message}`, 'error');
  });

  eventSource.addEventListener('warning', (e) => {
    const data = JSON.parse(e.data);
    addLog(`[${data.phase}] ${data.message}`, 'warning');
  });

  eventSource.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    addLog(`[${data.phase}] ${data.message}`, 'success');

    if (data.counters) {
      Object.entries(data.counters).forEach(([key, value]) => {
        updateCounter(key, value);
      });
    }

    // Check if this is the final completion
    if (data.phase === 'cleanup' || data.phase === 'complete') {
      setTimeout(() => {
        eventSource.close();
        showComplete();
      }, 1000);
    }
  });

  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    addLog(data.message, data.level);
  });

  eventSource.onerror = () => {
    console.log('SSE connection closed');
  };
}

// Update progress display
function updateProgress(data) {
  if (data.phase) {
    elements.phaseLabel.textContent = `${data.phase}: ${data.message}`;
  }

  if (data.percent !== undefined) {
    elements.progressBar.style.width = `${data.percent}%`;
    elements.progressPercent.textContent = `${data.percent}%`;
  } else if (data.current !== undefined && data.total !== undefined) {
    const percent = Math.round((data.current / data.total) * 100);
    elements.progressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${percent}%`;
  }

  if (data.counters) {
    Object.entries(data.counters).forEach(([key, value]) => {
      updateCounter(key, value);
    });
  }
}

// Update counter display
function updateCounter(key, value) {
  const el = document.getElementById(`counter-${key}`);
  if (el) {
    el.textContent = value;
    counters[key] = value;
  }
}

// Reset counters
function resetCounters() {
  Object.keys(counters).forEach(key => {
    counters[key] = 0;
    const el = document.getElementById(`counter-${key}`);
    if (el) el.textContent = '0';
  });
  elements.progressBar.style.width = '0%';
  elements.progressPercent.textContent = '0%';
}

// Add log entry
function addLog(message, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = message;
  elements.logOutput.appendChild(entry);
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

// Handle cancel import
async function handleCancelImport() {
  if (currentJobId) {
    await api.cancelJob(currentJobId);
    if (eventSource) {
      eventSource.close();
    }
    addLog('Import cancelled', 'warning');
  }
}

// Show completion step
function showComplete() {
  goToStep(4);

  // Copy counters to final stats
  document.getElementById('final-shelves').textContent = counters.shelves;
  document.getElementById('final-books').textContent = counters.books;
  document.getElementById('final-chapters').textContent = counters.chapters;
  document.getElementById('final-pages').textContent = counters.pages;

  // Set BookStack link
  const viewLink = document.getElementById('view-bookstack');
  viewLink.href = bookstackUrl || '#';
}

// Reset state for new import
function resetState() {
  currentJobId = null;
  selectedExport = null;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  resetCounters();
}

// Go to step
function goToStep(step) {
  currentStep = step;

  // Update step content visibility
  elements.steps.forEach(el => el.classList.add('hidden'));
  document.getElementById(`step-${step}`).classList.remove('hidden');

  // Update step indicators
  elements.stepIndicators.forEach(indicator => {
    const indicatorStep = parseInt(indicator.dataset.step);
    indicator.classList.remove('active', 'completed');

    if (indicatorStep < step) {
      indicator.classList.add('completed');
    } else if (indicatorStep === step) {
      indicator.classList.add('active');
    }
  });
}

// Show content modal
async function showContentModal() {
  elements.contentModal.classList.remove('hidden');
  loadContentForTab();
}

// Hide content modal
function hideContentModal() {
  elements.contentModal.classList.add('hidden');
}

// Load content for current tab
async function loadContentForTab() {
  elements.contentLoading.classList.remove('hidden');
  elements.contentList.classList.add('hidden');
  elements.noContent.classList.add('hidden');

  try {
    let items = [];
    let itemType = currentTab;

    if (currentTab === 'shelves') {
      const data = await api.getShelves();
      items = data.shelves || [];
    } else if (currentTab === 'books') {
      const data = await api.getBooks();
      items = data.books || [];
    } else if (currentTab === 'pages') {
      const data = await api.getPages();
      items = data.pages || [];
    }

    if (items.length === 0) {
      elements.noContent.classList.remove('hidden');
    } else {
      renderContentItems(items, itemType);
      elements.contentList.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to load content:', err);
    elements.noContent.classList.remove('hidden');
  } finally {
    elements.contentLoading.classList.add('hidden');
  }
}

// Render content items
function renderContentItems(items, type) {
  const singularType = type.slice(0, -1); // shelves -> shelf, books -> book, pages -> page

  elements.contentList.innerHTML = items.map(item => `
    <div class="content-item" data-id="${item.id}" data-type="${singularType}">
      <div>
        <div class="content-item-name">${item.name}</div>
        ${item.book_id ? `<div class="content-item-meta">Book ID: ${item.book_id}</div>` : ''}
      </div>
      <button class="delete-btn" onclick="handleDeleteContent(${item.id}, '${singularType}')">Delete</button>
    </div>
  `).join('');
}

// Handle delete content
async function handleDeleteContent(id, type) {
  if (!confirm(`Are you sure you want to delete this ${type}? This cannot be undone.`)) {
    return;
  }

  try {
    let result;
    if (type === 'shelf') {
      result = await api.deleteShelf(id);
    } else if (type === 'book') {
      result = await api.deleteBook(id);
    } else if (type === 'page') {
      result = await api.deletePage(id);
    }

    if (result.success) {
      loadContentForTab();
    } else {
      alert('Failed to delete item');
    }
  } catch (err) {
    alert('Failed to delete item: ' + err.message);
  }
}

// Make handleDeleteContent available globally
window.handleDeleteContent = handleDeleteContent;

// Initialize on load
init();
