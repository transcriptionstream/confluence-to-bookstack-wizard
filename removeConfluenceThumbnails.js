require('dotenv').config();
const Axios = require('axios');

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

  console.log(`Found ${allPages.length} pages`);
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

function removeConfluenceThumbnails(html) {
  let updatedHtml = html;
  let removals = 0;

  // Pattern 1: Confluence document conversion thumbnails
  // <img src="rest/documentConversion/latest/conversion/thumbnail/..." />
  const thumbnailRegex = /<img[^>]*src=["']rest\/documentConversion[^"']*["'][^>]*\/?>/gi;
  updatedHtml = updatedHtml.replace(thumbnailRegex, () => {
    removals++;
    return '';
  });

  // Pattern 2: Confluence emoticons/icons
  // <img class="emoticon" src="images/icons/emoticons/..." />
  const emoticonRegex = /<img[^>]*class=["'][^"']*emoticon[^"']*["'][^>]*\/?>/gi;
  updatedHtml = updatedHtml.replace(emoticonRegex, () => {
    removals++;
    return '';
  });

  // Pattern 3: Any remaining confluence image paths that are broken
  // <img src="images/icons/..." />
  const confluenceIconsRegex = /<img[^>]*src=["']images\/icons\/[^"']*["'][^>]*\/?>/gi;
  updatedHtml = updatedHtml.replace(confluenceIconsRegex, () => {
    removals++;
    return '';
  });

  // Pattern 4: Confluence status macros - convert to text
  // <span class="status-macro aui-lozenge aui-lozenge-success">DONE</span>
  const statusMacroRegex = /<span[^>]*class=["'][^"']*status-macro[^"']*["'][^>]*>([^<]*)<\/span>/gi;
  updatedHtml = updatedHtml.replace(statusMacroRegex, (match, text) => {
    removals++;
    return `<strong>[${text}]</strong>`;
  });

  // Pattern 5: Empty anchor tags that wrapped thumbnails
  // <a ...><img removed></a> becomes <a ...></a> - clean these up
  const emptyAnchorRegex = /<a[^>]*class=["'][^"']*confluence-embedded-file[^"']*["'][^>]*>\s*<\/a>/gi;
  updatedHtml = updatedHtml.replace(emptyAnchorRegex, () => {
    removals++;
    return '';
  });

  // Pattern 6: Confluence file wrapper spans that might be empty now
  const emptyWrapperRegex = /<span[^>]*class=["'][^"']*confluence-embedded-file-wrapper[^"']*["'][^>]*>\s*<\/span>/gi;
  updatedHtml = updatedHtml.replace(emptyWrapperRegex, () => {
    removals++;
    return '';
  });

  return { updatedHtml, removals };
}

async function main() {
  console.log('Starting Confluence thumbnail/icon cleanup...\n');

  const pages = await getAllPages();

  let totalRemovals = 0;
  let pagesUpdated = 0;
  let pagesChecked = 0;

  for (const page of pages) {
    pagesChecked++;

    try {
      const pageDetails = await getPageDetails(page.id);
      const html = pageDetails.html || '';

      // Check if page has potential Confluence artifacts
      if (!html.includes('rest/documentConversion') &&
          !html.includes('emoticon') &&
          !html.includes('images/icons/') &&
          !html.includes('status-macro') &&
          !html.includes('confluence-embedded-file')) {
        if (pagesChecked % 50 === 0) {
          console.log(`[${pagesChecked}/${pages.length}] Checking...`);
        }
        continue;
      }

      const { updatedHtml, removals } = removeConfluenceThumbnails(html);

      if (removals > 0 && updatedHtml !== html) {
        await updatePageHtml(page.id, updatedHtml, pageDetails.name, pageDetails.book_id);
        totalRemovals += removals;
        pagesUpdated++;
        console.log(`\x1b[32m [${pagesChecked}/${pages.length}] Cleaned "${page.name}": ${removals} items removed \x1b[0m`);
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
  console.log(`\x1b[32m Total items removed: ${totalRemovals} \x1b[0m`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
