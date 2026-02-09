// ============================================
// Confluence → BookStack Migration Wizard
// Frontend Application
// ============================================

// Initialize Lucide icons
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  init();
});

// ============================================
// API Helpers
// ============================================
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

  async startImport(folder, exportType, subFolder) {
    const res = await fetch(`/api/import/${encodeURIComponent(folder)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportType, subFolder }),
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

  async getAttachmentRecords() {
    const res = await fetch('/api/attachments');
    return res.json();
  },

  async clearAttachmentRecords() {
    const res = await fetch('/api/attachments', { method: 'DELETE' });
    return res.json();
  },

  async uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    return res.json();
  },
};

// ============================================
// State
// ============================================
let currentStep = 1;
let currentJobId = null;
let eventSource = null;
let selectedExport = null;
let bookstackUrl = '';
let currentTab = 'shelves';
let currentTabItems = [];
let isConnected = false;
let terminalExpanded = false;

const counters = {
  shelves: 0,
  books: 0,
  chapters: 0,
  pages: 0,
};

// ============================================
// DOM Elements
// ============================================
const elements = {
  // Steps
  steps: document.querySelectorAll('.step-panel'),
  pipelineSteps: document.querySelectorAll('.pipeline-step'),
  pipelineFill: document.getElementById('pipeline-fill'),

  // Header
  connectionIndicator: document.getElementById('connection-indicator'),

  // Config form
  configForm: document.getElementById('config-form'),
  testBtn: document.getElementById('test-connection'),
  bookstackUrl: document.getElementById('bookstack-url'),
  apiId: document.getElementById('api-id'),
  apiSecret: document.getElementById('api-secret'),
  importPath: document.getElementById('import-path'),

  // Upload
  uploadZone: document.getElementById('upload-zone'),
  fileInput: document.getElementById('file-input'),
  browseBtn: document.getElementById('browse-btn'),
  uploadProgress: document.getElementById('upload-progress'),
  uploadProgressFill: document.getElementById('upload-progress-fill'),
  uploadStatus: document.getElementById('upload-status'),

  // Exports
  exportsList: document.getElementById('exports-list'),
  exportsLoading: document.getElementById('exports-loading'),
  noExports: document.getElementById('no-exports'),
  importPathDisplay: document.getElementById('import-path-display'),

  // Extraction
  extractionProgress: document.getElementById('extraction-progress'),
  extractionProgressBar: document.getElementById('extraction-progress-bar'),
  extractionStatus: document.getElementById('extraction-status'),

  // Import progress
  importingFolder: document.getElementById('importing-folder'),
  importStatusBadge: document.getElementById('import-status-badge'),
  phaseLabel: document.getElementById('phase-label'),
  progressPercent: document.getElementById('progress-percent'),
  progressBar: document.getElementById('import-progress-bar'),
  logOutput: document.getElementById('log-output'),
  toggleTerminal: document.getElementById('toggle-terminal'),

  // Modals
  confirmModal: document.getElementById('confirm-modal'),
  confirmIcon: document.getElementById('confirm-icon'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmMessage: document.getElementById('confirm-message'),
  confirmCancel: document.getElementById('confirm-cancel'),
  confirmProceed: document.getElementById('confirm-proceed'),

  contentModal: document.getElementById('content-modal'),
  contentList: document.getElementById('content-list'),
  contentLoading: document.getElementById('content-loading'),
  noContent: document.getElementById('no-content'),
  deleteAllBtn: document.getElementById('delete-all-btn'),
  nukeAllBtn: document.getElementById('nuke-all-btn'),
  contentCount: document.getElementById('content-count'),

  previewModal: document.getElementById('preview-modal'),
  previewName: document.getElementById('preview-name'),
  previewPages: document.getElementById('preview-pages'),
  previewType: document.getElementById('preview-type'),
  previewSize: document.getElementById('preview-size'),

  // Toast container
  toastContainer: document.getElementById('toast-container'),
};

// ============================================
// Toast System
// ============================================
function showToast(type, title, message = '', duration = 4000) {
  const icons = {
    success: 'check-circle',
    error: 'x-circle',
    warning: 'alert-triangle',
    info: 'info',
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i data-lucide="${icons[type]}" class="toast-icon"></i>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      ${message ? `<div class="toast-message">${message}</div>` : ''}
    </div>
    <button class="toast-close" aria-label="Close">
      <i data-lucide="x"></i>
    </button>
  `;

  elements.toastContainer.appendChild(toast);
  lucide.createIcons({ nodes: [toast] });

  const closeBtn = toast.querySelector('.toast-close');
  const removeToast = () => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 150);
  };

  closeBtn.addEventListener('click', removeToast);

  if (duration > 0) {
    setTimeout(removeToast, duration);
  }

  return toast;
}

// ============================================
// Confirmation Dialog
// ============================================
let confirmResolver = null;

function showConfirmDialog(options) {
  const { title, message, icon = 'warning', proceedText = 'Proceed', proceedClass = 'btn-primary' } = options;

  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmIcon.className = `modal-icon ${icon}`;
  elements.confirmIcon.innerHTML = `<i data-lucide="${icon === 'danger' ? 'alert-triangle' : icon === 'info' ? 'info' : 'alert-triangle'}"></i>`;
  elements.confirmProceed.textContent = proceedText;
  elements.confirmProceed.className = `btn ${proceedClass}`;

  lucide.createIcons({ nodes: [elements.confirmIcon] });

  elements.confirmModal.classList.remove('hidden');

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function hideConfirmDialog(result) {
  elements.confirmModal.classList.add('hidden');
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

// ============================================
// Initialize
// ============================================
async function init() {
  await loadConfig();
  setupEventListeners();
  updatePipelineProgress();
}

// ============================================
// Load Config
// ============================================
async function loadConfig() {
  try {
    const config = await api.getConfig();
    if (config.configured) {
      elements.bookstackUrl.value = config.url || '';
      elements.importPath.value = config.path || './import';
      bookstackUrl = config.url?.replace('/api', '') || '';

      if (config.hasCredentials) {
        updateConnectionStatus(true);
      }
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// ============================================
// Event Listeners
// ============================================
function setupEventListeners() {
  // Config form
  elements.configForm.addEventListener('submit', handleConfigSubmit);
  elements.testBtn.addEventListener('click', handleTestConnection);

  // Navigation
  document.getElementById('back-to-config').addEventListener('click', () => goToStep(1));
  document.getElementById('refresh-exports').addEventListener('click', loadExports);
  document.getElementById('refresh-exports-btn').addEventListener('click', loadExports);
  document.getElementById('cancel-import').addEventListener('click', handleCancelImport);

  // File upload handlers
  setupUploadHandlers();
  document.getElementById('start-another').addEventListener('click', () => {
    resetState();
    goToStep(2);
    loadExports();
  });

  // Terminal toggle
  elements.toggleTerminal.addEventListener('click', () => {
    terminalExpanded = !terminalExpanded;
    elements.logOutput.classList.toggle('expanded', terminalExpanded);
    const icon = elements.toggleTerminal.querySelector('i');
    icon.setAttribute('data-lucide', terminalExpanded ? 'minimize-2' : 'maximize-2');
    lucide.createIcons({ nodes: [elements.toggleTerminal] });
  });

  // Manage content modal
  document.getElementById('manage-content').addEventListener('click', showContentModal);
  document.getElementById('close-content-modal').addEventListener('click', hideContentModal);
  elements.deleteAllBtn.addEventListener('click', handleDeleteAll);
  elements.nukeAllBtn.addEventListener('click', handleNukeEverything);

  // Modal backdrops
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal.id === 'confirm-modal') {
        hideConfirmDialog(false);
      } else if (modal.id === 'content-modal') {
        hideContentModal();
      } else if (modal.id === 'preview-modal') {
        hidePreviewModal();
      }
    });
  });

  // Confirm dialog buttons
  elements.confirmCancel.addEventListener('click', () => hideConfirmDialog(false));
  elements.confirmProceed.addEventListener('click', () => hideConfirmDialog(true));

  // Preview modal buttons
  document.getElementById('preview-cancel').addEventListener('click', hidePreviewModal);
  document.getElementById('preview-start').addEventListener('click', () => {
    console.log('[DEBUG] Start Import clicked, selectedExport:', selectedExport);
    hidePreviewModal();
    if (selectedExport) {
      console.log('[DEBUG] Calling startImport with:', selectedExport.name, selectedExport.type, selectedExport.subFolder);
      startImport(selectedExport.name, selectedExport.type, selectedExport.subFolder);
    }
  });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadContentForTab();
    });
  });

  // Pipeline step clicks (for going back)
  elements.pipelineSteps.forEach(step => {
    step.addEventListener('click', () => {
      const stepNum = parseInt(step.dataset.step);
      if (stepNum < currentStep && currentStep !== 3) {
        goToStep(stepNum);
        if (stepNum === 2) loadExports();
      }
    });
  });
}

// ============================================
// Connection Status
// ============================================
function updateConnectionStatus(connected, shelfCount = null) {
  isConnected = connected;
  const indicator = elements.connectionIndicator;
  const statusText = indicator.querySelector('.status-text');

  if (connected) {
    indicator.classList.add('connected');
    statusText.textContent = shelfCount !== null ? `Connected (${shelfCount} shelves)` : 'Connected';
  } else {
    indicator.classList.remove('connected');
    statusText.textContent = 'Not Connected';
  }
}

// ============================================
// Handle Config Submit
// ============================================
async function handleConfigSubmit(e) {
  e.preventDefault();

  const config = {
    url: elements.bookstackUrl.value,
    id: elements.apiId.value,
    secret: elements.apiSecret.value,
    path: elements.importPath.value,
  };

  try {
    const result = await api.saveConfig(config);
    if (result.success) {
      bookstackUrl = config.url.replace('/api', '');
      showToast('success', 'Configuration Saved');
      goToStep(2);
      loadExports();
    } else {
      showToast('error', 'Failed to Save', result.error || 'Unknown error');
    }
  } catch (err) {
    showToast('error', 'Failed to Save', err.message);
  }
}

// ============================================
// File Upload Handlers
// ============================================
function setupUploadHandlers() {
  const zone = elements.uploadZone;
  const input = elements.fileInput;
  const browseBtn = elements.browseBtn;

  if (!zone || !input) return;

  // Browse button click
  browseBtn?.addEventListener('click', () => input.click());

  // File input change
  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
  });

  // Drag and drop events
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        handleFileUpload(file);
      } else {
        showToast('error', 'Invalid File', 'Please upload a ZIP file');
      }
    }
  });
}

async function handleFileUpload(file) {
  const zone = elements.uploadZone;
  const progressDiv = elements.uploadProgress;
  const progressFill = elements.uploadProgressFill;
  const statusText = elements.uploadStatus;

  // Show upload progress
  zone.classList.add('uploading');
  progressDiv.classList.remove('hidden');
  progressFill.style.width = '0%';
  statusText.textContent = `Uploading ${file.name}...`;

  try {
    // Simulate progress (actual progress would need XHR)
    progressFill.style.width = '30%';

    const result = await api.uploadFile(file);

    if (result.success) {
      progressFill.style.width = '100%';
      statusText.textContent = 'Upload complete!';
      showToast('success', 'Upload Successful', `${file.name} uploaded`);

      // Refresh exports list after short delay
      setTimeout(() => {
        progressDiv.classList.add('hidden');
        zone.classList.remove('uploading');
        loadExports();
      }, 1000);
    } else {
      throw new Error(result.error || 'Upload failed');
    }
  } catch (err) {
    progressDiv.classList.add('hidden');
    zone.classList.remove('uploading');
    showToast('error', 'Upload Failed', err.message);
  }

  // Reset file input
  elements.fileInput.value = '';
}

// ============================================
// Handle Test Connection
// ============================================
async function handleTestConnection() {
  const config = {
    url: elements.bookstackUrl.value,
    id: elements.apiId.value,
    secret: elements.apiSecret.value,
  };

  const btn = elements.testBtn;
  const btnText = btn.querySelector('span');
  const btnLoader = btn.querySelector('.btn-loader');

  btn.disabled = true;
  btnText.textContent = 'Testing...';
  btnLoader?.classList.remove('hidden');

  try {
    const result = await api.testConnection(config);
    if (result.success) {
      updateConnectionStatus(true, result.shelfCount);
      showToast('success', 'Connection Successful', `Found ${result.shelfCount} shelves in BookStack`);
    } else {
      updateConnectionStatus(false);
      showToast('error', 'Connection Failed', result.error || 'Unknown error');
    }
  } catch (err) {
    updateConnectionStatus(false);
    showToast('error', 'Connection Failed', err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Test Connection';
    btnLoader?.classList.add('hidden');
  }
}

// ============================================
// Load Exports
// ============================================
async function loadExports() {
  elements.exportsLoading.classList.remove('hidden');
  elements.exportsList.classList.add('hidden');
  elements.noExports.classList.add('hidden');

  try {
    const data = await api.getExports();
    elements.importPathDisplay.textContent = data.path;

    if (data.exports.length === 0) {
      elements.noExports.classList.remove('hidden');
      lucide.createIcons({ nodes: [elements.noExports] });
    } else {
      renderExports(data.exports);
      elements.exportsList.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to load exports:', err);
    elements.noExports.classList.remove('hidden');
    showToast('error', 'Failed to Load Exports', err.message);
  } finally {
    elements.exportsLoading.classList.add('hidden');
  }
}

// ============================================
// Render Exports
// ============================================
function renderExports(exports) {
  elements.exportsList.innerHTML = exports.map(exp => {
    const isZip = exp.type === 'zip';
    const iconType = isZip ? 'zip' : exp.exportType;
    const iconName = isZip ? 'archive' : (exp.exportType === 'xml' ? 'file-code' : 'file-text');

    return `
      <div class="export-card" data-name="${exp.name}" data-type="${exp.exportType}"
           data-pages="${exp.pageCount || 0}" data-size="${exp.size || ''}" data-space="${exp.spaceName || ''}" data-subfolder="${exp.subFolder || ''}">
        <div class="export-icon ${iconType}">
          <i data-lucide="${iconName}"></i>
        </div>
        <div class="export-info">
          <div class="export-name">${exp.spaceName || exp.name}</div>
          <div class="export-meta">
            ${isZip ? exp.size : `${exp.pageCount || 0} pages`}
            ${exp.spaceName && exp.name !== exp.spaceName ? ` · ${exp.name}` : ''}
            <span class="export-badge ${iconType}">${isZip ? 'ZIP' : exp.exportType.toUpperCase()}</span>
          </div>
        </div>
        <div class="export-action">
          <i data-lucide="chevron-right"></i>
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons({ nodes: [elements.exportsList] });

  // Add click handlers
  elements.exportsList.querySelectorAll('.export-card').forEach(card => {
    card.addEventListener('click', () => handleExportSelect(card));
  });
}

// ============================================
// Handle Export Selection
// ============================================
async function handleExportSelect(card) {
  const name = card.dataset.name;
  const type = card.dataset.type;
  const pages = card.dataset.pages;
  const size = card.dataset.size;
  const space = card.dataset.space;
  const subFolder = card.dataset.subfolder;

  console.log('[DEBUG] handleExportSelect - card data:', { name, type, pages, size, space, subFolder });

  // Check if it's a ZIP file that needs extraction
  if (name.endsWith('.zip')) {
    await extractZipWithProgress(name);
    return;
  }

  // Show preview modal
  selectedExport = { name, type, pages, size, space, subFolder };
  showPreviewModal(selectedExport);
}

// ============================================
// Preview Modal
// ============================================
function showPreviewModal(exportData) {
  elements.previewName.textContent = exportData.space || exportData.name;
  elements.previewPages.textContent = exportData.pages || '?';
  elements.previewType.textContent = exportData.type.toUpperCase();
  elements.previewSize.textContent = exportData.size || 'Folder';

  elements.previewModal.classList.remove('hidden');
  lucide.createIcons({ nodes: [elements.previewModal] });
}

function hidePreviewModal() {
  elements.previewModal.classList.add('hidden');
}

// ============================================
// Extract ZIP
// ============================================
async function extractZipWithProgress(zipName) {
  elements.extractionProgress.classList.remove('hidden');
  elements.extractionProgressBar.style.width = '0%';
  elements.extractionStatus.textContent = 'Connecting...';

  const es = new EventSource(`/api/extract/${encodeURIComponent(zipName)}/stream`);

  es.addEventListener('connected', () => {
    elements.extractionStatus.textContent = 'Loading archive...';
  });

  es.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    elements.extractionProgressBar.style.width = `${data.percent || 0}%`;
    elements.extractionStatus.textContent = data.message;
  });

  es.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    es.close();
    elements.extractionProgress.classList.add('hidden');

    if (data.success) {
      showToast('success', 'Extraction Complete', `${data.pageCount || 0} pages found`);
      loadExports().then(() => {
        setTimeout(() => {
          const card = elements.exportsList.querySelector(`[data-name="${data.folderName}"]`);
          if (card) {
            handleExportSelect(card);
          }
        }, 100);
      });
    } else {
      showToast('error', 'Extraction Failed', data.error || 'Unknown error');
    }
  });

  es.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      showToast('error', 'Extraction Failed', data.error || 'Unknown error');
    } catch {
      showToast('error', 'Extraction Failed', 'Connection error');
    }
    es.close();
    elements.extractionProgress.classList.add('hidden');
  });

  es.onerror = () => {
    es.close();
    elements.extractionProgress.classList.add('hidden');
  };
}

// ============================================
// Start Import
// ============================================
async function startImport(folder, exportType, subFolder) {
  console.log('[DEBUG] startImport called:', { folder, exportType, subFolder });
  goToStep(3);
  elements.importingFolder.textContent = subFolder ? `${folder}/${subFolder}` : folder;
  resetCounters();
  elements.logOutput.innerHTML = '';

  try {
    console.log('[DEBUG] Calling api.startImport...');
    const result = await api.startImport(folder, exportType, subFolder);
    console.log('[DEBUG] api.startImport result:', result);
    if (result.error) {
      addLog(`Error: ${result.error}`, 'error');
      showToast('error', 'Import Failed', result.error);
      return;
    }

    currentJobId = result.jobId;
    showToast('info', 'Import Started', `Job ID: ${result.jobId}`);
    connectToJobEvents(result.jobId);
  } catch (err) {
    addLog(`Failed to start import: ${err.message}`, 'error');
    showToast('error', 'Import Failed', err.message);
  }
}

// ============================================
// Connect to Job Events
// ============================================
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
    addLog(`▶ [${data.phase}] ${data.message}`, 'info');

    // Update stage indicator
    const stage = mapPhaseToStage(data.phase);
    if (stage) setStage(stage, 'active');
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    updateProgress(data);

    // Add progress message to live output
    if (data.message) {
      const progressInfo = data.current !== undefined && data.total !== undefined
        ? ` (${data.current}/${data.total})`
        : '';
      addLog(`[${data.phase}] ${data.message}${progressInfo}`, 'info');
    }

    // Update stage indicator based on phase
    const stage = mapPhaseToStage(data.phase);
    if (stage) setStage(stage, 'active');
  });

  eventSource.addEventListener('success', (e) => {
    const data = JSON.parse(e.data);
    addLog(`✓ [${data.phase}] ${data.message}`, 'success');
  });

  eventSource.addEventListener('error', (e) => {
    const data = JSON.parse(e.data);
    addLog(`✗ [${data.phase}] ${data.message}`, 'error');
  });

  eventSource.addEventListener('warning', (e) => {
    const data = JSON.parse(e.data);
    addLog(`⚠ [${data.phase}] ${data.message}`, 'warning');
  });

  eventSource.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    addLog(`● [${data.phase}] ${data.message}`, 'success');

    // Mark stage as completed (but not for sub-phases like cleanup:links)
    const stage = mapPhaseToStage(data.phase);
    if (stage && !data.phase.includes(':')) {
      setStage(stage, 'completed');
    }

    if (data.counters) {
      Object.entries(data.counters).forEach(([key, value]) => {
        updateCounter(key, value);
      });
    }

    // Check if this is the final completion (only exact 'cleanup' phase, not sub-phases)
    if (data.phase === 'cleanup' || data.phase === 'complete') {
      // Mark all stages as completed
      stageOrder.forEach(s => setStage(s, 'completed'));
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

// ============================================
// Progress Updates
// ============================================
function updateProgress(data) {
  if (data.phase) {
    elements.phaseLabel.textContent = `${data.phase}: ${data.message}`;
  }

  let percent = 0;
  if (data.percent !== undefined) {
    percent = data.percent;
  } else if (data.current !== undefined && data.total !== undefined && data.total > 0) {
    percent = Math.round((data.current / data.total) * 100);
  }

  elements.progressBar.style.width = `${percent}%`;
  elements.progressPercent.textContent = `${percent}%`;

  if (data.counters) {
    Object.entries(data.counters).forEach(([key, value]) => {
      updateCounter(key, value);
    });
  }
}

function updateCounter(key, value) {
  const el = document.getElementById(`counter-${key}`);
  if (el && counters[key] !== value) {
    const card = el.closest('.counter-card');

    // Animate the counter update
    el.textContent = value;
    counters[key] = value;

    if (card) {
      card.classList.add('updated');
      setTimeout(() => card.classList.remove('updated'), 300);
    }
  }
}

function resetCounters() {
  Object.keys(counters).forEach(key => {
    counters[key] = 0;
    const el = document.getElementById(`counter-${key}`);
    if (el) el.textContent = '0';
  });
  elements.progressBar.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  resetStages();
}

// ============================================
// Import Stages
// ============================================
const stageOrder = ['analyze', 'shelves', 'books', 'chapters', 'pages', 'attachments', 'cleanup'];
let currentStageIndex = -1;

function resetStages() {
  currentStageIndex = -1;
  document.querySelectorAll('.import-stages .stage').forEach(stage => {
    stage.classList.remove('active', 'completed', 'error');
  });
}

function setStage(stageName, status = 'active') {
  const stageIndex = stageOrder.indexOf(stageName);
  if (stageIndex === -1) return;

  // Mark all previous stages as completed
  stageOrder.forEach((name, i) => {
    const stageEl = document.querySelector(`.import-stages .stage[data-stage="${name}"]`);
    if (!stageEl) return;

    if (i < stageIndex) {
      stageEl.classList.remove('active', 'error');
      stageEl.classList.add('completed');
    } else if (i === stageIndex) {
      stageEl.classList.remove('completed', 'error');
      if (status === 'error') {
        stageEl.classList.add('error');
        stageEl.classList.remove('active');
      } else if (status === 'completed') {
        stageEl.classList.add('completed');
        stageEl.classList.remove('active');
      } else {
        stageEl.classList.add('active');
      }
    } else {
      stageEl.classList.remove('active', 'completed', 'error');
    }
  });

  currentStageIndex = stageIndex;
}

function mapPhaseToStage(phase) {
  const phaseMap = {
    'analyze': 'analyze',
    'import': 'analyze', // initial import phase maps to analyze
    'shelves': 'shelves',
    'books': 'books',
    'chapters': 'chapters',
    'pages': 'pages',
    'standalone-pages': 'pages',
    'chapter-pages': 'pages',
    'attachments': 'attachments',
    'cleanup': 'cleanup',
    'cleanup:links': 'cleanup',
    'cleanup:thumbnails': 'cleanup',
    'cleanup:placeholders': 'cleanup',
    'cleanup:images': 'cleanup',
    'complete': 'cleanup'
  };
  return phaseMap[phase] || null;
}

// ============================================
// Log Output
// ============================================
function addLog(message, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = message;
  elements.logOutput.appendChild(entry);
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

// ============================================
// Cancel Import
// ============================================
async function handleCancelImport() {
  const confirmed = await showConfirmDialog({
    title: 'Cancel Import?',
    message: 'This will stop the current import process. Any content already imported will remain in BookStack.',
    icon: 'danger',
    proceedText: 'Cancel Import',
    proceedClass: 'btn-danger',
  });

  if (confirmed && currentJobId) {
    await api.cancelJob(currentJobId);
    if (eventSource) {
      eventSource.close();
    }
    addLog('Import cancelled by user', 'warning');
    showToast('warning', 'Import Cancelled');

    // Update status badge
    elements.importStatusBadge.innerHTML = '<span>Cancelled</span>';
    elements.importStatusBadge.style.background = 'var(--warning-dim)';
    elements.importStatusBadge.style.color = 'var(--warning)';
  }
}

// ============================================
// Show Complete
// ============================================
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

  showToast('success', 'Migration Complete!', `Imported ${counters.pages} pages successfully`);
}

// ============================================
// Reset State
// ============================================
function resetState() {
  currentJobId = null;
  selectedExport = null;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  resetCounters();

  // Reset status badge
  elements.importStatusBadge.innerHTML = '<span class="status-pulse"></span><span>In Progress</span>';
  elements.importStatusBadge.style.background = '';
  elements.importStatusBadge.style.color = '';
}

// ============================================
// Step Navigation
// ============================================
function goToStep(step) {
  currentStep = step;

  // Update step content visibility
  elements.steps.forEach(el => el.classList.add('hidden'));
  document.getElementById(`step-${step}`)?.classList.remove('hidden');

  // Update pipeline indicators
  elements.pipelineSteps.forEach(stepEl => {
    const stepNum = parseInt(stepEl.dataset.step);
    stepEl.classList.remove('active', 'completed');

    if (stepNum < step) {
      stepEl.classList.add('completed');
    } else if (stepNum === step) {
      stepEl.classList.add('active');
    }
  });

  updatePipelineProgress();
}

function updatePipelineProgress() {
  const progress = ((currentStep - 1) / 3) * 100;
  elements.pipelineFill.style.width = `${progress}%`;
}

// ============================================
// Content Modal
// ============================================
async function showContentModal() {
  // Save current form credentials so the server can use them for API calls
  const config = {
    url: elements.bookstackUrl.value,
    id: elements.apiId.value,
    secret: elements.apiSecret.value,
    path: elements.importPath.value,
  };
  if (config.url && config.id && config.secret) {
    await api.saveConfig(config);
  }

  elements.contentModal.classList.remove('hidden');
  lucide.createIcons({ nodes: [elements.contentModal] });
  loadContentForTab();
}

function hideContentModal() {
  elements.contentModal.classList.add('hidden');
}

async function loadContentForTab() {
  elements.contentLoading.classList.remove('hidden');
  elements.contentList.classList.add('hidden');
  elements.noContent.classList.add('hidden');
  elements.deleteAllBtn.disabled = true;
  elements.contentCount.textContent = '';

  try {
    let items = [];

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

    currentTabItems = items;
    const singularType = currentTab === 'shelves' ? 'shelf' : currentTab.slice(0, -1);
    elements.contentCount.textContent = `${items.length} ${items.length === 1 ? singularType : currentTab}`;

    if (items.length === 0) {
      elements.noContent.classList.remove('hidden');
      elements.deleteAllBtn.disabled = true;
      lucide.createIcons({ nodes: [elements.noContent] });
    } else {
      renderContentItems(items, currentTab);
      elements.contentList.classList.remove('hidden');
      elements.deleteAllBtn.disabled = false;
    }
  } catch (err) {
    console.error('Failed to load content:', err);
    elements.noContent.classList.remove('hidden');
    showToast('error', 'Failed to Load Content', err.message);
    currentTabItems = [];
  } finally {
    elements.contentLoading.classList.add('hidden');
  }
}

function renderContentItems(items, type) {
  // Handle irregular plural: shelves -> shelf
  const singularType = type === 'shelves' ? 'shelf' : type.slice(0, -1);

  elements.contentList.innerHTML = items.map(item => `
    <div class="content-item" data-id="${item.id}" data-type="${singularType}">
      <div class="content-item-info">
        <div class="content-item-name">${item.name}</div>
        ${item.book_id ? `<div class="content-item-meta">Book ID: ${item.book_id}</div>` : ''}
      </div>
      <button class="delete-btn" data-id="${item.id}" data-type="${singularType}">Delete</button>
    </div>
  `).join('');

  // Add delete handlers
  elements.contentList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteContent(btn.dataset.id, btn.dataset.type);
    });
  });
}

async function handleDeleteContent(id, type) {
  const confirmed = await showConfirmDialog({
    title: `Delete ${type}?`,
    message: `Are you sure you want to delete this ${type}? This action cannot be undone.`,
    icon: 'danger',
    proceedText: 'Delete',
    proceedClass: 'btn-danger',
  });

  if (!confirmed) return;

  try {
    let result;
    if (type === 'shelf') {
      result = await api.deleteShelf(id);
    } else if (type === 'book') {
      result = await api.deleteBook(id);
    } else if (type === 'page') {
      result = await api.deletePage(id);
    } else {
      showToast('error', 'Delete Failed', `Unknown content type: ${type}`);
      return;
    }

    if (result && result.success) {
      showToast('success', `${type.charAt(0).toUpperCase() + type.slice(1)} Deleted`);
      loadContentForTab();
    } else {
      showToast('error', 'Delete Failed', 'Could not delete item');
    }
  } catch (err) {
    showToast('error', 'Delete Failed', err.message);
  }
}

async function handleDeleteAll() {
  if (currentTabItems.length === 0) return;

  const singularType = currentTab === 'shelves' ? 'shelf' : currentTab.slice(0, -1);
  const count = currentTabItems.length;

  const confirmed = await showConfirmDialog({
    title: `Delete All ${currentTab.charAt(0).toUpperCase() + currentTab.slice(1)}?`,
    message: `This will permanently delete all ${count} ${count === 1 ? singularType : currentTab}. This action cannot be undone.`,
    icon: 'danger',
    proceedText: `Delete All (${count})`,
    proceedClass: 'btn-danger',
  });

  if (!confirmed) return;

  elements.deleteAllBtn.disabled = true;
  elements.deleteAllBtn.innerHTML = '<span class="btn-loader"></span> Deleting...';

  let deleted = 0;
  let failed = 0;

  for (const item of currentTabItems) {
    try {
      let result;
      if (currentTab === 'shelves') {
        result = await api.deleteShelf(item.id);
      } else if (currentTab === 'books') {
        result = await api.deleteBook(item.id);
      } else if (currentTab === 'pages') {
        result = await api.deletePage(item.id);
      }

      if (result && result.success) {
        deleted++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    // Update button text with progress
    elements.deleteAllBtn.innerHTML = `<span class="btn-loader"></span> ${deleted + failed}/${count}`;
  }

  // Restore button
  elements.deleteAllBtn.innerHTML = '<i data-lucide="trash-2"></i><span>Delete All</span>';
  lucide.createIcons({ nodes: [elements.deleteAllBtn] });

  if (failed === 0) {
    showToast('success', 'All Deleted', `Successfully deleted ${deleted} ${deleted === 1 ? singularType : currentTab}`);
  } else {
    showToast('warning', 'Partially Deleted', `Deleted ${deleted}, failed ${failed}`);
  }

  loadContentForTab();
}

async function handleNukeEverything() {
  const confirmed = await showConfirmDialog({
    title: 'Nuke Everything?',
    message: 'This will permanently delete ALL shelves, books, and pages from BookStack. This action cannot be undone!',
    icon: 'danger',
    proceedText: 'Nuke Everything',
    proceedClass: 'btn-danger',
  });

  if (!confirmed) return;

  // Double confirmation for destructive action
  const doubleConfirmed = await showConfirmDialog({
    title: 'Are you absolutely sure?',
    message: 'This will PERMANENTLY DELETE all content. Type "NUKE" mentally and click to confirm.',
    icon: 'danger',
    proceedText: 'Yes, Nuke It All',
    proceedClass: 'btn-danger',
  });

  if (!doubleConfirmed) return;

  elements.nukeAllBtn.disabled = true;
  elements.nukeAllBtn.innerHTML = '<span class="btn-loader"></span> Nuking...';

  let totalDeleted = 0;
  let totalFailed = 0;

  try {
    // Delete all pages first
    elements.nukeAllBtn.innerHTML = '<span class="btn-loader"></span> Deleting pages...';
    const pagesData = await api.getPages();
    const pages = pagesData.pages || [];

    for (let i = 0; i < pages.length; i++) {
      try {
        const result = await api.deletePage(pages[i].id);
        if (result && result.success) totalDeleted++;
        else totalFailed++;
      } catch {
        totalFailed++;
      }
      if (i % 10 === 0) {
        elements.nukeAllBtn.innerHTML = `<span class="btn-loader"></span> Pages ${i}/${pages.length}`;
      }
    }

    // Delete all books
    elements.nukeAllBtn.innerHTML = '<span class="btn-loader"></span> Deleting books...';
    const booksData = await api.getBooks();
    const books = booksData.books || [];

    for (let i = 0; i < books.length; i++) {
      try {
        const result = await api.deleteBook(books[i].id);
        if (result && result.success) totalDeleted++;
        else totalFailed++;
      } catch {
        totalFailed++;
      }
      if (i % 5 === 0) {
        elements.nukeAllBtn.innerHTML = `<span class="btn-loader"></span> Books ${i}/${books.length}`;
      }
    }

    // Delete all shelves
    elements.nukeAllBtn.innerHTML = '<span class="btn-loader"></span> Deleting shelves...';
    const shelvesData = await api.getShelves();
    const shelves = shelvesData.shelves || [];

    for (let i = 0; i < shelves.length; i++) {
      try {
        const result = await api.deleteShelf(shelves[i].id);
        if (result && result.success) totalDeleted++;
        else totalFailed++;
      } catch {
        totalFailed++;
      }
    }

    showToast('success', 'Nuked!', `Deleted ${totalDeleted} items${totalFailed > 0 ? `, ${totalFailed} failed` : ''}`);
  } catch (err) {
    showToast('error', 'Nuke Failed', err.message);
  }

  // Restore button
  elements.nukeAllBtn.disabled = false;
  elements.nukeAllBtn.innerHTML = '<i data-lucide="bomb"></i><span>Nuke Everything</span>';
  lucide.createIcons({ nodes: [elements.nukeAllBtn] });

  loadContentForTab();
}
