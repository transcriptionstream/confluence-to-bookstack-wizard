import { attachmentRecords } from '../outputJS/attachmentsFile'

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { encode: encodeHtml } = require('html-entities');
const { AxiosAdapter } = require('../axiosAdapter.js');
const { SUBPAGE_SEPARATOR } = require('../fixPageLinks.js');

let fileDirectory = process.env.PATH_TO_HTML;
let subDirectory: string;

let credentials = {
  url: process.env.URL,
  id: process.env.ID,
  secret: process.env.SECRET
};

let axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret);

function reloadEnvConfig() {
  require('dotenv').config({ override: true });
  fileDirectory = process.env.PATH_TO_HTML;
  credentials = {
    url: process.env.URL,
    id: process.env.ID,
    secret: process.env.SECRET
  };
  axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret);
}

interface PageData {
  id: string;
  title: string;
  bodyContentId: string;
  parentId: string | null;
  contentStatus: string;
}

interface AttachmentData {
  id: string;
  title: string;
  containerId: string;
  version: string;
}

interface BodyContentData {
  id: string;
  body: string;
  contentId: string;
}

let shelfId: number;
let spaceTitle: string;
let spaceKey: string;
let pages: Map<string, PageData> = new Map();
let attachments: Map<string, AttachmentData> = new Map();
let bodyContents: Map<string, BodyContentData> = new Map();
let attachmentsByPage: {
  [key: string]: {
    attachmentHrefs: { name: string; href: string, type?: string }[];
    pageNewId?: number
  }
} = {};

// Simple XML parser - extracts objects from Confluence XML export
function parseEntitiesXml(xmlContent: string) {
  console.log('Parsing entities.xml...');

  const spaceTitleRegex = /<object class="Space" package="com\.atlassian\.confluence\.spaces">[\s\S]*?<property[^>]*name="name"[^>]*><!\[CDATA\[(.*?)\]\]><\/property>/;
  let spaceTitleMatch = spaceTitleRegex.exec(xmlContent);
  if (spaceTitleMatch)
    spaceTitle = spaceTitleMatch[1];

  const spaceKeyRegex = /<object class="Space" package="com\.atlassian\.confluence\.spaces">[\s\S]*?<property[^>]*name="key"[^>]*><!\[CDATA\[(.*?)\]\]><\/property>/;
  let spaceKeyMatch = spaceKeyRegex.exec(xmlContent);
  if (spaceKeyMatch)
    spaceKey = spaceKeyMatch[1];

  // Parse Page objects
  const pageRegex = /<object class="Page" package="com\.atlassian\.confluence\.pages">([\s\S]*?)<\/object>/g;
  let match;

  while ((match = pageRegex.exec(xmlContent)) !== null) {
    const objContent = match[1];

    const idMatch = objContent.match(/<id name="id">(\d+)<\/id>/);
    const titleMatch = objContent.match(/<property name="title"><!\[CDATA\[(.*?)\]\]><\/property>/);
    const bodyMatch = objContent.match(/<element class="BodyContent"[^>]*><id name="id">(\d+)<\/id>/);
    const parentMatch = objContent.match(/<property name="parent" class="Page"[^>]*><id name="id">(\d+)<\/id>/);
    const statusMatch = objContent.match(/<property name="contentStatus"><!\[CDATA\[(.*?)\]\]><\/property>/);

    if (idMatch && titleMatch) {
      const status = statusMatch ? statusMatch[1] : 'current';
      // Only include current pages, not drafts
      if (status === 'current') {
        pages.set(idMatch[1], {
          id: idMatch[1],
          title: titleMatch[1],
          bodyContentId: bodyMatch ? bodyMatch[1] : '',
          parentId: parentMatch ? parentMatch[1] : null,
          contentStatus: status
        });
      }
    }
  }

  console.log(`Found ${pages.size} current pages`);

  // Parse BodyContent objects
  const bodyRegex = /<object class="BodyContent" package="com\.atlassian\.confluence\.core">([\s\S]*?)<\/object>/g;

  while ((match = bodyRegex.exec(xmlContent)) !== null) {
    const objContent = match[1];

    const idMatch = objContent.match(/<id name="id">(\d+)<\/id>/);
    const bodyMatch = objContent.match(/<property name="body"><!\[CDATA\[([\s\S]*?)\]\]><\/property>/);
    const contentMatch = objContent.match(/<property name="content" class="(?:Page|BlogPost)"[^>]*><id name="id">(\d+)<\/id>/);

    if (idMatch && bodyMatch) {
      bodyContents.set(idMatch[1], {
        id: idMatch[1],
        body: bodyMatch[1],
        contentId: contentMatch ? contentMatch[1] : ''
      });
    }
  }

  console.log(`Found ${bodyContents.size} body contents`);

  // Parse Attachment objects
  const attachmentRegex = /<object class="Attachment" package="com\.atlassian\.confluence\.pages">([\s\S]*?)<\/object>/g;

  while ((match = attachmentRegex.exec(xmlContent)) !== null) {
    const objContent = match[1];

    const idMatch = objContent.match(/<id name="id">(\d+)<\/id>/);
    const titleMatch = objContent.match(/<property name="title"><!\[CDATA\[(.*?)\]\]><\/property>/);
    const containerMatch = objContent.match(/<property name="containerContent" class="(?:Page|BlogPost)"[^>]*><id name="id">(\d+)<\/id>/);
    const versionMatch = objContent.match(/<property name="version">(\d+)<\/property>/);
    const statusMatch = objContent.match(/<property name="contentStatus"><!\[CDATA\[(.*?)\]\]><\/property>/);

    if (idMatch && titleMatch && containerMatch) {
      const status = statusMatch ? statusMatch[1] : 'current';
      if (status === 'current') {
        attachments.set(idMatch[1], {
          id: idMatch[1],
          title: titleMatch[1],
          containerId: containerMatch[1],
          version: versionMatch ? versionMatch[1] : '1'
        });
      }
    }
  }

  console.log(`Found ${attachments.size} current attachments`);
}

// Get page body content
function getPageBody(page: PageData): string {
  // Find body content that references this page
  for (const [id, body] of bodyContents) {
    if (body.contentId === page.id) {
      return body.body;
    }
  }
  return '';
}

// Get MIME type from filename
function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes: { [key: string]: string } = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml'
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

async function setAttachmentType(pageId: string, filename: string, type: 'attachment' | 'gallery' | 'drawio') {
  const { attachmentHrefs } = attachmentsByPage[pageId];
  const index = attachmentHrefs.findIndex(attach => attach.name === filename);
  if (index !== -1)
    attachmentHrefs[index].type = type;
}

// Convert Confluence storage format to HTML
function convertStorageToHtml(storageFormat: string, pageId: string): string {
  let html = storageFormat;

  // Convert ac:image to img tags with base64 embedded images
  html = html.replace(/<ac:image[^>]*>[\s\S]*?<ri:attachment ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:image>/g,
    (match, filename) => {
      setAttachmentType(pageId, filename, 'gallery');
      return `<img src="[ATTACHMENT:${filename}]" alt="${filename}" />`;
    });

  // Convert drawio macro: (src -> download link) (preview -> base64 embedded images)
  html = html.replace(/<ac:structured-macro[^>]*ac:name="drawio"[^>]*>[\s\S]*?<ac:parameter ac:name="diagramName">([\s\S]*?)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/g,
    (match, drawioName) => {
      let drawioSrc = `[draw.io] <a href="[ATTACHMENT:${drawioName}]">${drawioName}</a>`;
      let filename = drawioName + '.png';
      setAttachmentType(pageId, filename, 'drawio');
      return `<p>${drawioSrc}<img src="[ATTACHMENT:${filename}]" alt="${filename}" /></p>`;
    });

  // Convert view-file macro to download link
  html = html.replace(/<ac:structured-macro[^>]*ac:name="view-file"[^>]*>[\s\S]*?<ri:attachment ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:structured-macro>/g,
    (match, filename) => {
      return `<p>📎 <a href="[ATTACHMENT:${filename}]">${filename}</a></p>`;
    });

  // Convert widget macro with attachments to download link
  html = html.replace(/<ac:structured-macro[^>]*ac:name="widget"[^>]*>[\s\S]*?<ri:attachment ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:structured-macro>/g,
    (match, filename) => {
      return `<p>📎 <a href="[ATTACHMENT:${filename}]">${filename}</a></p>`;
    });

  // Convert ac:link with ri:attachment to links
  html = html.replace(/<ac:link[^>]*>[\s\S]*?<ri:attachment ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<ac:plain-text-link-body><!\[CDATA\[([^\]]*)\]\]><\/ac:plain-text-link-body>[\s\S]*?<\/ac:link>/g,
    (match, filename, linkText) => {
      return `<a href="[ATTACHMENT:${filename}]">${linkText || filename}</a>`;
    });

  // Convert ac:link with ri:attachment (without link body) to links
  html = html.replace(/<ac:link[^>]*>[\s\S]*?<ri:attachment ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:link>/g,
    (match, filename) => {
      return `<a href="[ATTACHMENT:${filename}]">${filename}</a>`;
    });

  // confluence link
  html = html.replace(/<ac:link[^>]*>[\s\S]*?<ri:page([^>]*)>[\s\S]*?<ac:link-body>([\s\S]*?)<\/ac:link-body>[\s\S]*?<\/ac:link>/g,
    (match, pageMeta, title) => {
      let pageTitle = pageMeta.match(/ri:content-title="([^"]+?)"/)?.[1];
      let pageSpace = pageMeta.match(/ri:space-key="([^"]+?)"/)?.[1] || spaceKey;
      return `<a href="[PAGE:${pageSpace}:${pageTitle}]">${title}</a>`;
    });

  // user (mapping later)
  html = html.replace(/<ac:link[^>]*>[\s\S]*?<ri:user ri:userkey="([^"]+?)"[^>]*\/>[\s\S]*?<\/ac:link>/g,
    (match, userkey) => {
      return `<span style="color: rgb(24, 104, 219);">@[USER:${userkey}]</span>`;
    });

  // Handle time
  html = html.replace(/<time datetime="([^"]+?)" \/>/g,
    (match, datetime) => {
      return `<span style="background-color: rgb(206, 212, 217);">${datetime}</span>`;
    });

  // Handle task list
  html = html.replace(/<ac:task-list>([\s\S]*?)<\/ac:task-list>/g,
    (match, list) => {
      return `<ul style="list-style-type: tasklist;">${list}</ul>`;
    });
  html = html.replace(/<ac:task>[\s\S]*?<ac:task-status>(.*?)<\/ac:task-status>[\s\S]*?<ac:task-body>([\s\S]*?)<\/ac:task-body>[\s\S]*?<\/ac:task>/g,
    (match, status, body) => {
      let checked = status == 'complete' ? ' checked="checked"' : '';
      return `<li class="task-list-item"><input${checked} disabled="disabled" type="checkbox">${body}</li>`;
    });

  // Handle code block macro
  html = html.replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?(<ac:parameter ac:name="language">(.*)<\/ac:parameter>)?[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\s*\]\s*><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    (match, _, language, code) => {
      return `<pre><code class="language-${language || ''}">${encodeHtml(code)}</code></pre>`;
    });

  // Handle status macro
  html = html.replace(/<ac:structured-macro[^>]*ac:name="status"[^>]*><ac:parameter ac:name="title">(.*?)<\/ac:parameter>(<ac:parameter ac:name="colour">(.*?)<\/ac:parameter>)?<\/ac:structured-macro>/g,
    (match, title, _, color) => {
      return `<span style="background-color:${color?.toLowerCase() || 'grey'}">${title}</span>`;
    });

  // Handle callout macro
  html = html.replace(/<ac:structured-macro[^>]*ac:name="(?:info|note)"[^>]*>[\s\S]*?<ac:rich-text-body><p>([\s\S]*?)<\/p><\/ac:rich-text-body><\/ac:structured-macro>/g,
    (match, body) => {
      return `<p class="callout info">${body}</p>`;
    });
  html = html.replace(/<ac:structured-macro[^>]*ac:name="warning"[^>]*>[\s\S]*?<ac:rich-text-body><p>([\s\S]*?)<\/p><\/ac:rich-text-body><\/ac:structured-macro>/g,
    (match, body) => {
      return `<p class="callout warning">${body}</p>`;
    });

  // panel
  html = html.replace(/<ac:structured-macro[^>]*ac:name="panel"[^>]*>([\s\S]*?)(<ac:parameter ac:name="bgColor">(.*?)<\/ac:parameter>)?([\s\S]*?)<\/ac:structured-macro>/g,
    (match, body1, _, bgColor, body2) => {
      return `<table style="background-color:${bgColor?.toLowerCase() || 'grey'}"><tbody><tr><td>${body1}${body2}</td></tr></tbody></table>`;
    });

  // Convert structured macros (just remove them for now or convert to divs)
  html = html.replace(/<ac:structured-macro[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
    (match, body) => {
      return `<p>${body}</p>`;
    });

  // Remove other ac: elements
  html = html.replace(/<\/?ac:[^>]+>/g, '');
  html = html.replace(/<\/?ri:[^>]+>/g, '');

  return html;
}

// Build page hierarchy
function buildHierarchy(): Map<string | null, PageData[]> {
  const hierarchy: Map<string | null, PageData[]> = new Map();

  for (const [id, page] of pages) {
    const parentId = page.parentId;
    if (!hierarchy.has(parentId)) {
      hierarchy.set(parentId, []);
    }
    hierarchy.get(parentId)!.push(page);
  }

  // remove unlinked pages
  let rootPages = hierarchy.get(null) || [];
  rootPages = rootPages.filter(page => hierarchy.has(page.id));
  hierarchy.set(null, rootPages);

  // flatten subpages
  for (const mainPage of rootPages) {
    const books = hierarchy.get(mainPage.id) || [];
    for (const book of books) {
      const chapters = hierarchy.get(book.id) || [];
      for (const chapter of chapters) {
        let flatPages = [];

        const flatten = function (page: PageData, titlePrefix = '') {
          const subpages = hierarchy.get(page.id) || [];
          for (const subpage of subpages) {
            if (titlePrefix)
              subpage.title = `${titlePrefix}${SUBPAGE_SEPARATOR}${subpage.title}`;
            flatPages.push(subpage);
            flatten(subpage, subpage.title);
          }
        }

        flatten(chapter);
        hierarchy.set(chapter.id, flatPages);
      }
    }
  }

  return hierarchy;
}

// Get attachment file path (full path for checking existence)
function getAttachmentFullPath(containerId: string, attachmentId: string, version: string): string {
  return path.join(fileDirectory, subDirectory, 'attachments', containerId, attachmentId, version);
}

// Get attachment relative path (for storing in attachmentsByPage - relative to subDirectory)
function getAttachmentRelativePath(containerId: string, attachmentId: string, version: string): string {
  return path.join('attachments', containerId, attachmentId, version);
}

// Scan all attachments and build mapping
function buildAttachmentMapping() {
  console.log('Building attachment mapping...');

  for (const [id, attachment] of attachments) {
    const containerId = attachment.containerId;
    const fullPath = getAttachmentFullPath(containerId, id, attachment.version);
    const relativePath = getAttachmentRelativePath(containerId, id, attachment.version);

    if (fs.existsSync(fullPath)) {
      if (!attachmentsByPage[containerId]) {
        attachmentsByPage[containerId] = { attachmentHrefs: [], pageNewId: undefined };
      }

      attachmentsByPage[containerId].attachmentHrefs.push({
        name: attachment.title,
        href: relativePath
      });
    }
  }

  let totalAttachments = 0;
  for (const pageId of Object.keys(attachmentsByPage)) {
    totalAttachments += attachmentsByPage[pageId].attachmentHrefs.length;
  }

  console.log(`Mapped ${totalAttachments} attachments across ${Object.keys(attachmentsByPage).length} pages`);
}

// Create BookStack structure
async function createBookStackStructure(reporter?: any): Promise<{ shelves: number; books: number; chapters: number; pages: number }> {
  const hierarchy = buildHierarchy();
  const rootPages = hierarchy.get(null) || [];

  // Running counters for live updates
  let shelfCount = 0;
  let bookCount = 0;
  let chapterCount = 0;
  let pageCount = 0;

  const getCounters = () => ({
    shelves: shelfCount,
    books: bookCount,
    chapters: chapterCount,
    pages: pageCount
  });

  const log = (message: string, level: string = 'info') => {
    console.log(message);
    if (reporter) {
      reporter.log('import', message, level);
    }
  };

  const progress = (phase: string, message: string, current?: number, total?: number) => {
    console.log(message);
    if (reporter) {
      const data: any = { phase, message, counters: getCounters() };
      if (current !== undefined && total !== undefined) {
        data.current = current;
        data.total = total;
        data.percent = Math.round((current / total) * 100);
      }
      reporter.progress(data);
    }
  };

  // Create shelf
  if (reporter) reporter.start({ phase: 'shelves', message: 'Creating shelf...' });
  progress('shelves', `Creating shelf: ${spaceTitle}`, 0, 1);
  const shelfResp = await axios.createShelf({
    name: spaceTitle,
    tags: [
      { name: 'space', value: spaceKey },
    ]
  });
  shelfId = shelfResp.data.id;
  shelfCount++;
  log(`✓ Created shelf: ${spaceTitle} (ID: ${shelfId})`, 'success');
  progress('shelves', `Created shelf: ${spaceTitle}`, 1, 1);
  if (reporter) reporter.complete({ phase: 'shelves', message: `Created shelf: ${spaceTitle}`, counters: getCounters() });

  log(`Found ${rootPages.length} root pages`);

  // Find the main space page
  let mainPage = rootPages[0];

  if (!mainPage) {
    log('No main page found', 'error');
    return getCounters();
  }

  // Get child pages (these will be books)
  const childPages = [mainPage, ...(hierarchy.get(mainPage.id) || [])];
  log(`Found ${childPages.length} child pages (will be books)`);

  const bookIds: number[] = [];
  const totalBooks = childPages.length;

  // Count total pages for progress
  let totalPages = 0;
  for (const childPage of childPages) {
    totalPages++; // General page
    const grandChildren = hierarchy.get(childPage.id) || [];
    totalPages += grandChildren.length;
  }

  if (reporter) reporter.start({ phase: 'books', message: `Creating ${totalBooks} books...` });
  progress('books', `Creating ${totalBooks} books...`, 0, totalBooks);

  for (let i = 0; i < childPages.length; i++) {
    const childPage = childPages[i];
    progress('books', `Creating book ${i + 1}/${totalBooks}: ${childPage.title}`, i, totalBooks);

    try {
      const bookResp = await axios.createBook({
        name: childPage.title,
        tags: [
          { name: 'space', value: spaceKey },
        ]
      });
      const bookId = bookResp.data.id;
      bookIds.push(bookId);
      bookCount++;

      log(`✓ Created book: ${childPage.title}`, 'success');
      progress('books', `Created book: ${childPage.title}`, bookCount, totalBooks);

      // Create general page for the book with its content
      const bodyHtml = getPageBody(childPage);
      if (bodyHtml) { // skip folder
        const html = convertStorageToHtml(bodyHtml, childPage.id);

        const pageResp = await axios.createPage({
          book_id: bookId,
          name: '_General',
          html: html || '<p></p>'
        });
        pageCount++;

        // Map page ID for attachments
        if (attachmentsByPage[childPage.id]) {
          attachmentsByPage[childPage.id].pageNewId = pageResp.data.id;
        }

        log(`  ✓ Created general page for: ${childPage.title}`, 'success');
        progress('books', `Created general page for: ${childPage.title}`, bookCount, totalBooks);
      }
    } catch (err: any) {
      log(`✗ Error creating book ${childPage.title}: ${err.message}`, 'error');
    }
  }

  // Assign books to shelf
  if (bookIds.length > 0) {
    await axios.updateShelf(shelfId, { books: bookIds });
    log(`✓ Assigned ${bookIds.length} books to shelf`, 'success');
  }

  if (reporter) reporter.complete({ phase: 'books', message: `Created ${bookCount} books`, counters: getCounters() });

  // Now create pages for each book
  if (reporter) reporter.start({ phase: 'pages', message: `Creating ${totalPages} pages...` });
  progress('pages', `Creating ${totalPages} pages...`, 0, totalPages);

  const createPage = async function (page: PageData, params: { [key: string]: any }) {
    try {
      const pageBodyHtml = getPageBody(page);
      if (!pageBodyHtml) return false; // skip folder

      const pageHtml = convertStorageToHtml(pageBodyHtml, page.id);

      const pageResp = await axios.createPage({
        name: page.title,
        html: pageHtml || '<p></p>',
        ...params,
      });
      pageCount++;

      if (attachmentsByPage[page.id]) {
        attachmentsByPage[page.id].pageNewId = pageResp.data.id;
      }

      log(`  ✓ Created page: ${page.title}`, 'success');
      return true;
    } catch (err: any) {
      log(`  ✗ Error creating page ${page.title}: ${err.message}`, 'error');
      return false;
    }
  }

  let currentPageIndex = 0;
  for (let i = 0; i < childPages.length; i++) {
    const childPage = childPages[i];
    if (!childPage.parentId) continue; // main page

    const grandChildren = hierarchy.get(childPage.id) || [];

    // Find the book ID for this childPage
    const bookId = bookIds[i];
    if (!bookId) continue;

    for (let j = 0; j < grandChildren.length; j++) {
      const grandChild = grandChildren[j];
      currentPageIndex++;
      progress('pages', `Creating page ${currentPageIndex}/${totalPages}: ${grandChild.title}`, currentPageIndex, totalPages);

      const subpages = hierarchy.get(grandChild.id) || [];
      if (subpages.length) {
        // grandChild as chapter
        try {
          const chapterResp = await axios.createChapter({
            name: grandChild.title,
            book_id: bookId
          });
          chapterCount++;
          log(`  ✓ Created chapter: ${grandChild.title}`, 'success');

          const params = { chapter_id: chapterResp.data.id };
          await createPage(grandChild, params); // Create general page for chapter
          for (let subpage of subpages) { // Create subpage for chapter
            await createPage(subpage, params);
          }

          progress('pages', `Created chapter: ${grandChild.title}`, currentPageIndex, totalPages);
        } catch (err) {
          log(`  ✗ Error creating chapter ${grandChild.title}: ${err.message}`, 'error');
        }
      } else {
        // grandChild as page
        if (await createPage(grandChild, { book_id: bookId }))
          progress('pages', `Created page: ${grandChild.title}`, currentPageIndex, totalPages);
      }
    }
  }

  if (reporter) reporter.complete({ phase: 'pages', message: `Created ${pageCount} pages`, counters: getCounters() });

  return getCounters();
}

// Save attachment records
function saveAttachmentRecords() {
  const newAttachmentsRecords = { ...attachmentRecords };
  newAttachmentsRecords[subDirectory] = attachmentsByPage;

  const attachmentsCode = `module.exports = {
    attachmentRecords: ${JSON.stringify(newAttachmentsRecords)}
  };`;

  fs.writeFileSync('./outputJS/attachmentsFile.js', attachmentsCode);

  let totalFiles = 0;
  Object.values(attachmentsByPage).forEach((page: any) => {
    totalFiles += page.attachmentHrefs.length;
  });

  console.log(`\nSaved attachment records: ${Object.keys(attachmentsByPage).length} pages, ${totalFiles} files`);
}

async function main() {
  const xmlPath = path.join(fileDirectory, subDirectory, 'entities.xml');

  if (!fs.existsSync(xmlPath)) {
    console.log(`entities.xml not found at ${xmlPath}`);
    console.log('This importer is for Confluence XML exports. For HTML exports, use npm run import.');
    process.exit(1);
  }

  console.log('Reading entities.xml...');
  const xmlContent = fs.readFileSync(xmlPath, 'utf-8');

  parseEntitiesXml(xmlContent);
  buildAttachmentMapping();

  await createBookStackStructure();

  saveAttachmentRecords();

  console.log('\n=== Import Complete ===');
}

// Parse command line args
process.argv.forEach((val, index) => {
  if (index === 4 && val) {
    subDirectory = val;
  }
});

if (process.argv[3] === 'xml-import') {
  if (subDirectory) {
    main().catch(console.error);
  } else {
    console.log('Usage: npm run xml-import <subdirectory>');
  }
}

// Exported function for web interface
export async function runXmlImport(folder: string, reporter?: any): Promise<{ shelfId: number; shelves: number; books: number; chapters: number; pages: number }> {
  reloadEnvConfig();
  subDirectory = folder;

  // Reset state for fresh import
  pages = new Map();
  attachments = new Map();
  bodyContents = new Map();
  attachmentsByPage = {};

  const log = (message: string, level: string = 'info') => {
    console.log(message);
    if (reporter) {
      reporter.log('analyze', message, level);
    }
  };

  const xmlPath = path.join(fileDirectory, subDirectory, 'entities.xml');

  if (!fs.existsSync(xmlPath)) {
    throw new Error(`entities.xml not found at ${xmlPath}`);
  }

  // Stage 1: Analyze
  if (reporter) reporter.start({ phase: 'analyze', message: 'Reading entities.xml...' });
  log('Reading entities.xml...');
  const xmlContent = fs.readFileSync(xmlPath, 'utf-8');

  if (reporter) reporter.progress({ phase: 'analyze', message: 'Parsing XML structure...' });
  log('Parsing XML structure...');
  parseEntitiesXml(xmlContent);

  log('Building attachment mapping...');
  buildAttachmentMapping();

  log(`Discovered: ${pages.size} pages, ${attachments.size} attachments`);
  if (reporter) reporter.complete({ phase: 'analyze', message: `Found ${pages.size} pages, ${attachments.size} attachments` });

  // Stage 2-4: Create structure (shelves, books, pages)
  const result = await createBookStackStructure(reporter);

  saveAttachmentRecords();

  return {
    shelfId: shelfId,
    shelves: result.shelves,
    books: result.books,
    chapters: result.chapters,
    pages: result.pages,
  };
}
