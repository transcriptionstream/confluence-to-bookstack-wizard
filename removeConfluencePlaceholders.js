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

function removePlaceholders(html) {
  let updatedHtml = html;
  let removals = 0;

  // Pattern: Confluence view-file-macro placeholder images
  // <img src="download/resources/com.atlassian.confluence.plugins.confluence-view-file-macro:view-file-macro-resources/images/placeholder-*.png" />
  const placeholderRegex = /<img[^>]*src=["']download\/resources\/com\.atlassian[^"']*placeholder[^"']*["'][^>]*\/?>/gi;
  updatedHtml = updatedHtml.replace(placeholderRegex, () => {
    removals++;
    return '';
  });

  // Pattern: Any other download/resources paths (Confluence plugin resources)
  const downloadResourcesRegex = /<img[^>]*src=["']download\/resources\/[^"']*["'][^>]*\/?>/gi;
  updatedHtml = updatedHtml.replace(downloadResourcesRegex, () => {
    removals++;
    return '';
  });

  // Pattern: Confluence plugin thumbnails that didn't get caught before
  const pluginThumbRegex = /<img[^>]*src=["']download\/thumbnails\/[^"']*["'][^>]*\/?>/gi;
  updatedHtml = updatedHtml.replace(pluginThumbRegex, () => {
    removals++;
    return '';
  });

  return { updatedHtml, removals };
}

async function main() {
  console.log('Starting Confluence placeholder cleanup...\n');

  const pages = await getAllPages();

  let totalRemovals = 0;
  let pagesUpdated = 0;
  let pagesChecked = 0;

  for (const page of pages) {
    pagesChecked++;

    try {
      const pageDetails = await getPageDetails(page.id);
      const html = pageDetails.html || '';

      // Check if page has potential placeholder images
      if (!html.includes('download/resources/') && !html.includes('download/thumbnails/')) {
        if (pagesChecked % 50 === 0) {
          console.log(`[${pagesChecked}/${pages.length}] Checking...`);
        }
        continue;
      }

      const { updatedHtml, removals } = removePlaceholders(html);

      if (removals > 0 && updatedHtml !== html) {
        await updatePageHtml(page.id, updatedHtml, pageDetails.name, pageDetails.book_id);
        totalRemovals += removals;
        pagesUpdated++;
        console.log(`\x1b[32m [${pagesChecked}/${pages.length}] Cleaned "${page.name}": ${removals} placeholders removed \x1b[0m`);
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
  console.log(`\x1b[32m Total placeholders removed: ${totalRemovals} \x1b[0m`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
