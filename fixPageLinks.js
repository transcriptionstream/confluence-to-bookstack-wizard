require('dotenv').config();
const { decode } = require('html-entities');
const { AxiosAdapter } = require('./axiosAdapter.js');

const credentials = {
  url: process.env.URL,
  id: process.env.ID,
  secret: process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limiting configuration
const BASE_DELAY = 300;
const SUBPAGE_SEPARATOR = ' / '

function fixPageLinksInHtml(html, spacePagesMapping, spaceBooksMapping) {
  let updatedHtml = html;
  let replacements = 0;

  // Fix page link
  updatedHtml = html.replace(/href="(http[^\]"]+?\/)?(?:\[|%5[Bb]|&#91;|&#x5[Bb];)PAGE(?:\:|%3[Aa]|&#58;|&#x3[Aa];)([^\]"]+?)(?:\:|%3[Aa]|&#58;|&#x3[Aa];)([^\]"]+?)(?:\]|%5[Dd]|&#93;|&#x5[Dd];)"/g,
    (match, baseUrl, space, title) => {
      if (title) {
        let name = decode(decodeURIComponent(title));
        let page = spacePagesMapping[space]?.find(
          p => p.name == name
            || p.name.endsWith(SUBPAGE_SEPARATOR + name) // subpage
        );
        if (page) {
          replacements++;
          return `<a href="/books/${page.book_slug}/page/${page.slug}">`;
        } else {
          let book = spaceBooksMapping[space]?.find(b => b.name == name);
          if (book) {
            replacements++;
            return `<a href="/books/${book.slug}">`;
          }
        }
      }

      return match; // No match found, keep original
    });

  return { updatedHtml, replacements };
}

async function fixPageLinks(reporter, pages, spacePagesMapping, spaceBooksMapping) {
  let totalReplacements = 0;
  let pagesUpdated = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    try {
      const pageDetails = await axios.getPageDetails(page.id);
      const html = pageDetails.html || '';

      if (!html.includes('%5BPAGE') && !html.includes('PAGE:') && !html.includes('&#91;PAGE')) {
        if (reporter) {
          reporter.progress({
            phase: 'cleanup:pagelinks',
            message: `Skipped "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
        continue;
      }

      const { updatedHtml, replacements } = fixPageLinksInHtml(html, spacePagesMapping, spaceBooksMapping);

      if (replacements > 0 && updatedHtml !== html) {

        await axios.updatePageHtml(page.id, updatedHtml, pageDetails.name);
        totalReplacements += replacements;
        pagesUpdated++;

        if (reporter) {
          reporter.progress({
            phase: 'cleanup:pagelinks',
            message: `Fixed ${replacements} links in "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
      } else {
        if (reporter) {
          reporter.progress({
            phase: 'cleanup:pagelinks',
            message: `Cannot fix "${page.name}"`,
            current: i + 1,
            total: pages.length
          });
        }
      }

      await sleep(BASE_DELAY);
    } catch (err) {
      if (reporter) reporter.warning({ phase: 'cleanup:pagelinks', message: `Error on "${page.name}": ${err.message}` });
    }
  }

  return { totalReplacements, pagesUpdated };
}

// Fix cross shelves page link function for cli
async function runFixPageLinksForAll(reporter) {
  if (reporter) reporter.start({ phase: 'cleanup:pagelinks', message: 'Fixing page links...' });

  const pages = await axios.getAllPages();
  const shelves = await axios.getAllShelves();

  const spacePagesMapping = {};
  const spaceBooksMapping = {};
  const bookSpaceMapping = {};

  for (let shelve of shelves) {
    const shelf = (await axios.get(`/shelves/${shelve.id}`)).data;
    let space = shelf.tags.find(tag => tag.name == 'space')?.value;
    if (space) {
      spacePagesMapping[space] = [];

      if (!spaceBooksMapping[space])
        spaceBooksMapping[space] = [...shelf.books];
      else
        spaceBooksMapping[space].concat(shelf.books);
      for (let book of shelf.books) {
        bookSpaceMapping[book.id] = space;
      }
    }
  }

  let totalReplacements = 0;
  let pagesUpdated = 0;

  if (Object.keys(bookSpaceMapping).length != 0) {
    const hasSpacePages = [];
    for (let page of pages) {
      let space = bookSpaceMapping[page.book_id];
      if (space) {
        hasSpacePages.push(page);
        spacePagesMapping[space].push(page);
      }
    }

    const result = await fixPageLinks(reporter, hasSpacePages, spacePagesMapping, spaceBooksMapping);
    totalReplacements = result.totalReplacements;
    pagesUpdated = result.pagesUpdated;
  }

  if (reporter) {
    reporter.complete({
      phase: 'cleanup:pagelinks',
      message: `Fixed ${totalReplacements} attachment links in ${pagesUpdated} pages`
    });
  }

  return { fixed: totalReplacements, pages: pagesUpdated };
}

// Exported function for web interface
async function runFixPageLinks(reporter, shelfId) {
  if (!shelfId)
    return runFixPageLinksForAll(reporter);

  if (reporter) reporter.start({ phase: 'cleanup:pagelinks', message: 'Fixing page links...' });

  const pages = await axios.getAllPagesByShelf(shelfId);

  const shelf = (await axios.get('/shelves/' + shelfId)).data;
  const space = shelf.tags.find(tag => tag.name == 'space')?.value;
  const spacePagesMapping = { [space]: pages };
  const spaceBooksMapping = { [space]: shelf.books };

  const result = await fixPageLinks(reporter, pages, spacePagesMapping, spaceBooksMapping);
  let totalReplacements = result.totalReplacements;
  let pagesUpdated = result.pagesUpdated;

  if (reporter) {
    reporter.complete({
      phase: 'cleanup:pagelinks',
      message: `Fixed ${totalReplacements} attachment links in ${pagesUpdated} pages`
    });
  }

  return { fixed: totalReplacements, pages: pagesUpdated };
}

// Export for web interface
module.exports = { SUBPAGE_SEPARATOR, runFixPageLinks, runFixPageLinksForAll };

// CLI execution
if (require.main === module) {
  runFixPageLinksForAll({
    start: d => console.log(d.message),
    progress: d => !d.message.startsWith('Skipped') && console.log(d.message, `(${d.current}/${d.total})`),
    warning: d => console.warn(d.message),
    complete: d => console.log(d.message),
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
