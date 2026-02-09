require('dotenv').config();
const Axios = require('axios');
const { attachmentRecords } = require('./outputJS/attachmentsFile');

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

// Rate limiting configuration
const BASE_DELAY = 300; // Base delay between requests (ms)
const MAX_RETRIES = 5;
const BACKOFF_MULTIPLIER = 2;

// Wrapper for API calls with retry logic for 429 errors
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
        throw err; // Re-throw non-429 errors immediately
      }
    }
  }
  throw lastError; // Throw after all retries exhausted
}

// Build mapping from old confluence paths to attachment info
function buildPathMapping(subDirectory) {
  const pathMap = {};
  const records = attachmentRecords[subDirectory];

  if (!records) {
    console.log(`No attachment records found for ${subDirectory}`);
    return pathMap;
  }

  for (const [oldPageId, data] of Object.entries(records)) {
    const pageNewId = data.pageNewId;
    for (const att of data.attachmentHrefs) {
      // att.href is like "attachments/2392066/2392067.pdf"
      // att.name is like "ACCESS TO SCORING.pdf"
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
  // Create lookup by (uploaded_to, name) -> attachment_id
  const lookup = {};
  for (const att of attachments) {
    const key = `${att.uploaded_to}:${att.name.toLowerCase()}`;
    lookup[key] = att.id;
  }
  return lookup;
}

function fixEmbeddedImagesInHtml(html, pathMap, attachmentLookup) {
  let updatedHtml = html;
  let replacements = 0;
  let notFound = [];

  // Find all img tags with old-style attachment src
  // Pattern: src="attachments/12345/12345.png" or src="attachments/12345/12345.png?effects=..."
  const imgSrcRegex = /(<img[^>]*\ssrc=["'])(attachments\/\d+\/[^"'?]+)(\?[^"']*)?["']([^>]*>)/gi;

  updatedHtml = html.replace(imgSrcRegex, (match, prefix, oldPath, queryParams, suffix) => {
    // Decode URL-encoded characters in the path
    const decodedPath = decodeURIComponent(oldPath);

    // Look up in our path mapping
    const mappingInfo = pathMap[oldPath] || pathMap[decodedPath];

    if (mappingInfo) {
      const { name, pageNewId } = mappingInfo;
      const lookupKey = `${pageNewId}:${name.toLowerCase()}`;
      const attachmentId = attachmentLookup[lookupKey];

      if (attachmentId) {
        replacements++;
        // Use BookStack's attachment URL
        return `${prefix}/attachments/${attachmentId}"${suffix}`;
      } else {
        notFound.push({ path: oldPath, name, pageNewId, reason: 'no attachment found in BookStack' });
      }
    } else {
      notFound.push({ path: oldPath, reason: 'no mapping found' });
    }

    return match; // No match found, keep original
  });

  // Also handle data-image-src attributes (remove them since they're Confluence-specific)
  updatedHtml = updatedHtml.replace(/\s*data-image-src=["'][^"']*["']/gi, '');
  updatedHtml = updatedHtml.replace(/\s*data-linked-resource[^=]*=["'][^"']*["']/gi, '');
  updatedHtml = updatedHtml.replace(/\s*data-base-url=["'][^"']*["']/gi, '');
  updatedHtml = updatedHtml.replace(/\s*data-unresolved-comment-count=["'][^"']*["']/gi, '');
  updatedHtml = updatedHtml.replace(/\s*confluence-query-params=["'][^"']*["']/gi, '');

  return { updatedHtml, replacements, notFound };
}

async function main() {
  const subDirectory = process.argv[2] || 'IT';
  console.log(`Starting embedded image fix for ${subDirectory}...\n`);

  // Build the path mapping from import records
  const pathMap = buildPathMapping(subDirectory);

  if (Object.keys(pathMap).length === 0) {
    console.log('No path mappings found. Exiting.');
    return;
  }

  // Get all attachments and build lookup
  const attachments = await getAllAttachments();
  const attachmentLookup = buildAttachmentLookup(attachments);

  // Get all pages
  const pages = await getAllPages();

  let totalReplacements = 0;
  let pagesUpdated = 0;
  let pagesChecked = 0;
  let allNotFound = [];

  for (const page of pages) {
    pagesChecked++;

    try {
      // Get page details (includes HTML)
      const pageDetails = await getPageDetails(page.id);
      const html = pageDetails.html || '';

      // Check if page has old-style image src
      if (!html.includes('src="attachments/') && !html.includes("src='attachments/")) {
        if (pagesChecked % 50 === 0) {
          console.log(`[${pagesChecked}/${pages.length}] Checking...`);
        }
        continue;
      }

      // Fix the images
      const { updatedHtml, replacements, notFound } = fixEmbeddedImagesInHtml(html, pathMap, attachmentLookup);
      allNotFound = allNotFound.concat(notFound);

      if (updatedHtml !== html) {
        // Update the page
        await updatePageHtml(page.id, updatedHtml, pageDetails.name, pageDetails.book_id);
        totalReplacements += replacements;
        pagesUpdated++;
        console.log(`\x1b[32m [${pagesChecked}/${pages.length}] Updated "${page.name}": ${replacements} images fixed \x1b[0m`);
      } else if (notFound.length > 0) {
        console.log(`\x1b[33m [${pagesChecked}/${pages.length}] "${page.name}": ${notFound.length} images not matched \x1b[0m`);
      }

      await sleep(BASE_DELAY); // Rate limiting

    } catch (err) {
      const status = err.response?.status || '';
      console.log(`\x1b[31m [${pagesChecked}/${pages.length}] Error processing "${page.name}": ${status} ${err.message} \x1b[0m`);
    }
  }

  console.log('\n------------------------------------------------');
  console.log(`\x1b[32m Pages checked: ${pagesChecked} \x1b[0m`);
  console.log(`\x1b[32m Pages updated: ${pagesUpdated} \x1b[0m`);
  console.log(`\x1b[32m Total images fixed: ${totalReplacements} \x1b[0m`);

  if (allNotFound.length > 0) {
    console.log(`\x1b[33m Images not matched: ${allNotFound.length} \x1b[0m`);
    // Show first few unmatched for debugging
    console.log('\nSample unmatched images:');
    allNotFound.slice(0, 10).forEach(nf => {
      console.log(`  - ${nf.path}: ${nf.reason}`);
    });
  }
}

// CLI execution
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// Exported function for web interface
async function runFixEmbeddedImages(subDirectory, reporter) {
  if (reporter) reporter.start({ phase: 'cleanup:images', message: 'Fixing embedded images...' });

  const pathMap = buildPathMapping(subDirectory);

  if (Object.keys(pathMap).length === 0) {
    if (reporter) reporter.warning({ phase: 'cleanup:images', message: 'No path mappings found' });
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

      if (!html.includes('src="attachments/') && !html.includes("src='attachments/")) {
        continue;
      }

      const { updatedHtml, replacements } = fixEmbeddedImagesInHtml(html, pathMap, attachmentLookup);

      if (updatedHtml !== html) {
        await updatePageHtml(page.id, updatedHtml, pageDetails.name, pageDetails.book_id);
        totalReplacements += replacements;
        pagesUpdated++;

        if (reporter) {
          reporter.progress({
            phase: 'cleanup:images',
            message: `Fixed ${replacements} images in "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
      }

      await sleep(BASE_DELAY);
    } catch (err) {
      if (reporter) reporter.warning({ phase: 'cleanup:images', message: `Error on "${page.name}": ${err.message}` });
    }
  }

  if (reporter) reporter.complete({ phase: 'cleanup:images', message: `Fixed ${totalReplacements} embedded images in ${pagesUpdated} pages` });
  return { fixed: totalReplacements, pages: pagesUpdated };
}

module.exports = { runFixEmbeddedImages };
