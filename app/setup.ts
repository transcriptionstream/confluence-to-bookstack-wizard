import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, SpawnOptions } from 'child_process';

const AdmZip = require('adm-zip');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgMagenta: '\x1b[45m',
  bgYellow: '\x1b[43m',
  bgCyan: '\x1b[46m',
};

// ANSI escape sequences for cursor/screen control
const ansi = {
  saveCursor: '\x1b[s',
  restoreCursor: '\x1b[u',
  moveToTop: '\x1b[H',
  moveToLine: (n: number) => `\x1b[${n};0H`,
  clearLine: '\x1b[2K',
  clearToBottom: '\x1b[J',
  scrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
  resetScrollRegion: '\x1b[r',
};

// Status bar state
let currentStatus = {
  step: '',
  total: '',
  operation: '',
  subOperation: '',
};

const STATUS_HEIGHT = 4; // Lines reserved for status bar

// Draw the status bar at the top of the screen
const drawStatusBar = () => {
  const termWidth = process.stdout.columns || 80;
  const line = '─'.repeat(termWidth);

  process.stdout.write(ansi.saveCursor);
  process.stdout.write(ansi.moveToTop);

  // Line 1: Step progress
  process.stdout.write(ansi.clearLine);
  if (currentStatus.step) {
    process.stdout.write(`${colors.bgCyan}${colors.bright}${colors.white} ${currentStatus.step} ${colors.reset}`);
    if (currentStatus.total) {
      process.stdout.write(`${colors.dim} of ${currentStatus.total}${colors.reset}`);
    }
  }
  process.stdout.write('\n');

  // Line 2: Current operation
  process.stdout.write(ansi.clearLine);
  if (currentStatus.operation) {
    process.stdout.write(`${colors.yellow}▶ ${currentStatus.operation}${colors.reset}`);
  }
  process.stdout.write('\n');

  // Line 3: Sub-operation details
  process.stdout.write(ansi.clearLine);
  if (currentStatus.subOperation) {
    process.stdout.write(`${colors.dim}  ${currentStatus.subOperation}${colors.reset}`);
  }
  process.stdout.write('\n');

  // Line 4: Separator
  process.stdout.write(ansi.clearLine);
  process.stdout.write(`${colors.dim}${line}${colors.reset}\n`);

  process.stdout.write(ansi.restoreCursor);
};

// Update status bar
const setStatus = (step?: string, operation?: string, subOperation?: string, total?: string) => {
  if (step !== undefined) currentStatus.step = step;
  if (operation !== undefined) currentStatus.operation = operation;
  if (subOperation !== undefined) currentStatus.subOperation = subOperation;
  if (total !== undefined) currentStatus.total = total;
  drawStatusBar();
};

// Clear status bar
const clearStatus = () => {
  currentStatus = { step: '', total: '', operation: '', subOperation: '' };
  process.stdout.write(ansi.moveToTop);
  for (let i = 0; i < STATUS_HEIGHT; i++) {
    process.stdout.write(ansi.clearLine + '\n');
  }
  process.stdout.write(ansi.moveToTop);
};

// Setup scrolling region below status bar
const setupScrollRegion = () => {
  const termHeight = process.stdout.rows || 24;
  process.stdout.write(ansi.scrollRegion(STATUS_HEIGHT + 1, termHeight));
  process.stdout.write(ansi.moveToLine(STATUS_HEIGHT + 1));
};

// Reset scrolling region
const resetScrollRegion = () => {
  process.stdout.write(ansi.resetScrollRegion);
};

let rl: readline.Interface;

const initReadline = () => {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
};

const closeReadline = () => {
  if (rl) {
    rl.close();
  }
};

const question = (prompt: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
};

const clearScreen = () => {
  console.clear();
};

const printBanner = () => {
  const width = 66;
  const line = '═'.repeat(width);
  const empty = ' '.repeat(width);

  const centerText = (text: string, w: number) => {
    const pad = Math.floor((w - text.length) / 2);
    const padRight = w - text.length - pad;
    return ' '.repeat(pad) + text + ' '.repeat(padRight);
  };

  const title = 'Confluence to BookStack Importer';
  const subtitle = 'Interactive Import Manager';

  console.log('');
  console.log(`${colors.cyan}╔${line}╗${colors.reset}`);
  console.log(`${colors.cyan}║${empty}║${colors.reset}`);
  console.log(`${colors.cyan}║${colors.bright}${colors.magenta}${centerText(title, width)}${colors.reset}${colors.cyan}║${colors.reset}`);
  console.log(`${colors.cyan}║${colors.dim}${centerText(subtitle, width)}${colors.reset}${colors.cyan}║${colors.reset}`);
  console.log(`${colors.cyan}║${empty}║${colors.reset}`);
  console.log(`${colors.cyan}╚${line}╝${colors.reset}`);
  console.log('');
};

const printSection = (title: string) => {
  console.log(`\n${colors.bgBlue}${colors.bright} ${title} ${colors.reset}\n`);
};

const printSuccess = (message: string) => {
  console.log(`${colors.green}✓ ${message}${colors.reset}`);
};

const printInfo = (message: string) => {
  console.log(`${colors.cyan}ℹ ${message}${colors.reset}`);
};

const printWarning = (message: string) => {
  console.log(`${colors.yellow}⚠ ${message}${colors.reset}`);
};

const printError = (message: string) => {
  console.log(`${colors.red}✗ ${message}${colors.reset}`);
};

interface EnvConfig {
  PATH_TO_HTML: string;
  URL: string;
  ID: string;
  SECRET: string;
}

const readExistingEnv = (): EnvConfig | null => {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return null;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const config: Partial<EnvConfig> = {};

  content.split('\n').forEach((line) => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim();
      if (key === 'PATH_TO_HTML' || key === 'URL' || key === 'ID' || key === 'SECRET') {
        config[key] = value;
      }
    }
  });

  if (config.PATH_TO_HTML && config.URL && config.ID && config.SECRET) {
    return config as EnvConfig;
  }
  return null;
};

const writeEnvFile = (config: EnvConfig) => {
  const content = `PATH_TO_HTML=${config.PATH_TO_HTML}
URL=${config.URL}
ID=${config.ID}
SECRET=${config.SECRET}
`;
  fs.writeFileSync(path.join(process.cwd(), '.env'), content);
};

const selectFromList = async (prompt: string, options: { label: string; value: string; description?: string }[]): Promise<string> => {
  console.log(`\n${colors.bright}${prompt}${colors.reset}\n`);

  options.forEach((opt, i) => {
    const desc = opt.description ? ` ${colors.dim}- ${opt.description}${colors.reset}` : '';
    console.log(`  ${colors.cyan}${i + 1}${colors.reset}) ${opt.label}${desc}`);
  });

  while (true) {
    const answer = await question(`\nEnter choice (1-${options.length}): `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) {
      return options[num - 1].value;
    }
    printError(`Please enter a number between 1 and ${options.length}`);
  }
};

const findZipFiles = (dir: string): string[] => {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.zip')) {
        files.push(path.join(dir, entry.name));
      }
    }
  } catch {
    // Ignore errors
  }
  return files;
};

const findFolders = (dir: string): string[] => {
  const folders: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
        folders.push(entry.name);
      }
    }
  } catch {
    // Ignore errors
  }
  return folders;
};

const findHtmlExportFolders = (baseDir: string): string[] => {
  const results: string[] = [];

  const checkFolder = (folderPath: string, relativePath: string) => {
    try {
      const files = fs.readdirSync(folderPath);
      const hasHtmlFiles = files.some(f => f.endsWith('.html'));
      const hasIndex = files.includes('index.html');

      if (hasHtmlFiles && hasIndex) {
        results.push(relativePath);
      }
    } catch {
      // Ignore errors
    }
  };

  const scanDir = (dir: string, prefix: string = '') => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') &&
            entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'attachments') {
          const fullPath = path.join(dir, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          checkFolder(fullPath, relativePath);
          if (!prefix) {
            scanDir(fullPath, entry.name);
          }
        }
      }
    } catch {
      // Ignore errors
    }
  };

  scanDir(baseDir);
  return results;
};

const extractZipFile = async (zipPath: string, destPath: string): Promise<boolean> => {
  try {
    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(destPath, { recursive: true });
    }

    const resolvedZip = path.resolve(zipPath);
    const resolvedDest = path.resolve(destPath);

    // Use adm-zip - handles absolute paths and is cross-platform
    const zip = new AdmZip(resolvedZip);
    zip.extractAllTo(resolvedDest, true); // true = overwrite

    // Verify extraction succeeded by checking destination has files
    const extractedFiles = fs.readdirSync(resolvedDest);
    if (extractedFiles.length > 0) {
      printSuccess(`Extracted to ${destPath}`);
      return true;
    }

    printError('Extraction produced no files');
    return false;
  } catch (err: any) {
    printError(`Failed to extract: ${err.message}`);
    return false;
  }
};

const promptWithDefault = async (prompt: string, defaultValue: string): Promise<string> => {
  const displayDefault = defaultValue ? ` ${colors.dim}(${defaultValue})${colors.reset}` : '';
  const answer = await question(`${prompt}${displayDefault}: `);
  return answer.trim() || defaultValue;
};

const promptPassword = async (prompt: string, defaultValue: string = ''): Promise<string> => {
  const displayDefault = defaultValue ? ` ${colors.dim}(press Enter to keep existing)${colors.reset}` : '';
  const answer = await question(`${prompt}${displayDefault}: `);
  return answer.trim() || defaultValue;
};

const confirmPrompt = async (prompt: string, defaultYes: boolean = true): Promise<boolean> => {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await question(`${prompt} ${colors.dim}${hint}${colors.reset}: `);
  const normalized = answer.trim().toLowerCase();

  if (normalized === '') {
    return defaultYes;
  }
  return normalized === 'y' || normalized === 'yes';
};

const waitForEnter = async (message: string = 'Press Enter to continue...') => {
  await question(`\n${colors.dim}${message}${colors.reset}`);
};

// Test BookStack API connection
interface ConnectionTestResult {
  success: boolean;
  error?: string;
  shelfCount?: number;
}

const testBookStackConnection = async (config: EnvConfig): Promise<ConnectionTestResult> => {
  try {
    const axios = require('axios');

    const response = await axios.get(`${config.URL}/shelves`, {
      headers: {
        'Authorization': `Token ${config.ID}:${config.SECRET}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10 second timeout
    });

    if (response.status === 200 && response.data) {
      return {
        success: true,
        shelfCount: response.data.data?.length || 0,
      };
    }

    return {
      success: false,
      error: `Unexpected response: ${response.status}`,
    };
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED') {
      return { success: false, error: 'Connection refused - is BookStack running?' };
    }
    if (err.code === 'ENOTFOUND') {
      return { success: false, error: `Host not found: ${err.hostname}` };
    }
    if (err.response?.status === 401) {
      return { success: false, error: 'Authentication failed - check API token ID and secret' };
    }
    if (err.response?.status === 403) {
      return { success: false, error: 'Access forbidden - API token may lack permissions' };
    }
    if (err.response?.status === 404) {
      return { success: false, error: 'API endpoint not found - check URL includes /api' };
    }
    return { success: false, error: err.message || 'Unknown error' };
  }
};

// Execute a command and stream output with status bar support
const runCommand = (command: string, args: string[], options: SpawnOptions = {}, statusLabel?: string): Promise<number> => {
  return new Promise((resolve) => {
    const cmdDisplay = `${command} ${args.join(' ')}`;

    // Update status bar if label provided
    if (statusLabel) {
      setStatus(undefined, statusLabel, cmdDisplay);
      console.log(`\n${colors.cyan}▶ ${statusLabel}${colors.reset}\n`);
    } else {
      console.log(`\n${colors.cyan}▶ Running command...${colors.reset}\n`);
    }

    // On Windows, use shell for npm/node commands to resolve .cmd files
    const isWindows = process.platform === 'win32';

    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: isWindows,
      ...options,
    });

    child.on('close', (code) => {
      resolve(code || 0);
    });

    child.on('error', (err) => {
      printError(`Failed to execute: ${err.message}`);
      resolve(1);
    });
  });
};

// Run npm script with optional status label
const runNpmScript = async (script: string, args: string[] = [], statusLabel?: string): Promise<number> => {
  const fullArgs = ['run', script, ...args];
  return runCommand('npm', fullArgs, {}, statusLabel || `Running npm ${script}`);
};

// Run a Node.js script directly with optional status label
const runNodeScript = async (scriptPath: string, args: string[] = [], statusLabel?: string): Promise<number> => {
  return runCommand('node', [scriptPath, ...args], {}, statusLabel || `Running ${scriptPath}`);
};

// ============================================================================
// MAIN MENU
// ============================================================================

const showMainMenu = async (): Promise<string> => {
  const config = readExistingEnv();
  const configStatus = config ? `${colors.green}✓ Configured${colors.reset}` : `${colors.yellow}⚠ Not configured${colors.reset}`;

  console.log(`\n${colors.dim}Configuration: ${configStatus}${colors.reset}`);
  if (config) {
    console.log(`${colors.dim}BookStack: ${config.URL}${colors.reset}`);

    // Show import folder with contents summary
    const importPath = config.PATH_TO_HTML;
    const resolvedPath = path.resolve(importPath);
    let folderStatus = '';

    if (fs.existsSync(importPath)) {
      const zips = findZipFiles(importPath);
      const folders = findHtmlExportFolders(importPath);
      folderStatus = `${colors.dim}(${zips.length} ZIPs, ${folders.length} folders)${colors.reset}`;
    } else {
      folderStatus = `${colors.yellow}(not found)${colors.reset}`;
    }

    console.log(`${colors.dim}Import Folder: ${importPath} ${folderStatus}${colors.reset}`);
  }

  return selectFromList('What would you like to do?', [
    { label: '⚙️  Configure', value: 'configure', description: 'Set up BookStack connection & import source' },
    { label: '🚀 Full Import Workflow', value: 'workflow', description: 'Run complete import: space → attachments → cleanup' },
    { label: '📥 Import Space', value: 'import', description: 'Import Confluence HTML export to BookStack' },
    { label: '📎 Upload Attachments', value: 'attachments', description: 'Upload attachments for imported pages' },
    { label: '🧹 Post-Import Cleanup', value: 'cleanup', description: 'Fix links, images, and remove artifacts' },
    { label: '🗑️  Delete Shelf', value: 'delete', description: 'Remove a shelf and all its contents' },
    { label: '🚪 Exit', value: 'exit', description: 'Exit the importer' },
  ]);
};

// ============================================================================
// CONFIGURATION
// ============================================================================

const runConfiguration = async () => {
  clearScreen();
  printBanner();
  printSection('Configuration');

  const existingConfig = readExistingEnv();
  let config: EnvConfig = {
    PATH_TO_HTML: './import',
    URL: '',
    ID: '',
    SECRET: '',
  };

  if (existingConfig) {
    printInfo('Existing configuration found.');
    console.log(`  URL: ${colors.cyan}${existingConfig.URL}${colors.reset}`);
    console.log(`  Import Folder: ${colors.cyan}${existingConfig.PATH_TO_HTML}${colors.reset}`);

    // Show what's in the current import folder
    if (fs.existsSync(existingConfig.PATH_TO_HTML)) {
      const zips = findZipFiles(existingConfig.PATH_TO_HTML);
      const folders = findHtmlExportFolders(existingConfig.PATH_TO_HTML);
      console.log(`  ${colors.dim}Contents: ${zips.length} ZIP files, ${folders.length} export folders${colors.reset}`);
    }

    const reconfigure = await confirmPrompt('\nWould you like to modify the existing configuration?', false);
    if (!reconfigure) {
      return;
    }
    // Keep existing config but use ./import as default if current path is just "."
    config = existingConfig;
    if (config.PATH_TO_HTML === '.') {
      config.PATH_TO_HTML = './import';
    }
  }

  // BookStack Configuration
  printSection('BookStack API Configuration');

  console.log(`${colors.dim}You'll need your BookStack instance URL and API credentials.
Generate API tokens in BookStack: Settings → Users → [Your User] → API Tokens${colors.reset}\n`);

  config.URL = await promptWithDefault('BookStack API URL (e.g., http://localhost:6875/api)', config.URL);
  config.URL = config.URL.replace(/\/+$/, '');

  // Ensure URL ends with /api
  if (!config.URL.endsWith('/api')) {
    const addApi = await confirmPrompt(`URL doesn't end with /api. Add it? (${config.URL}/api)`, true);
    if (addApi) {
      config.URL = config.URL + '/api';
    }
  }

  config.ID = await promptWithDefault('API Token ID', config.ID);
  config.SECRET = await promptPassword('API Token Secret', config.SECRET);

  // Test connection
  printSection('Testing Connection');
  console.log(`${colors.dim}Verifying API connection to ${config.URL}...${colors.reset}\n`);

  const testResult = await testBookStackConnection(config);
  if (testResult.success) {
    printSuccess(`Connected to BookStack successfully!`);
    if (testResult.shelfCount !== undefined) {
      console.log(`  ${colors.dim}Found ${testResult.shelfCount} existing shelves${colors.reset}`);
    }
  } else {
    printError(`Connection failed: ${testResult.error}`);
    const continueAnyway = await confirmPrompt('\nSave configuration anyway?', false);
    if (!continueAnyway) {
      printInfo('Configuration cancelled. Please check your BookStack URL and credentials.');
      await waitForEnter();
      return;
    }
  }

  // Import Folder Selection
  printSection('Import Folder');

  console.log(`${colors.dim}Set the folder where your Confluence exports (ZIPs and folders) are stored.${colors.reset}\n`);

  config.PATH_TO_HTML = await promptWithDefault('Import folder path', config.PATH_TO_HTML);

  // Create folder if it doesn't exist
  if (!fs.existsSync(config.PATH_TO_HTML)) {
    const create = await confirmPrompt(`Folder "${config.PATH_TO_HTML}" doesn't exist. Create it?`, true);
    if (create) {
      fs.mkdirSync(config.PATH_TO_HTML, { recursive: true });
      printSuccess(`Created ${config.PATH_TO_HTML}`);
    }
  }

  // Save configuration
  writeEnvFile(config);
  printSuccess('.env file saved successfully!');

  // Summary
  printSection('Configuration Summary');
  console.log(`  ${colors.cyan}BookStack URL:${colors.reset} ${config.URL}`);
  console.log(`  ${colors.cyan}API Token ID:${colors.reset} ${config.ID}`);
  console.log(`  ${colors.cyan}API Secret:${colors.reset} ${'*'.repeat(Math.min(config.SECRET.length, 20))}`);
  console.log(`  ${colors.cyan}Import Folder:${colors.reset} ${config.PATH_TO_HTML}`);

  // Show what's in the import folder
  if (fs.existsSync(config.PATH_TO_HTML)) {
    const zipFiles = findZipFiles(config.PATH_TO_HTML);
    const exports = findHtmlExportFolders(config.PATH_TO_HTML);

    if (zipFiles.length > 0 || exports.length > 0) {
      console.log(`\n${colors.bright}Contents of import folder:${colors.reset}`);
      zipFiles.forEach(z => {
        const stats = fs.statSync(z);
        const size = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`  ${colors.yellow}📦${colors.reset} ${path.basename(z)} ${colors.dim}(${size} MB ZIP)${colors.reset}`);
      });
      exports.forEach(e => {
        console.log(`  ${colors.green}📁${colors.reset} ${e} ${colors.dim}(ready to import)${colors.reset}`);
      });
    } else {
      printInfo('Import folder is empty. Add ZIP files or extracted Confluence exports here.');
    }
  }

  await waitForEnter();
};

// Extract a ZIP file to a folder with the same name (minus .zip)
const extractZipToFolder = async (zipPath: string, baseDir: string): Promise<string | null> => {
  const zipName = path.basename(zipPath, '.zip');
  const extractTo = path.join(baseDir, zipName);

  if (fs.existsSync(extractTo)) {
    const overwrite = await confirmPrompt(`Folder "${zipName}" already exists. Overwrite?`, false);
    if (!overwrite) {
      return null;
    }
  }

  const success = await extractZipFile(zipPath, extractTo);
  return success ? zipName : null;
};

// Analyze a Confluence export folder and return details
type ExportType = 'html' | 'xml' | 'unknown';

interface ExportAnalysis {
  spaceName: string;
  folderName: string;
  pageCount: number;
  attachmentCount: number;
  attachmentSize: string;
  hasIndex: boolean;
  exportType: ExportType;
}

const analyzeExportFolder = (exportPath: string, folderName: string): ExportAnalysis | null => {
  const fullPath = path.join(exportPath, folderName);

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  try {
    const files = fs.readdirSync(fullPath);
    const htmlFiles = files.filter((f: string) => f.endsWith('.html') && f !== 'index.html');
    const hasIndex = files.includes('index.html');
    const hasEntitiesXml = files.includes('entities.xml');

    // Determine export type
    let exportType: ExportType = 'unknown';
    if (hasEntitiesXml) {
      exportType = 'xml';
    } else if (hasIndex && htmlFiles.length > 0) {
      exportType = 'html';
    }

    // Try to get space name
    let spaceName = folderName;
    let pageCount = 0;

    if (exportType === 'html') {
      // HTML export: get space name from index.html
      const indexPath = path.join(fullPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
          spaceName = titleMatch[1].replace(' - Pair Knowledge Base', '').replace(' Home', '').trim();
        }
      }
      pageCount = htmlFiles.length;
    } else if (exportType === 'xml') {
      // XML export: try to get space name from entities.xml
      const entitiesPath = path.join(fullPath, 'entities.xml');
      try {
        const content = fs.readFileSync(entitiesPath, 'utf-8');
        // Look for Space name in XML
        const spaceMatch = content.match(/<property name="name"><!\[CDATA\[([^\]]+)\]\]><\/property>/);
        if (spaceMatch) {
          spaceName = spaceMatch[1];
        }
        // Count Page objects (rough estimate)
        const pageMatches = content.match(/<object class="Page"/g);
        pageCount = pageMatches ? pageMatches.length : 0;
      } catch {
        // Ignore parse errors
      }
    }

    // Count attachments
    let attachmentCount = 0;
    let attachmentSize = 0;
    const attachmentsPath = path.join(fullPath, 'attachments');
    if (fs.existsSync(attachmentsPath)) {
      const countAttachments = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            countAttachments(entryPath);
          } else {
            attachmentCount++;
            attachmentSize += fs.statSync(entryPath).size;
          }
        }
      };
      countAttachments(attachmentsPath);
    }

    const sizeMB = (attachmentSize / 1024 / 1024).toFixed(2);

    return {
      spaceName,
      folderName,
      pageCount,
      attachmentCount,
      attachmentSize: `${sizeMB} MB`,
      hasIndex,
      exportType,
    };
  } catch {
    return null;
  }
};

// Get import summary from BookStack API
const getImportSummary = async (config: EnvConfig): Promise<{ shelves: any[], books: any[], totalPages: number } | null> => {
  try {
    const axios = require('axios');
    const client = axios.create({
      baseURL: config.URL,
      headers: {
        'Authorization': `Token ${config.ID}:${config.SECRET}`,
        'Content-Type': 'application/json'
      }
    });

    // Get shelves
    const shelvesResp = await client.get('/shelves');
    const shelves = shelvesResp.data.data || [];

    // Get books
    const booksResp = await client.get('/books');
    const books = booksResp.data.data || [];

    // Get total page count
    const pagesResp = await client.get('/pages');
    const totalPages = pagesResp.data.total || pagesResp.data.data?.length || 0;

    return { shelves, books, totalPages };
  } catch (err) {
    return null;
  }
};

// Run the full import workflow for a folder
const runFullImportForFolder = async (subfolder: string, config: EnvConfig, exportType: ExportType = 'html'): Promise<void> => {
  closeReadline();

  const isXml = exportType === 'xml';
  const importCommand = isXml ? 'xml-import' : 'import';
  const importLabel = isXml ? 'XML Import' : 'HTML Import';
  const totalSteps = isXml ? '3' : '3';

  // Get export analysis for summary
  const exportPath = config.PATH_TO_HTML || './import';
  const analysis = analyzeExportFolder(exportPath, subfolder);

  // Get BookStack state before import for comparison
  const beforeState = await getImportSummary(config);
  const beforeShelfCount = beforeState?.shelves.length || 0;
  const beforeBookCount = beforeState?.books.length || 0;
  const beforePageCount = beforeState?.totalPages || 0;

  // Clear screen and set up status bar
  clearScreen();
  setupScrollRegion();

  // Step 1: Import
  setStatus('Step 1', `Importing Space (${importLabel})`, subfolder, totalSteps);
  await runNpmScript(importCommand, [subfolder], `Importing ${subfolder}`);

  // Step 2: Attachments (only for HTML imports - XML embeds attachments)
  if (!isXml) {
    setStatus('Step 2', 'Uploading Attachments', subfolder, totalSteps);
    await runNpmScript('attach', [subfolder], 'Uploading attachments');
  } else {
    setStatus('Step 2', 'Attachments', 'Embedded in pages (XML)', totalSteps);
    console.log(`\n${colors.dim}XML import embeds attachments automatically.${colors.reset}\n`);
  }

  // Step 3: Cleanup
  setStatus('Step 3', 'Running Cleanup', 'Fixing attachment links...', totalSteps);
  await runNodeScript('fixAttachmentLinks.js', [subfolder], 'Fixing attachment links');

  setStatus('Step 3', 'Running Cleanup', 'Removing thumbnails...', totalSteps);
  await runNodeScript('removeConfluenceThumbnails.js', [], 'Removing thumbnails');

  setStatus('Step 3', 'Running Cleanup', 'Removing placeholders...', totalSteps);
  await runNodeScript('removeConfluencePlaceholders.js', [], 'Removing placeholders');

  setStatus('Step 3', 'Running Cleanup', 'Fixing embedded images...', totalSteps);
  await runNodeScript('fixEmbeddedImages.js', [subfolder], 'Fixing embedded images');

  // Complete
  resetScrollRegion();
  clearStatus();

  // Get BookStack state after import for comparison
  const afterState = await getImportSummary(config);
  const newShelves = afterState?.shelves.filter(s =>
    !beforeState?.shelves.find(bs => bs.id === s.id)
  ) || [];
  const newBooks = afterState?.books.filter(b =>
    !beforeState?.books.find(bb => bb.id === b.id)
  ) || [];
  const newPageCount = (afterState?.totalPages || 0) - beforePageCount;

  initReadline();

  // Print summary
  const termWidth = process.stdout.columns || 80;
  const innerWidth = Math.min(63, termWidth - 6); // Content width inside the box
  const line = '═'.repeat(innerWidth);

  // Truncate text to fit in box
  const truncate = (text: string, maxLen: number) => {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
  };

  const padLine = (text: string, color: string = '') => {
    const plainText = text.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI for length calc
    const padding = innerWidth - plainText.length;
    if (padding < 0) {
      // Text too long - truncate it
      const truncated = truncate(plainText, innerWidth);
      return `║${color}${truncated}${colors.reset}║`;
    }
    return `║${color}${text}${' '.repeat(padding)}${colors.reset}║`;
  };

  // Truncate source name if needed
  const sourceDisplay = truncate(subfolder, innerWidth - 14);
  const shelfNames = newShelves.map(s => s.name).join(', ');
  const shelfDisplay = truncate(shelfNames, innerWidth - 12);

  console.log(`\n${colors.green}╔${line}╗${colors.reset}`);
  console.log(padLine('  ✓ IMPORT COMPLETE!', colors.bright + colors.green));
  console.log(`${colors.green}╠${line}╣${colors.reset}`);
  console.log(padLine(`  Source:     ${sourceDisplay}`));
  console.log(padLine(`  Type:       ${importLabel}`));
  console.log(`${colors.green}╠${line}╣${colors.reset}`);
  console.log(padLine('  Created in BookStack:', colors.bright));

  // Show new shelves
  if (newShelves.length > 0) {
    console.log(padLine(`  ${colors.cyan}Shelf:${colors.reset}  ${shelfDisplay}`));
  }

  // Show new books count
  if (newBooks.length > 0) {
    console.log(padLine(`  ${colors.cyan}Books:${colors.reset}  ${newBooks.length} created`));
  }

  // Show page count
  if (newPageCount > 0) {
    console.log(padLine(`  ${colors.cyan}Pages:${colors.reset}  ${newPageCount} created`));
  }

  console.log(`${colors.green}╠${line}╣${colors.reset}`);
  console.log(padLine('  Steps completed:', colors.dim));
  console.log(padLine(`  ${colors.green}✓${colors.reset} Imported ${newShelves.length > 0 ? newShelves.length + ' shelf, ' : ''}${newBooks.length} books, ${newPageCount} pages`));
  if (!isXml) {
    console.log(padLine(`  ${colors.green}✓${colors.reset} Uploaded attachments`));
  } else {
    console.log(padLine(`  ${colors.green}✓${colors.reset} Attachments embedded in pages`));
  }
  console.log(padLine(`  ${colors.green}✓${colors.reset} Cleaned up Confluence artifacts`));
  console.log(`${colors.green}╚${line}╝${colors.reset}\n`);
};

// ============================================================================
// SELECT SUBFOLDER
// ============================================================================

// Result from selectSubfolder - either a folder name or a signal that full import was run
interface SubfolderResult {
  folder: string | null;
  fullImportRan: boolean;
}

const selectSubfolder = async (promptText: string = 'Select the Confluence export to process', allowFullImport: boolean = true): Promise<SubfolderResult> => {
  const config = readExistingEnv();
  if (!config) {
    printError('Configuration not found. Please run Configure first.');
    await waitForEnter();
    return { folder: null, fullImportRan: false };
  }

  const exportPath = config.PATH_TO_HTML;
  if (!fs.existsSync(exportPath)) {
    printError(`Import path not found: ${exportPath}`);
    await waitForEnter();
    return { folder: null, fullImportRan: false };
  }

  // Find both ZIP files and extracted folders
  const zipFiles = findZipFiles(exportPath);
  const subfolders = findHtmlExportFolders(exportPath);

  if (zipFiles.length === 0 && subfolders.length === 0) {
    printWarning(`No Confluence exports found in ${exportPath}`);
    printInfo('Add ZIP files or extracted Confluence folders to this directory.');
    const manual = await promptWithDefault('Enter subfolder name manually (or press Enter to cancel)', '');
    return { folder: manual || null, fullImportRan: false };
  }

  // Build options list with ZIPs first, then folders
  const options: { label: string; value: string; type: 'zip' | 'folder' }[] = [];

  zipFiles.forEach(z => {
    const stats = fs.statSync(z);
    const size = (stats.size / 1024 / 1024).toFixed(2);
    const basename = path.basename(z);
    options.push({
      label: `📦 ${basename} ${colors.dim}(${size} MB - extract & import)${colors.reset}`,
      value: z,
      type: 'zip'
    });
  });

  subfolders.forEach(f => {
    const analysis = analyzeExportFolder(exportPath, f);
    let details = 'ready';
    let icon = '📁';
    if (analysis) {
      const typeLabel = analysis.exportType === 'xml' ? 'XML' : analysis.exportType === 'html' ? 'HTML' : '?';
      details = `${typeLabel}, ${analysis.pageCount} pages, ${analysis.attachmentCount} files`;
      icon = analysis.exportType === 'xml' ? '📄' : '🌐';
    }
    options.push({
      label: `${icon} ${f} ${colors.dim}(${details})${colors.reset}`,
      value: f,
      type: 'folder'
    });
  });

  options.push({ label: '← Cancel', value: '__cancel__', type: 'folder' });

  console.log(`\n${colors.bright}${promptText}${colors.reset}`);
  console.log(`${colors.dim}Import folder: ${exportPath}${colors.reset}\n`);

  options.forEach((opt, i) => {
    console.log(`  ${colors.cyan}${i + 1}${colors.reset}) ${opt.label}`);
  });

  while (true) {
    const answer = await question(`\nEnter choice (1-${options.length}): `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) {
      const selected = options[num - 1];

      if (selected.value === '__cancel__') {
        return { folder: null, fullImportRan: false };
      }

      if (selected.type === 'zip') {
        // Extract the ZIP
        const zipName = path.basename(selected.value);
        console.log(`\n${colors.yellow}Extracting ${zipName}...${colors.reset}`);
        console.log(`${colors.dim}This may take a moment for large files...${colors.reset}\n`);

        const folderName = await extractZipToFolder(selected.value, exportPath);
        if (!folderName) {
          printError('Extraction cancelled or failed.');
          await waitForEnter();
          return { folder: null, fullImportRan: false };
        }

        printSuccess(`Extracted to: ${folderName}/`);

        // Analyze the extracted folder
        console.log(`${colors.dim}Analyzing export contents...${colors.reset}`);
        const analysis = analyzeExportFolder(exportPath, folderName);

        // Check if we found valid content
        const extractedPath = path.join(exportPath, folderName);

        // Look for nested folders that might contain the actual export
        let actualExportFolder = folderName;
        if (analysis && analysis.pageCount === 0) {
          // Check for nested folder structure
          try {
            const subDirs = fs.readdirSync(extractedPath, { withFileTypes: true })
              .filter(d => d.isDirectory() && !d.name.startsWith('.'));

            for (const subDir of subDirs) {
              const nestedAnalysis = analyzeExportFolder(extractedPath, subDir.name);
              if (nestedAnalysis && nestedAnalysis.pageCount > 0) {
                actualExportFolder = `${folderName}/${subDir.name}`;
                printInfo(`Found export in nested folder: ${actualExportFolder}`);
                break;
              }
            }
          } catch {
            // Ignore errors
          }
        }

        // Re-analyze with correct path if needed
        const finalAnalysis = actualExportFolder !== folderName
          ? analyzeExportFolder(exportPath, actualExportFolder)
          : analysis;

        // Show summary
        printSection('Export Summary');

        console.log(`  ${colors.cyan}ZIP File:${colors.reset}        ${zipName}`);
        console.log(`  ${colors.cyan}Extracted To:${colors.reset}    ${actualExportFolder}/`);

        // Determine export type
        const exportType = finalAnalysis?.exportType || 'unknown';
        const exportTypeLabel = exportType === 'xml' ? '📄 XML Export' :
                                exportType === 'html' ? '🌐 HTML Export' : '❓ Unknown';

        if (finalAnalysis && finalAnalysis.pageCount > 0) {
          console.log(`  ${colors.cyan}Export Type:${colors.reset}     ${exportTypeLabel}`);
          console.log(`  ${colors.cyan}Space Name:${colors.reset}      ${finalAnalysis.spaceName}`);
          console.log(`  ${colors.cyan}Pages:${colors.reset}           ${finalAnalysis.pageCount}`);
          console.log(`  ${colors.cyan}Attachments:${colors.reset}     ${finalAnalysis.attachmentCount} files (${finalAnalysis.attachmentSize})`);
        } else {
          console.log(`  ${colors.cyan}Export Type:${colors.reset}     ${exportTypeLabel}`);
          if (exportType === 'unknown') {
            printWarning('Could not determine export type. Archive may be empty or unsupported format.');
          }
        }

        console.log(`\n  ${colors.cyan}Target:${colors.reset}          ${config.URL}`);

        if (allowFullImport) {
          // Ask what they want to do
          console.log(`\n${colors.bright}What would you like to do?${colors.reset}\n`);
          console.log(`  ${colors.cyan}1${colors.reset}) 🚀 Run full import (import → attachments → cleanup)`);
          console.log(`  ${colors.cyan}2${colors.reset}) 📥 Import pages only (no attachments or cleanup)`);
          console.log(`  ${colors.cyan}3${colors.reset}) ← Return to menu (import later)`);

          while (true) {
            const actionChoice = await question(`\nEnter choice (1-3): `);
            const choice = actionChoice.trim();

            if (choice === '1') {
              const spaceName = finalAnalysis?.spaceName || actualExportFolder;
              const importMethod = exportType === 'xml' ? 'XML import' : 'HTML import';
              const proceed = await confirmPrompt(`\nStart full ${importMethod} of "${spaceName}" to BookStack?`, true);
              if (proceed) {
                await runFullImportForFolder(actualExportFolder, config, exportType);
                await waitForEnter();
                return { folder: actualExportFolder, fullImportRan: true };
              }
              return { folder: null, fullImportRan: false };
            } else if (choice === '2') {
              return { folder: actualExportFolder, fullImportRan: false };
            } else if (choice === '3') {
              return { folder: null, fullImportRan: false };
            } else {
              printError('Please enter 1, 2, or 3');
            }
          }
        }

        return { folder: actualExportFolder, fullImportRan: false };
      }

      return { folder: selected.value, fullImportRan: false };
    }
    printError(`Please enter a number between 1 and ${options.length}`);
  }
};

// ============================================================================
// IMPORT SPACE
// ============================================================================

const runImport = async () => {
  clearScreen();
  printBanner();
  printSection('Import Confluence Space');

  const config = readExistingEnv();
  if (!config) {
    printError('Configuration not found. Please run Configure first.');
    await waitForEnter();
    return;
  }

  printInfo(`BookStack: ${config.URL}`);
  printInfo(`Import Path: ${config.PATH_TO_HTML}`);

  const result = await selectSubfolder('Select the Confluence export to import');

  // If full import already ran (from ZIP selection), we're done
  if (result.fullImportRan) {
    return;
  }

  if (!result.folder) {
    return;
  }

  const subfolder = result.folder;

  // Detect export type
  const analysis = analyzeExportFolder(config.PATH_TO_HTML, subfolder);
  const exportType = analysis?.exportType || 'html';
  const importCommand = exportType === 'xml' ? 'xml-import' : 'import';
  const importLabel = exportType === 'xml' ? 'XML' : 'HTML';

  console.log(`\n${colors.bright}Ready to import: ${colors.cyan}${subfolder}${colors.reset}`);
  console.log(`${colors.dim}Export type: ${importLabel}${colors.reset}`);
  console.log(`${colors.dim}This will create shelves, books, chapters, and pages in BookStack.${colors.reset}`);

  const proceed = await confirmPrompt(`\nProceed with ${importLabel} import?`, true);
  if (!proceed) {
    return;
  }

  closeReadline();

  const exitCode = await runNpmScript(importCommand, [subfolder], `Importing ${subfolder}`);

  initReadline();

  if (exitCode === 0) {
    printSuccess('Import completed!');
  } else {
    printError(`Import finished with exit code ${exitCode}`);
  }

  await waitForEnter();
};

// ============================================================================
// UPLOAD ATTACHMENTS
// ============================================================================

const runAttachments = async () => {
  clearScreen();
  printBanner();
  printSection('Upload Attachments');

  const config = readExistingEnv();
  if (!config) {
    printError('Configuration not found. Please run Configure first.');
    await waitForEnter();
    return;
  }

  const result = await selectSubfolder('Select the export to upload attachments for', false);
  if (!result.folder) {
    return;
  }

  const subfolder = result.folder;

  console.log(`\n${colors.bright}Ready to upload attachments for: ${colors.cyan}${subfolder}${colors.reset}`);
  console.log(`${colors.dim}This will upload files from the attachments folder to BookStack.${colors.reset}`);

  const proceed = await confirmPrompt('\nProceed with attachment upload?', true);
  if (!proceed) {
    return;
  }

  closeReadline();

  const exitCode = await runNpmScript('attach', [subfolder], 'Uploading attachments');

  initReadline();

  if (exitCode === 0) {
    printSuccess('Attachment upload completed!');
  } else {
    printError(`Attachment upload finished with exit code ${exitCode}`);
  }

  await waitForEnter();
};

// ============================================================================
// POST-IMPORT CLEANUP
// ============================================================================

const runCleanup = async () => {
  while (true) {
    clearScreen();
    printBanner();
    printSection('Post-Import Cleanup');

    console.log(`${colors.dim}These utilities fix Confluence-specific artifacts after import.${colors.reset}`);

    const choice = await selectFromList('Select cleanup operation', [
      { label: '🔗 Fix Attachment Links', value: 'links', description: 'Convert old Confluence paths to BookStack URLs' },
      { label: '🖼️  Fix Embedded Images', value: 'images', description: 'Update image sources and remove Confluence attributes' },
      { label: '📄 Remove Thumbnails', value: 'thumbnails', description: 'Remove broken document thumbnails and emoticons' },
      { label: '⬜ Remove Placeholders', value: 'placeholders', description: 'Remove placeholder images for files without previews' },
      { label: '🚀 Run All Cleanup', value: 'all', description: 'Execute all cleanup operations in sequence' },
      { label: '← Back to Main Menu', value: 'back' },
    ]);

    if (choice === 'back') {
      return;
    }

    const config = readExistingEnv();
    if (!config) {
      printError('Configuration not found. Please run Configure first.');
      await waitForEnter();
      continue;
    }

    let subfolder: string | null = null;
    if (choice === 'links' || choice === 'images' || choice === 'all') {
      const result = await selectSubfolder('Select the export to clean up', false);
      subfolder = result.folder;
      if (!subfolder && choice !== 'all') {
        continue;
      }
    }

    closeReadline();

    if (choice === 'links' && subfolder) {
      await runNodeScript('fixAttachmentLinks.js', [subfolder], 'Fixing attachment links');
    } else if (choice === 'images' && subfolder) {
      await runNodeScript('fixEmbeddedImages.js', [subfolder], 'Fixing embedded images');
    } else if (choice === 'thumbnails') {
      await runNodeScript('removeConfluenceThumbnails.js', [], 'Removing Confluence thumbnails');
    } else if (choice === 'placeholders') {
      await runNodeScript('removeConfluencePlaceholders.js', [], 'Removing Confluence placeholders');
    } else if (choice === 'all') {
      console.log(`\n${colors.bgMagenta}${colors.bright} Running All Cleanup Operations ${colors.reset}\n`);

      if (subfolder) {
        await runNodeScript('fixAttachmentLinks.js', [subfolder], 'Step 1/4: Fixing attachment links');
      }

      await runNodeScript('removeConfluenceThumbnails.js', [], 'Step 2/4: Removing thumbnails');

      await runNodeScript('removeConfluencePlaceholders.js', [], 'Step 3/4: Removing placeholders');

      if (subfolder) {
        await runNodeScript('fixEmbeddedImages.js', [subfolder], 'Step 4/4: Fixing embedded images');
      }

      console.log(`\n${colors.green}All cleanup operations completed!${colors.reset}`);
    }

    initReadline();
    await waitForEnter();
  }
};

// ============================================================================
// DELETE SHELF
// ============================================================================

const runDeleteShelf = async () => {
  clearScreen();
  printBanner();
  printSection('Delete Shelf');

  closeReadline();

  await runNpmScript('killShelf', [], 'Loading shelf manager');

  initReadline();
  await waitForEnter();
};

// ============================================================================
// FULL IMPORT WORKFLOW
// ============================================================================

const runFullWorkflow = async () => {
  clearScreen();
  printBanner();
  printSection('Full Import Workflow');

  console.log(`${colors.dim}This will guide you through the complete import process:${colors.reset}`);
  console.log(`  1. Import Confluence space to BookStack`);
  console.log(`  2. Upload all attachments`);
  console.log(`  3. Run post-import cleanup\n`);

  const config = readExistingEnv();
  if (!config) {
    printError('Configuration not found. Please run Configure first.');
    await waitForEnter();
    return;
  }

  // Use selectSubfolder with allowFullImport=true - if they pick a ZIP, it handles everything
  const result = await selectSubfolder('Select the Confluence export for full workflow');

  // If full import already ran (from ZIP selection), we're done
  if (result.fullImportRan) {
    return;
  }

  if (!result.folder) {
    return;
  }

  const subfolder = result.folder;

  // Detect export type
  const exportPath = config.PATH_TO_HTML || './import';
  const analysis = analyzeExportFolder(exportPath, subfolder);
  const exportType = analysis?.exportType || 'html';

  const proceed = await confirmPrompt(`\nRun full ${exportType.toUpperCase()} import workflow for ${colors.cyan}${subfolder}${colors.reset}?`, true);
  if (!proceed) {
    return;
  }

  // Run the full import with status bar
  await runFullImportForFolder(subfolder, config, exportType);

  await waitForEnter();
};

// ============================================================================
// MAIN
// ============================================================================

const main = async () => {
  initReadline();

  while (true) {
    clearScreen();
    printBanner();

    const choice = await showMainMenu();

    switch (choice) {
      case 'configure':
        await runConfiguration();
        break;
      case 'workflow':
        await runFullWorkflow();
        break;
      case 'import':
        await runImport();
        break;
      case 'attachments':
        await runAttachments();
        break;
      case 'cleanup':
        await runCleanup();
        break;
      case 'delete':
        await runDeleteShelf();
        break;
      case 'exit':
        console.log(`\n${colors.cyan}Goodbye!${colors.reset}\n`);
        closeReadline();
        process.exit(0);
    }
  }
};

main().catch((err) => {
  printError(`Fatal error: ${err.message}`);
  closeReadline();
  process.exit(1);
});
