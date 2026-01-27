import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { createSSEReporter, ProgressReporter } from './progress';
import { jobManager } from './job-manager';
import { runImport } from './import';
import { runXmlImport } from './xml-import';
import { runAttachments } from './attachments';

require('dotenv').config();
const AdmZip = require('adm-zip');

const PORT = parseInt(process.env.WEB_PORT || '3456', 10);

// Store active SSE connections for each job
const sseConnections: Map<string, http.ServerResponse[]> = new Map();

// MIME types for static file serving
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Helper to parse .env file
function parseEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const config: Record<string, string> = {};

  content.split('\n').forEach((line) => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      config[key.trim()] = valueParts.join('=').trim();
    }
  });

  return config;
}

// Helper to read .env config (requires all credentials)
function readEnvConfig(): { url: string; id: string; secret: string; path: string } | null {
  const config = parseEnvFile();

  if (config.URL && config.ID && config.SECRET && config.PATH_TO_HTML) {
    return {
      url: config.URL,
      id: config.ID,
      secret: config.SECRET,
      path: config.PATH_TO_HTML,
    };
  }
  return null;
}

// Helper to get import path from .env (doesn't require credentials)
function getImportPath(): string {
  const config = parseEnvFile();
  return config.PATH_TO_HTML || './import';
}

// Helper to write .env config
function writeEnvConfig(config: { url: string; id: string; secret: string; path: string }): void {
  const content = `PATH_TO_HTML=${config.path}
URL=${config.url}
ID=${config.id}
SECRET=${config.secret}
`;
  fs.writeFileSync(path.join(process.cwd(), '.env'), content);
}

// Test BookStack connection
async function testConnection(config: { url: string; id: string; secret: string }): Promise<{ success: boolean; shelfCount?: number; error?: string }> {
  try {
    const axios = require('axios');
    const response = await axios.get(`${config.url}/shelves`, {
      headers: {
        'Authorization': `Token ${config.id}:${config.secret}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    if (response.status === 200 && response.data) {
      return {
        success: true,
        shelfCount: response.data.data?.length || 0,
      };
    }
    return { success: false, error: `Unexpected response: ${response.status}` };
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED') {
      return { success: false, error: 'Connection refused - is BookStack running?' };
    }
    if (err.response?.status === 401) {
      return { success: false, error: 'Authentication failed - check API token' };
    }
    return { success: false, error: err.message || 'Unknown error' };
  }
}

// Get list of available exports
function getExports(importPath: string): Array<{ name: string; type: string; exportType: string; size?: string; pageCount?: number; spaceName?: string }> {
  const exports: Array<{ name: string; type: string; exportType: string; size?: string; pageCount?: number; spaceName?: string }> = [];

  if (!fs.existsSync(importPath)) {
    return exports;
  }

  const entries = fs.readdirSync(importPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.zip')) {
      const stats = fs.statSync(path.join(importPath, entry.name));
      exports.push({
        name: entry.name,
        type: 'zip',
        exportType: 'unknown',
        size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
      });
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const folderPath = path.join(importPath, entry.name);
      const files = fs.readdirSync(folderPath);

      let exportType: 'html' | 'xml' | 'unknown' = 'unknown';
      let pageCount = 0;
      let spaceName: string | undefined;

      if (files.includes('entities.xml')) {
        exportType = 'xml';
        try {
          const xmlContent = fs.readFileSync(path.join(folderPath, 'entities.xml'), 'utf-8');
          const pageMatches = xmlContent.match(/<object class="Page"/g);
          pageCount = pageMatches ? pageMatches.length : 0;

          const spaceMatch = xmlContent.match(/<object class="Space"[^>]*>[\s\S]*?<property name="name"><!\[CDATA\[([^\]]+)\]\]><\/property>/);
          if (spaceMatch) {
            spaceName = spaceMatch[1];
          }
        } catch {}
      } else if (files.includes('index.html')) {
        exportType = 'html';
        pageCount = files.filter(f => f.endsWith('.html') && f !== 'index.html').length;

        try {
          const indexContent = fs.readFileSync(path.join(folderPath, 'index.html'), 'utf-8');
          const titleMatch = indexContent.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch) {
            spaceName = titleMatch[1].replace(/^Home\s*-\s*/i, '').trim();
          }
        } catch {}
      }

      if (exportType !== 'unknown') {
        exports.push({
          name: entry.name,
          type: 'folder',
          exportType,
          pageCount,
          spaceName,
        });
      }
    }
  }

  return exports;
}

interface ExtractProgress {
  phase: string;
  message: string;
  current?: number;
  total?: number;
  percent?: number;
}

async function extractZipFileWithProgress(
  importPath: string,
  zipName: string,
  sendProgress: (data: ExtractProgress) => void
): Promise<{ success: boolean; folderName?: string; exportType?: string; pageCount?: number; spaceName?: string; error?: string }> {
  const zipPath = path.join(importPath, zipName);
  const folderName = zipName.replace(/\.zip$/i, '');
  const extractPath = path.join(importPath, folderName);

  try {
    if (!fs.existsSync(zipPath)) {
      return { success: false, error: 'ZIP file not found' };
    }

    const stats = fs.statSync(zipPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(0);

    sendProgress({ phase: 'init', message: `Loading ZIP file (${sizeMB} MB)...`, percent: 0 });

    await new Promise(resolve => setImmediate(resolve));

    if (fs.existsSync(extractPath)) {
      sendProgress({ phase: 'cleanup', message: 'Removing existing folder...' });
      await new Promise(resolve => setImmediate(resolve));
      fs.rmSync(extractPath, { recursive: true, force: true });
    }

    fs.mkdirSync(extractPath, { recursive: true });

    console.log(`[Extract] Loading ZIP file: ${zipPath} (${sizeMB} MB)`);
    const zip = new AdmZip(zipPath);
    console.log(`[Extract] ZIP file loaded`);
    const entries = zip.getEntries();
    const totalEntries = entries.length;

    sendProgress({
      phase: 'extract',
      message: `Extracting ${totalEntries} files...`,
      current: 0,
      total: totalEntries,
      percent: 0
    });

    let extracted = 0;
    let lastReportedPercent = -1;

    for (const entry of entries) {
      zip.extractEntryTo(entry, extractPath, true, true);
      extracted++;

      const percent = Math.floor((extracted / totalEntries) * 100);
      if (percent !== lastReportedPercent || extracted % 100 === 0) {
        lastReportedPercent = percent;
        sendProgress({
          phase: 'extract',
          message: entry.entryName.length > 50
            ? `...${entry.entryName.slice(-50)}`
            : entry.entryName,
          current: extracted,
          total: totalEntries,
          percent
        });
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    sendProgress({ phase: 'analyze', message: 'Analyzing extracted files...', percent: 100 });

    const extractedFiles = fs.readdirSync(extractPath);
    let actualFolder = folderName;

    if (extractedFiles.length === 1) {
      const nestedPath = path.join(extractPath, extractedFiles[0]);
      if (fs.statSync(nestedPath).isDirectory()) {
        const nestedFiles = fs.readdirSync(nestedPath);
        if (nestedFiles.includes('index.html') || nestedFiles.includes('entities.xml')) {
          actualFolder = `${folderName}/${extractedFiles[0]}`;
        }
      }
    }

    const checkPath = path.join(importPath, actualFolder);
    const files = fs.readdirSync(checkPath);
    let exportType: 'html' | 'xml' | 'unknown' = 'unknown';
    let pageCount = 0;
    let spaceName: string | undefined;

    if (files.includes('entities.xml')) {
      exportType = 'xml';
      sendProgress({ phase: 'analyze', message: 'Counting pages in XML export...', percent: 100 });
      try {
        const xmlContent = fs.readFileSync(path.join(checkPath, 'entities.xml'), 'utf-8');
        const matches = xmlContent.match(/<object class="Page"/g);
        pageCount = matches ? matches.length : 0;

        const spaceMatch = xmlContent.match(/<object class="Space"[^>]*>[\s\S]*?<property name="name"><!\[CDATA\[([^\]]+)\]\]><\/property>/);
        if (spaceMatch) {
          spaceName = spaceMatch[1];
        }
      } catch {}
    } else if (files.includes('index.html')) {
      exportType = 'html';
      pageCount = files.filter(f => f.endsWith('.html') && f !== 'index.html').length;

      try {
        const indexContent = fs.readFileSync(path.join(checkPath, 'index.html'), 'utf-8');
        const titleMatch = indexContent.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
          spaceName = titleMatch[1].replace(/^Home\s*-\s*/i, '').trim();
        }
      } catch {}
    }

    const spaceInfo = spaceName ? ` (${spaceName})` : '';
    sendProgress({
      phase: 'complete',
      message: `Extraction complete! Found ${pageCount} pages${spaceInfo}.`,
      percent: 100
    });

    return {
      success: true,
      folderName: actualFolder,
      exportType,
      pageCount,
      spaceName
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Get shelves from BookStack
async function getShelves(config: { url: string; id: string; secret: string }): Promise<{ shelves: any[]; error?: string }> {
  try {
    const axios = require('axios');
    const response = await axios.get(`${config.url}/shelves`, {
      headers: {
        'Authorization': `Token ${config.id}:${config.secret}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    return { shelves: response.data.data || [] };
  } catch (err: any) {
    const message = err.response?.data?.message || err.message || 'Failed to fetch shelves';
    console.error('[Shelves] Error:', message);
    return { shelves: [], error: message };
  }
}

// Delete a shelf
async function deleteShelf(config: { url: string; id: string; secret: string }, shelfId: number): Promise<boolean> {
  try {
    const axios = require('axios');
    await axios.delete(`${config.url}/shelves/${shelfId}`, {
      headers: {
        'Authorization': `Token ${config.id}:${config.secret}`,
        'Content-Type': 'application/json',
      },
    });
    return true;
  } catch {
    return false;
  }
}

// Get books from BookStack
async function getBooks(config: { url: string; id: string; secret: string }): Promise<{ books: any[]; error?: string }> {
  try {
    const axios = require('axios');
    const response = await axios.get(`${config.url}/books`, {
      headers: {
        'Authorization': `Token ${config.id}:${config.secret}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    return { books: response.data.data || [] };
  } catch (err: any) {
    const message = err.response?.data?.message || err.message || 'Failed to fetch books';
    console.error('[Books] Error:', message);
    return { books: [], error: message };
  }
}

// Delete a book
async function deleteBook(config: { url: string; id: string; secret: string }, bookId: number): Promise<boolean> {
  try {
    const axios = require('axios');
    await axios.delete(`${config.url}/books/${bookId}`, {
      headers: {
        'Authorization': `Token ${config.id}:${config.secret}`,
        'Content-Type': 'application/json',
      },
    });
    return true;
  } catch {
    return false;
  }
}

// Get pages from BookStack (paginated)
async function getPages(config: { url: string; id: string; secret: string }): Promise<{ pages: any[]; error?: string }> {
  try {
    const axios = require('axios');
    let allPages: any[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await axios.get(`${config.url}/pages`, {
        headers: {
          'Authorization': `Token ${config.id}:${config.secret}`,
          'Content-Type': 'application/json',
        },
        params: { offset, count: limit },
        timeout: 30000,
      });

      const pages = response.data.data || [];
      allPages = allPages.concat(pages);

      if (pages.length < limit) break;
      offset += limit;
    }

    return { pages: allPages };
  } catch (err: any) {
    const message = err.response?.data?.message || err.message || 'Failed to fetch pages';
    console.error('[Pages] Error:', message);
    return { pages: [], error: message };
  }
}

// Delete a page
async function deletePage(config: { url: string; id: string; secret: string }, pageId: number): Promise<boolean> {
  try {
    const axios = require('axios');
    await axios.delete(`${config.url}/pages/${pageId}`, {
      headers: {
        'Authorization': `Token ${config.id}:${config.secret}`,
        'Content-Type': 'application/json',
      },
    });
    return true;
  } catch {
    return false;
  }
}

// Parse JSON body from request
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Send JSON response
function sendJson(res: http.ServerResponse, data: any, status: number = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Serve static files from /web directory
function serveStatic(res: http.ServerResponse, filePath: string): void {
  const webDir = path.join(process.cwd(), 'web');
  const fullPath = path.join(webDir, filePath === '/' ? 'index.html' : filePath);

  // Security check - prevent directory traversal
  if (!fullPath.startsWith(webDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(fullPath);
  const mimeType = mimeTypes[ext] || 'application/octet-stream';

  const content = fs.readFileSync(fullPath);
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(content);
}

// Run import job
async function runImportJob(jobId: string, folder: string, exportType: string, reporter: ProgressReporter): Promise<void> {
  const job = jobManager.getJob(jobId);
  if (!job) return;

  jobManager.startJob(jobId);

  try {
    let result;
    if (exportType === 'xml') {
      result = await runXmlImport(folder, reporter);
    } else {
      result = await runImport(folder, reporter);
    }

    // Run attachments
    reporter.start({ phase: 'attachments', message: 'Starting attachment upload' });
    const attachResult = await runAttachments(folder, reporter);

    // Run cleanup scripts
    const { runFixAttachmentLinks } = require('../fixAttachmentLinks.js');
    const { runFixEmbeddedImages } = require('../fixEmbeddedImages.js');
    const { runRemoveConfluencePlaceholders } = require('../removeConfluencePlaceholders.js');
    const { runRemoveConfluenceThumbnails } = require('../removeConfluenceThumbnails.js');

    reporter.start({ phase: 'cleanup', message: 'Running cleanup scripts' });

    await runFixAttachmentLinks(folder, reporter);
    await runRemoveConfluenceThumbnails(reporter);
    await runRemoveConfluencePlaceholders(reporter);
    await runFixEmbeddedImages(folder, reporter);

    jobManager.completeJob(jobId, { ...result, attachments: attachResult });
  } catch (err: any) {
    jobManager.failJob(jobId, err.message);
  }
}

// Handle API requests
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const method = req.method || 'GET';
  const config = readEnvConfig();

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /api/config
  if (pathname === '/api/config' && method === 'GET') {
    if (config) {
      sendJson(res, {
        configured: true,
        url: config.url,
        path: config.path,
        hasCredentials: !!(config.id && config.secret),
      });
    } else {
      sendJson(res, { configured: false });
    }
    return;
  }

  // POST /api/config
  if (pathname === '/api/config' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const existingConfig = readEnvConfig();
      writeEnvConfig({
        url: body.url || '',
        id: body.id || existingConfig?.id || '',
        secret: body.secret || existingConfig?.secret || '',
        path: body.path || './import',
      });
      sendJson(res, { success: true });
    } catch (err: any) {
      sendJson(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // POST /api/config/test
  if (pathname === '/api/config/test' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const testConfig = {
        url: body.url || config?.url || '',
        id: body.id || config?.id || '',
        secret: body.secret || config?.secret || '',
      };
      const result = await testConnection(testConfig);
      sendJson(res, result);
    } catch (err: any) {
      sendJson(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // GET /api/exports
  if (pathname === '/api/exports' && method === 'GET') {
    const importPath = getImportPath();
    const exports = getExports(importPath);
    sendJson(res, { exports, path: importPath });
    return;
  }

  // GET /api/extract/:zipName/stream
  const extractStreamMatch = pathname.match(/^\/api\/extract\/(.+)\/stream$/);
  if (extractStreamMatch && method === 'GET') {
    const importPath = getImportPath();
    const zipName = decodeURIComponent(extractStreamMatch[1]);

    console.log(`[SSE] Starting extraction stream for: ${zipName}`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const flush = () => {
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    };

    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ zipName })}\n\n`);
    flush();

    console.log(`[SSE] Connected event sent`);

    const sendProgress = (data: any) => {
      if (!res.writableEnded) {
        res.write(`event: progress\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        flush();
      }
    };

    (async () => {
      try {
        console.log(`[SSE] Starting extraction...`);
        const result = await extractZipFileWithProgress(importPath, zipName, sendProgress);
        console.log(`[SSE] Extraction complete:`, result.success);

        if (!res.writableEnded) {
          res.write(`event: complete\n`);
          res.write(`data: ${JSON.stringify(result)}\n\n`);
          flush();
          res.end();
        }
      } catch (err: any) {
        console.error(`[SSE] Extraction error:`, err.message);
        if (!res.writableEnded) {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ success: false, error: err.message })}\n\n`);
          flush();
          res.end();
        }
      }
    })();

    req.on('close', () => {
      console.log(`[SSE] Client disconnected`);
    });

    return;
  }

  // POST /api/import/:folder
  const importMatch = pathname.match(/^\/api\/import\/(.+)$/);
  if (importMatch && method === 'POST') {
    if (!config) {
      sendJson(res, { error: 'Not configured' }, 400);
      return;
    }

    const folder = decodeURIComponent(importMatch[1]);
    const body = await parseBody(req);
    const exportType = body.exportType || 'html';

    const currentJob = jobManager.getCurrentJob();
    if (currentJob) {
      sendJson(res, { error: 'A job is already running', jobId: currentJob.id }, 409);
      return;
    }

    const job = jobManager.createJob(exportType === 'xml' ? 'xml-import' : 'import', folder);
    sendJson(res, { jobId: job.id, status: 'pending' });

    const reporter = createSSEReporter(res, job.id);

    const originalEmit = reporter.emit.bind(reporter);
    reporter.emit = (event: string, data: any): boolean => {
      const connections = sseConnections.get(job.id) || [];
      for (const conn of connections) {
        if (!conn.writableEnded) {
          conn.write(`event: ${event}\n`);
          conn.write(`data: ${JSON.stringify({ ...data, jobId: job.id, timestamp: Date.now() })}\n\n`);
        }
      }
      return originalEmit(event, data);
    };

    setImmediate(() => runImportJob(job.id, folder, exportType, reporter));

    return;
  }

  // GET /api/job/:id/events (SSE)
  const jobEventsMatch = pathname.match(/^\/api\/job\/([^/]+)\/events$/);
  if (jobEventsMatch && method === 'GET') {
    const jobId = jobEventsMatch[1];
    const job = jobManager.getJob(jobId);

    if (!job) {
      sendJson(res, { error: 'Job not found' }, 404);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({ jobId, status: job.status, startedAt: job.startedAt })}\n\n`);

    if (!sseConnections.has(jobId)) {
      sseConnections.set(jobId, []);
    }
    sseConnections.get(jobId)!.push(res);

    req.on('close', () => {
      const connections = sseConnections.get(jobId);
      if (connections) {
        const index = connections.indexOf(res);
        if (index > -1) {
          connections.splice(index, 1);
        }
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`:heartbeat\n\n`);
      } else {
        clearInterval(heartbeat);
      }
    }, 30000);

    return;
  }

  // GET /api/job/:id
  const jobMatch = pathname.match(/^\/api\/job\/([^/]+)$/);
  if (jobMatch && method === 'GET') {
    const jobId = jobMatch[1];
    const job = jobManager.getJob(jobId);

    if (!job) {
      sendJson(res, { error: 'Job not found' }, 404);
      return;
    }

    sendJson(res, job);
    return;
  }

  // POST /api/job/:id/cancel
  const cancelMatch = pathname.match(/^\/api\/job\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const jobId = cancelMatch[1];
    const cancelled = jobManager.cancelJob(jobId);

    if (cancelled) {
      sendJson(res, { success: true });
    } else {
      sendJson(res, { error: 'Cannot cancel job' }, 400);
    }
    return;
  }

  // GET /api/shelves
  if (pathname === '/api/shelves' && method === 'GET') {
    if (!config) {
      sendJson(res, { error: 'Not configured' }, 400);
      return;
    }
    const result = await getShelves(config);
    if (result.error) {
      sendJson(res, { shelves: [], error: result.error });
    } else {
      sendJson(res, { shelves: result.shelves });
    }
    return;
  }

  // DELETE /api/shelves/:id
  const deleteShelfMatch = pathname.match(/^\/api\/shelves\/(\d+)$/);
  if (deleteShelfMatch && method === 'DELETE') {
    if (!config) {
      sendJson(res, { error: 'Not configured' }, 400);
      return;
    }
    const shelfId = parseInt(deleteShelfMatch[1], 10);
    const success = await deleteShelf(config, shelfId);
    sendJson(res, { success });
    return;
  }

  // GET /api/books
  if (pathname === '/api/books' && method === 'GET') {
    if (!config) {
      sendJson(res, { error: 'Not configured' }, 400);
      return;
    }
    const result = await getBooks(config);
    if (result.error) {
      sendJson(res, { books: [], error: result.error });
    } else {
      sendJson(res, { books: result.books });
    }
    return;
  }

  // DELETE /api/books/:id
  const deleteBookMatch = pathname.match(/^\/api\/books\/(\d+)$/);
  if (deleteBookMatch && method === 'DELETE') {
    if (!config) {
      sendJson(res, { error: 'Not configured' }, 400);
      return;
    }
    const bookId = parseInt(deleteBookMatch[1], 10);
    const success = await deleteBook(config, bookId);
    sendJson(res, { success });
    return;
  }

  // GET /api/pages
  if (pathname === '/api/pages' && method === 'GET') {
    if (!config) {
      sendJson(res, { error: 'Not configured' }, 400);
      return;
    }
    const result = await getPages(config);
    if (result.error) {
      sendJson(res, { pages: [], error: result.error });
    } else {
      sendJson(res, { pages: result.pages });
    }
    return;
  }

  // DELETE /api/pages/:id
  const deletePageMatch = pathname.match(/^\/api\/pages\/(\d+)$/);
  if (deletePageMatch && method === 'DELETE') {
    if (!config) {
      sendJson(res, { error: 'Not configured' }, 400);
      return;
    }
    const pageId = parseInt(deletePageMatch[1], 10);
    const success = await deletePage(config, pageId);
    sendJson(res, { success });
    return;
  }

  // 404 for unknown API routes
  sendJson(res, { error: 'Not found' }, 404);
}

// Main request handler
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || '/');
  const pathname = parsedUrl.pathname || '/';

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(res, pathname);
    }
  } catch (err: any) {
    console.error('Server error:', err);
    res.writeHead(500);
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`\x1b[32m✓ Web interface running at http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[36m  Open this URL in your browser to use the wizard\x1b[0m`);
});
