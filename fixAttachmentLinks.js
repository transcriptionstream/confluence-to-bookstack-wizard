require('dotenv').config();
const Axios = require('axios');
const path = require('path');

const credentials = {
  url: process.env.URL,
  id: process.env.ID,
  secret: process.env.SECRET
};

const client = Axios.create({
  baseURL: credentials.url,
  headers: {
    'Authorization': `Token ${credentials.id}:${credentials.secret}`,
    'Content-Type': 'application/json'
  }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Dynamic loader for attachment records (avoids Node.js module caching issues)
function loadAttachmentRecords() {
  const filePath = path.resolve(__dirname, './outputJS/attachmentsFile.js');
  // Clear the require cache to get fresh data
  delete require.cache[require.resolve(filePath)];
  const { attachmentRecords } = require(filePath);
  return attachmentRecords;
}

// Rate limiting configuration
const BASE_DELAY = 300;
const MAX_RETRIES = 5;
const BACKOFF_MULTIPLIER = 2;

async function withRetry(fn, context = '') {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      lastError = err;
      if (err.response && err.response.status === 429) {
        const delay = BASE_DELAY * Math.pow(BACKOFF_MULTIPLIER, attempt);
        console.log(`\x1b[33m Rate limited${context ? ` (${context})` : ''}, waiting ${delay}ms (attempt ${attempt}/${MAX_RETRIES}) \x1b[0m`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

function buildPathMapping(subDirectory) {
  const attachmentRecords = loadAttachmentRecords();
  const pathMap = {};
  const records = attachmentRecords[subDirectory];

  if (!records) {
    console.log(`No attachment records found for ${subDirectory}`);
    return pathMap;
  }

  for (const [oldPageId, data] of Object.entries(records)) {
    const pageNewId = data.pageNewId;
    for (const att of data.attachmentHrefs) {
      pathMap[att.href] = {
        name: att.name,
        pageNewId: pageNewId
      };
    }
  }

  console.log(`Built path mapping with ${Object.keys(pathMap).length} entries`);
  return pathMap;
}

async function getAllAttachments() {
  let allAttachments = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await withRetry(
      () => client.get('/attachments', { params: { offset, count: limit } }),
      'getAllAttachments'
    );

    const attachments = response.data.data;
    allAttachments = allAttachments.concat(attachments);

    if (attachments.length < limit) break;
    offset += limit;
    await sleep(BASE_DELAY);
  }

  console.log(`Found ${allAttachments.length} attachments in BookStack`);
  return allAttachments;
}

async function getAllPages() {
  let allPages = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await withRetry(
      () => client.get('/pages', { params: { offset, count: limit } }),
      'getAllPages'
    );

    const pages = response.data.data;
    allPages = allPages.concat(pages);

    if (pages.length < limit) break;
    offset += limit;
    await sleep(BASE_DELAY);
  }

  console.log(`Found ${allPages.length} pages in BookStack`);
  return allPages;
}

async function getPageDetails(pageId) {
  const response = await withRetry(
    () => client.get(`/pages/${pageId}`),
    `getPage:${pageId}`
  );
  return response.data;
}

async function updatePageHtml(pageId, html, name, bookId) {
  const response = await withRetry(
    () => client.put(`/pages/${pageId}`, { html, name, book_id: bookId }),
    `updatePage:${pageId}`
  );
  return response.data;
}

function buildAttachmentLookup(attachments) {
  const lookup = {};
  for (const att of attachments) {
    const key = `${att.uploaded_to}:${att.name.toLowerCase()}`;
    lookup[key] = att.id;
  }
  console.log(`Built attachment lookup with ${Object.keys(lookup).length} entries`);
  // Log a sample of keys for debugging
  const sampleKeys = Object.keys(lookup).slice(0, 5);
  if (sampleKeys.length > 0) {
    console.log(`Sample lookup keys: ${sampleKeys.join(', ')}`);
  }
  return lookup;
}

function fixAttachmentLinksInHtml(html, pathMap, attachmentLookup, currentPageId) {
  let updatedHtml = html;
  let replacements = 0;
  let notFound = [];

  // Match old-style attachment links: href="attachments/..."
  const attachmentLinkRegex = /href=["'](attachments\/\d+\/[^"']+)["']/gi;

  // Match placeholder format with various encodings:
  // - Raw: href="[ATTACHMENT:filename]"
  // - URL-encoded: href="%5BATTACHMENT:filename%5D"
  // - HTML-encoded: href="&#91;ATTACHMENT:filename&#93;"
  // - Mixed: href="[ATTACHMENT:filename%5D"
  const placeholderRegex = /href=["'](?:\[|%5[Bb]|&#91;|&#x5[Bb];)ATTACHMENT:([^\]"']+?)(?:\]|%5[Dd]|&#93;|&#x5[Dd];)["']/gi;

  // Fix old-style attachment paths
  updatedHtml = html.replace(attachmentLinkRegex, (match, oldPath) => {
    const decodedPath = decodeURIComponent(oldPath);
    const mappingInfo = pathMap[oldPath] || pathMap[decodedPath];

    if (mappingInfo) {
      const { name, pageNewId } = mappingInfo;
      const lookupKey = `${pageNewId}:${name.toLowerCase()}`;
      const attachmentId = attachmentLookup[lookupKey];

      if (attachmentId) {
        replacements++;
        return `href="/attachments/${attachmentId}"`;
      } else {
        notFound.push({ path: oldPath, name, pageNewId, reason: 'no attachment found in BookStack' });
      }
    } else {
      notFound.push({ path: oldPath, reason: 'no mapping found' });
    }

    return match;
  });

  // Fix placeholder-style attachment links
  // First try to match on the CURRENT page, then fall back to global search
  updatedHtml = updatedHtml.replace(placeholderRegex, (match, filename) => {
    const decodedFilename = decodeURIComponent(filename).trim();
    const filenameLower = decodedFilename.toLowerCase();

    console.log(`  [DEBUG] Found placeholder: "${filename}" on page ${currentPageId}`);

    // First: Try to find attachment on the CURRENT page (most likely correct)
    if (currentPageId) {
      const currentPageKey = `${currentPageId}:${filenameLower}`;
      console.log(`  [DEBUG] Looking for key: "${currentPageKey}"`);
      if (attachmentLookup[currentPageKey]) {
        console.log(`  [DEBUG] ✓ Found on current page: ${attachmentLookup[currentPageKey]}`);
        replacements++;
        return `href="/attachments/${attachmentLookup[currentPageKey]}"`;
      }
    }

    // Second: Try exact filename match on any page (fallback)
    for (const [key, attachmentId] of Object.entries(attachmentLookup)) {
      const colonIndex = key.indexOf(':');
      const attName = key.substring(colonIndex + 1);
      if (attName === filenameLower) {
        console.log(`  [DEBUG] ✓ Found on different page via key "${key}": ${attachmentId}`);
        replacements++;
        return `href="/attachments/${attachmentId}"`;
      }
    }

    // Third: Try partial/fuzzy match (handle encoding issues)
    for (const [key, attachmentId] of Object.entries(attachmentLookup)) {
      const colonIndex = key.indexOf(':');
      const attName = key.substring(colonIndex + 1);
      // Try URL-decoded comparison
      try {
        const decodedAttName = decodeURIComponent(attName);
        if (decodedAttName === filenameLower || decodedAttName === decodedFilename.toLowerCase()) {
          console.log(`  [DEBUG] ✓ Found via fuzzy match "${key}": ${attachmentId}`);
          replacements++;
          return `href="/attachments/${attachmentId}"`;
        }
      } catch (e) {
        // Skip invalid URL encoding
      }
    }

    console.log(`  [DEBUG] ✗ No match found for "${filename}"`);
    notFound.push({ path: filename, pageId: currentPageId, reason: 'placeholder not matched' });
    return match;
  });

  return { updatedHtml, replacements, notFound };
}

async function main() {
  const subDirectory = process.argv[2] || 'IT';
  console.log(`Starting attachment link fix for ${subDirectory}...\n`);

  const pathMap = buildPathMapping(subDirectory);

  if (Object.keys(pathMap).length === 0) {
    console.log('No path mappings found. Exiting.');
    return;
  }

  const attachments = await getAllAttachments();
  const attachmentLookup = buildAttachmentLookup(attachments);

  const pages = await getAllPages();

  let totalReplacements = 0;
  let pagesUpdated = 0;
  let pagesChecked = 0;
  let allNotFound = [];

  for (const page of pages) {
    pagesChecked++;

    try {
      const pageDetails = await getPageDetails(page.id);
      const html = pageDetails.html || '';

      if (!html.includes('attachments/') && !html.includes('ATTACHMENT:') && !html.includes('%5BATTACHMENT') && !html.includes('&#91;ATTACHMENT')) {
        if (pagesChecked % 50 === 0) {
          console.log(`[${pagesChecked}/${pages.length}] Checking...`);
        }
        continue;
      }

      const { updatedHtml, replacements, notFound } = fixAttachmentLinksInHtml(html, pathMap, attachmentLookup, page.id);
      allNotFound = allNotFound.concat(notFound);

      if (replacements > 0 && updatedHtml !== html) {
        await updatePageHtml(page.id, updatedHtml, pageDetails.name, pageDetails.book_id);
        totalReplacements += replacements;
        pagesUpdated++;
        console.log(`\x1b[32m [${pagesChecked}/${pages.length}] Updated "${page.name}": ${replacements} links fixed \x1b[0m`);
      } else if (notFound.length > 0) {
        console.log(`\x1b[33m [${pagesChecked}/${pages.length}] "${page.name}": ${notFound.length} links not matched \x1b[0m`);
      }

      await sleep(BASE_DELAY);

    } catch (err) {
      const status = err.response?.status || '';
      console.log(`\x1b[31m [${pagesChecked}/${pages.length}] Error processing "${page.name}": ${status} ${err.message} \x1b[0m`);
    }
  }

  console.log('\n------------------------------------------------');
  console.log(`\x1b[32m Pages checked: ${pagesChecked} \x1b[0m`);
  console.log(`\x1b[32m Pages updated: ${pagesUpdated} \x1b[0m`);
  console.log(`\x1b[32m Total links fixed: ${totalReplacements} \x1b[0m`);

  if (allNotFound.length > 0) {
    console.log(`\x1b[33m Links not matched: ${allNotFound.length} \x1b[0m`);
    console.log('\nSample unmatched links:');
    allNotFound.slice(0, 10).forEach(nf => {
      console.log(`  - ${nf.path}: ${nf.reason}`);
    });
  }
}

// Exported function for web interface
async function runFixAttachmentLinks(subDirectory, reporter) {
  if (reporter) reporter.start({ phase: 'cleanup:links', message: 'Fixing attachment links...' });

  const pathMap = buildPathMapping(subDirectory);

  if (Object.keys(pathMap).length === 0) {
    if (reporter) reporter.warning({ phase: 'cleanup:links', message: 'No path mappings found' });
    return { fixed: 0, pages: 0 };
  }

  const attachments = await getAllAttachments();
  const attachmentLookup = buildAttachmentLookup(attachments);
  const pages = await getAllPages();

  let totalReplacements = 0;
  let pagesUpdated = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    try {
      const pageDetails = await getPageDetails(page.id);
      const html = pageDetails.html || '';

      if (!html.includes('attachments/') && !html.includes('ATTACHMENT:') && !html.includes('%5BATTACHMENT') && !html.includes('&#91;ATTACHMENT')) {
        continue;
      }

      const { updatedHtml, replacements } = fixAttachmentLinksInHtml(html, pathMap, attachmentLookup, page.id);

      if (replacements > 0 && updatedHtml !== html) {
        await updatePageHtml(page.id, updatedHtml, pageDetails.name, pageDetails.book_id);
        totalReplacements += replacements;
        pagesUpdated++;

        if (reporter) {
          reporter.progress({
            phase: 'cleanup:links',
            message: `Fixed ${replacements} links in "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
      }

      await sleep(BASE_DELAY);
    } catch (err) {
      if (reporter) reporter.warning({ phase: 'cleanup:links', message: `Error on "${page.name}": ${err.message}` });
    }
  }

  if (reporter) {
    reporter.complete({
      phase: 'cleanup:links',
      message: `Fixed ${totalReplacements} attachment links in ${pagesUpdated} pages`
    });
  }

  return { fixed: totalReplacements, pages: pagesUpdated };
}

// Export for web interface
module.exports = { runFixAttachmentLinks };

// CLI execution
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
