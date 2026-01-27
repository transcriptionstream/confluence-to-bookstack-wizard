import { attachmentRecords } from '../outputJS/attachmentsFile'

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { AxiosAdapter } = require('../axiosAdapter.js');

const fileDirectory = process.env.PATH_TO_HTML;
let subDirectory: string;

const credentials = {
  url: process.env.URL,
  id: process.env.ID,
  secret: process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret);

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

let pages: Map<string, PageData> = new Map();
let attachments: Map<string, AttachmentData> = new Map();
let bodyContents: Map<string, BodyContentData> = new Map();
let attachmentsByPage: { [key: string]: { attachmentHrefs: { name: string; href: string }[]; pageNewId?: number } } = {};

// Simple XML parser - extracts objects from Confluence XML export
function parseEntitiesXml(xmlContent: string) {
  console.log('Parsing entities.xml...');

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

// Find attachment file by filename for a given page
function findAttachmentFile(pageId: string, filename: string): string | null {
  const pageAttachmentsDir = path.join(fileDirectory, subDirectory, 'attachments', pageId);

  if (!fs.existsSync(pageAttachmentsDir)) {
    return null;
  }

  // Look through attachments for this page
  for (const [attId, att] of attachments) {
    if (att.containerId === pageId && att.title === filename) {
      const filePath = path.join(pageAttachmentsDir, attId, att.version);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
  }

  return null;
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

// Convert image to base64 data URL
function imageToBase64(filePath: string, filename: string): string | null {
  try {
    const data = fs.readFileSync(filePath);
    const base64 = data.toString('base64');
    const mimeType = getMimeType(filename);
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    return null;
  }
}

// Convert Confluence storage format to HTML
function convertStorageToHtml(storageFormat: string, pageId: string): string {
  let html = storageFormat;

  // Convert ac:image to img tags with base64 embedded images
  html = html.replace(/<ac:image[^>]*>[\s\S]*?<ri:attachment ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:image>/g,
    (match, filename) => {
      const filePath = findAttachmentFile(pageId, filename);
      if (filePath) {
        const base64Url = imageToBase64(filePath, filename);
        if (base64Url) {
          return `<img src="${base64Url}" alt="${filename}" />`;
        }
      }
      // Fallback to placeholder if image not found
      return `<p>[Image: ${filename}]</p>`;
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

  // Convert structured macros (just remove them for now or convert to divs)
  html = html.replace(/<ac:structured-macro[^>]*>[\s\S]*?<\/ac:structured-macro>/g, '');

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
async function createBookStackStructure() {
  const hierarchy = buildHierarchy();
  const rootPages = hierarchy.get(null) || [];

  console.log(`Found ${rootPages.length} root pages`);

  // Find the main space page (usually "Human Resources")
  let mainPage = rootPages.find(p => p.title.toLowerCase().includes('human resources'));
  if (!mainPage && rootPages.length > 0) {
    mainPage = rootPages[0];
  }

  if (!mainPage) {
    console.log('No main page found');
    return;
  }

  console.log(`Main page: ${mainPage.title}`);

  // Create shelf
  console.log('Creating shelf...');
  const shelfResp = await axios.createShelf({ name: mainPage.title });
  const shelfId = shelfResp.data.id;
  console.log(`Created shelf: ${mainPage.title} (ID: ${shelfId})`);

  // Get child pages (these will be books)
  const childPages = hierarchy.get(mainPage.id) || [];
  console.log(`Found ${childPages.length} child pages (will be books)`);

  const bookIds: number[] = [];

  for (const childPage of childPages) {
    console.log(`Creating book: ${childPage.title}`);

    try {
      const bookResp = await axios.createBook({ name: childPage.title });
      const bookId = bookResp.data.id;
      bookIds.push(bookId);

      // Create general page for the book with its content
      const bodyHtml = getPageBody(childPage);
      const html = convertStorageToHtml(bodyHtml, childPage.id);

      const pageResp = await axios.createPage({
        book_id: bookId,
        name: '_General',
        html: html || '<p></p>'
      });

      // Map page ID for attachments
      if (attachmentsByPage[childPage.id]) {
        attachmentsByPage[childPage.id].pageNewId = pageResp.data.id;
      }

      // Get grandchildren (these will be pages in the book)
      const grandChildren = hierarchy.get(childPage.id) || [];

      for (const grandChild of grandChildren) {
        console.log(`  Creating page: ${grandChild.title}`);

        const grandBodyHtml = getPageBody(grandChild);
        const grandHtml = convertStorageToHtml(grandBodyHtml, grandChild.id);

        try {
          const grandPageResp = await axios.createPage({
            book_id: bookId,
            name: grandChild.title,
            html: grandHtml || '<p></p>'
          });

          if (attachmentsByPage[grandChild.id]) {
            attachmentsByPage[grandChild.id].pageNewId = grandPageResp.data.id;
          }
        } catch (err: any) {
          console.log(`    Error creating page: ${err.message}`);
        }
      }

    } catch (err: any) {
      console.log(`  Error creating book: ${err.message}`);
    }
  }

  // Assign books to shelf
  if (bookIds.length > 0) {
    await axios.updateShelf(shelfId, { books: bookIds });
    console.log(`Assigned ${bookIds.length} books to shelf`);
  }
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
export async function runXmlImport(folder: string, reporter?: any): Promise<{ shelves: number; books: number; chapters: number; pages: number }> {
  subDirectory = folder;

  let shelfCount = 0;
  let bookCount = 0;
  let pageCount = 0;

  const log = (phase: string, message: string, level: string = 'info') => {
    if (reporter) {
      reporter.log(phase, message, level);
    } else {
      console.log(message);
    }
  };

  const xmlPath = path.join(fileDirectory, subDirectory, 'entities.xml');

  if (!fs.existsSync(xmlPath)) {
    throw new Error(`entities.xml not found at ${xmlPath}`);
  }

  if (reporter) reporter.start({ phase: 'xml-import', message: 'Reading entities.xml...' });
  const xmlContent = fs.readFileSync(xmlPath, 'utf-8');

  if (reporter) reporter.progress({ phase: 'xml-import', message: 'Parsing XML...' });
  parseEntitiesXml(xmlContent);
  buildAttachmentMapping();

  if (reporter) reporter.progress({ phase: 'xml-import', message: 'Creating BookStack structure...' });
  await createBookStackStructure();

  saveAttachmentRecords();

  // Count results
  shelfCount = 1; // We create one shelf per import
  bookCount = pages.size > 0 ? Math.min(pages.size, 10) : 0; // Estimate
  pageCount = pages.size;

  if (reporter) {
    reporter.complete({
      phase: 'xml-import',
      message: 'XML import complete',
      counters: {
        shelves: shelfCount,
        books: bookCount,
        chapters: 0,
        pages: pageCount,
      }
    });
  }

  return {
    shelves: shelfCount,
    books: bookCount,
    chapters: 0,
    pages: pageCount,
  };
}
