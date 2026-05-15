require('dotenv').config();
const { AxiosAdapter } = require('./axiosAdapter.js');

const credentials = {
  url: process.env.URL,
  id: process.env.ID,
  secret: process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limiting configuration
const BASE_DELAY = 300; // Base delay between requests (ms)

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

  const pages = await axios.getAllPages();

  let totalRemovals = 0;
  let pagesUpdated = 0;
  let pagesChecked = 0;

  for (const page of pages) {
    pagesChecked++;

    try {
      const pageDetails = await axios.getPageDetails(page.id);
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
        await axios.updatePageHtml(page.id, updatedHtml, pageDetails.name);
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

// CLI execution
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// Exported function for web interface
async function runRemoveConfluencePlaceholders(reporter, shelfId) {
  if (reporter) reporter.start({ phase: 'cleanup:placeholders', message: 'Removing Confluence placeholders...' });

  const pages = await (shelfId ? axios.getAllPagesByShelf(shelfId) : axios.getAllPages());

  let totalRemovals = 0;
  let pagesUpdated = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    try {
      const pageDetails = await axios.getPageDetails(page.id);
      const html = pageDetails.html || '';

      if (!html.includes('download/resources/') && !html.includes('download/thumbnails/')) {
        if (reporter) {
          reporter.progress({
            phase: 'cleanup:placeholders',
            message: `Skipped "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
        continue;
      }

      const { updatedHtml, removals } = removePlaceholders(html);

      if (removals > 0 && updatedHtml !== html) {
        await axios.updatePageHtml(page.id, updatedHtml, pageDetails.name);
        totalRemovals += removals;
        pagesUpdated++;

        if (reporter) {
          reporter.progress({
            phase: 'cleanup:placeholders',
            message: `Cleaned "${page.name}": ${removals} placeholders removed`,
            current: i + 1,
            total: pages.length
          });
        }
      } else {
        if (reporter) {
          reporter.progress({
            phase: 'cleanup:placeholders',
            message: `Cannot fix "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
      }

      await sleep(BASE_DELAY);
    } catch (err) {
      if (reporter) reporter.warning({ phase: 'cleanup:placeholders', message: `Error on "${page.name}": ${err.message}` });
    }
  }

  if (reporter) reporter.complete({ phase: 'cleanup:placeholders', message: `Removed ${totalRemovals} placeholders from ${pagesUpdated} pages` });
  return { removed: totalRemovals, pages: pagesUpdated };
}

module.exports = { runRemoveConfluencePlaceholders };
