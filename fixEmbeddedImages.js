require('dotenv').config();
const { AxiosAdapter } = require('./axiosAdapter.js');
const { attachmentRecords } = require('./outputJS/attachmentsFile');

const credentials = {
  url: process.env.URL,
  id: process.env.ID,
  secret: process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limiting configuration
const BASE_DELAY = 300; // Base delay between requests (ms)

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
  const attachments = await axios.getAllAttachments();
  const attachmentLookup = buildAttachmentLookup(attachments);

  // Get all pages
  const pages = await axios.getAllPages();

  let totalReplacements = 0;
  let pagesUpdated = 0;
  let pagesChecked = 0;
  let allNotFound = [];

  for (const page of pages) {
    pagesChecked++;

    try {
      // Get page details (includes HTML)
      const pageDetails = await axios.getPageDetails(page.id);
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
        await axios.updatePageHtml(page.id, updatedHtml, pageDetails.name);
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
async function runFixEmbeddedImages(subDirectory, reporter, shelfId) {
  if (reporter) reporter.start({ phase: 'cleanup:images', message: 'Fixing embedded images...' });

  const pathMap = buildPathMapping(subDirectory);

  if (Object.keys(pathMap).length === 0) {
    if (reporter) reporter.warning({ phase: 'cleanup:images', message: 'No path mappings found' });
    return { fixed: 0, pages: 0 };
  }

  const pages = await (shelfId ? axios.getAllPagesByShelf(shelfId) : axios.getAllPages());

  let totalReplacements = 0;
  let pagesUpdated = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    try {
      const pageDetails = await axios.getPageDetails(page.id);
      const html = pageDetails.html || '';

      if (!html.includes('src="attachments/') && !html.includes("src='attachments/")) {
        if (reporter) {
          reporter.progress({
            phase: 'cleanup:images',
            message: `Skipped "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
        continue;
      }

      const attachments = await axios.getPageAttachments(page.id);
      const attachmentLookup = buildAttachmentLookup(attachments);

      const { updatedHtml, replacements } = fixEmbeddedImagesInHtml(html, pathMap, attachmentLookup);

      if (updatedHtml !== html) {
        await axios.updatePageHtml(page.id, updatedHtml, pageDetails.name);
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
      } else {
        if (reporter) {
          reporter.progress({
            phase: 'cleanup:images',
            message: `Cannot fix "${page.name}"`,
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
