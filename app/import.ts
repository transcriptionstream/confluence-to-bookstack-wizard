import { ICreatePageParams } from "./params";
import { logTrey } from "./trey";
import { attachmentRecords } from '../outputJS/attachmentsFile'

require('dotenv').config();
const slugify = require('slugify');
const fs = require( 'fs' );
const { AxiosAdapter } = require('../axiosAdapter.js');
const jsdom = require("jsdom");

const fileDirectory = process.env.PATH_TO_HTML
let subDirectory
let timeoutBetweenPages = 600

const credentials = {
  "url": process.env.URL,
  "id": process.env.ID,
  "secret": process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret)

let shelves = []
let books = []
let chapters = []
let chapterGeneralPages = []

let attachmentsByPage = {}

const sortedFiles = {
  shelves: [],
  books: [],
  chapterFilenames: [],
  chapters: {},
  pages: [],
  pagesBelongChapter: [],
  pagesBelongBook: []
}

const retry = {
  chapters: [],
  chapterGeneralPages: [],
  pages: []
}

let pageCreatedCount = 0
let chapterCreatedCount = 0
let bookCreatedCount = 0

let pagesNotCreated = []

// Module-level reporter for verbose logging
let currentReporter: any = null;
let currentPhase: string = 'import';

const logVerbose = (message: string, level: string = 'info') => {
  console.log(`[${currentPhase}] ${message}`);
  if (currentReporter) {
    currentReporter.log(currentPhase, message, level);
  }
};

const emitProgress = (message: string, current?: number, total?: number) => {
  if (currentReporter) {
    const data: any = { phase: currentPhase, message };
    if (current !== undefined && total !== undefined) {
      data.current = current;
      data.total = total;
      data.percent = Math.round((current / total) * 100);
    }
    data.counters = {
      shelves: shelves.length,
      books: bookCreatedCount,
      chapters: chapterCreatedCount,
      pages: pageCreatedCount
    };
    currentReporter.progress(data);
  }
};
let chaptersNotCreated = []
let booksNotCreated = []

const onlyUnique = (value, index, array) => {
  return array.indexOf(value) === index;
}

const getFilePath = (filename) => {
  return `${fileDirectory}/${subDirectory}/${filename}`
}

const getIdFromHref = (tagA) => {
  const splitByUnderscores = tagA.getAttribute('href').split('.html')[0].split('_')
  return splitByUnderscores[splitByUnderscores.length - 1]
}

const getIdFromFilename = (filename) => {
  const splitByUnderscores = filename.split('.html')[0].split('_')
  return splitByUnderscores[splitByUnderscores.length - 1]
}

const getSlugFromFilename = (filename) => {
  if (filename) {
    const splitByUnderscores = filename.split('.html')[0].split('_')
    const id = splitByUnderscores[splitByUnderscores.length - 1]
    const slug = filename.replace(`_${id}.html`, '').toLowerCase()
    return slug
  }
  return ''
}

const isInternalLink = (href: string) => {
  return href &&
    href.endsWith('.html') &&
    !href.startsWith('https://') &&
    !href.startsWith('http://')
}

const linkToType = (filename: string) => {
  if (sortedFiles.shelves.includes(filename)) {
    return 'shelf'
  }
  if (sortedFiles.books.includes(filename)) {
    return 'book'
  }
  if (sortedFiles.chapterFilenames.includes(filename)) {
    return 'chapter'
  }
  if (sortedFiles.pages.includes(filename)) {
    return 'page'
  }
  return 'COULD NOT FIND LINK TYPE'
}

const getSlugFromTitleInFile = (filename: string) => {
  const file = fs.readFileSync(getFilePath(filename), 'utf-8')
  const dom = new jsdom.JSDOM(file);
  let title = (dom.window.document.getElementById('title-text')?.textContent || '').trim()
  if (title.includes(" : ")) {
    title = title.split(' : ')[1]
  }
  title.toLowerCase().replace('_', '-')
  return slugify(title, {
    remove: /[*+~.()'"!:@]/g
  })
}

const getLinkToChapterOrPage = (filename: string, type: string) => {
  const file = fs.readFileSync(getFilePath(filename), 'utf-8')
  const dom = new jsdom.JSDOM(file);
  const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
  const breadcrumbListItems = breadcrumbs?.getElementsByTagName('li') || []
  const breadcrumbsArr = [...breadcrumbListItems]
  const branch = breadcrumbsArr.map(v => v.getElementsByTagName('a')[0].getAttribute('href'))

  if (type === 'chapter') {
    return `/books/${getSlugFromTitleInFile(branch[2])}/chapter/${getSlugFromTitleInFile(filename)}`
  }

  if (type === 'page') {
    return `/books/${getSlugFromTitleInFile(branch[2])}/page/${getSlugFromTitleInFile(filename)}`
  }
}

const isAttachmentLink = (link: HTMLElement) => {
  const href = link.getAttribute('href')
  // Match both export format (attachments/...) and Confluence server format (/download/attachments/...)
  return href && (href.startsWith("attachments/") || href.includes('/download/attachments/'))
}

// Extract attachment path from either format and convert to local export path
const getAttachmentInfo = (link: HTMLElement, pageId: string) => {
  const href = link.getAttribute('href') || ''
  let localHref = ''
  let name = ''

  if (href.startsWith("attachments/")) {
    // Export format: attachments/pageId/attachmentId.ext
    localHref = href
    name = link.textContent?.trim() || ''
  } else if (href.includes('/download/attachments/')) {
    // Confluence server format: /download/attachments/pageId/filename?version=...
    // Use data-linked-resource-id to get the attachment ID
    const attachmentId = link.getAttribute('data-linked-resource-id')
    const alias = link.getAttribute('data-linked-resource-default-alias') || ''

    if (attachmentId) {
      // Get the file extension from the alias
      const ext = alias.includes('.') ? '.' + alias.split('.').pop() : ''
      localHref = `attachments/${pageId}/${attachmentId}${ext}`
      name = alias || link.textContent?.trim() || ''
    }
  }

  return { localHref, name }
}

const removeElementByClassName = (dom, className) => {
  const elementToRemove = dom.window.document.getElementsByClassName(className)
  if (elementToRemove.length > 0) {
    elementToRemove[0].remove()
  }
}

const replaceBreadcrumbsAndLinks = (dom: any, breadcrumbs: HTMLElement, filename: string) => {
  const titleTextElement = dom.window.document.getElementById('title-text')
  let title = "title not found"
  // Get Title
  if (titleTextElement) {
    title = dom.window.document.getElementById('title-text').textContent
  }
  const titleHeading = dom.window.document.getElementById('title-heading')
  if (titleHeading) {
    titleHeading.remove()
  }
  // Remove entire attachments section (including all version history links)
  // This must happen BEFORE we scan for attachment links, so we only capture
  // attachments actually referenced in the main content
  const attachmentsH2 = dom.window.document.getElementById('attachments')
  if (attachmentsH2) {
    // The H2 is inside div.pageSectionHeader inside div.pageSection.group
    // Remove the entire pageSection container
    const pageSection = attachmentsH2.closest('.pageSection')
    if (pageSection) {
      pageSection.remove()
    } else {
      attachmentsH2.remove()
    }
  }
  removeElementByClassName(dom, 'footer-body')
  removeElementByClassName(dom, 'plugin_attachments_upload_container')
  removeElementByClassName(dom, 'download-all-link')
  breadcrumbs?.remove()
  const allLinks = dom.window.document.getElementsByTagName('a')
  const linksArr = [...allLinks]
  linksArr.forEach((link, i) => {
    const href = link.getAttribute('href')
    if (isInternalLink(href)) {
      const linkType = linkToType(href)
      let newHref

      switch (linkType) {
        case 'shelf':
          newHref = `/shelves/${getSlugFromFilename(href)}`
          break
        case 'book':
          newHref = `/books/${getSlugFromFilename(href)}`
          break
        case 'chapter':
        case 'page':
          newHref = getLinkToChapterOrPage(href, linkType)
          break
      }

      if (newHref) {
        allLinks[i].setAttribute('href', newHref)
      }
    }

    if (href && isAttachmentLink(link)) {
      const pageId = getIdFromFilename(filename)
      const attachmentInfo = getAttachmentInfo(link, pageId)

      if (attachmentInfo.localHref) {
        const existingRecord = attachmentsByPage[pageId]
        if (existingRecord) {
          const obj = {
            attachmentHrefs: [...existingRecord.attachmentHrefs, { name: attachmentInfo.name, href: attachmentInfo.localHref }],
            pageNewId: undefined
          }
          attachmentsByPage[pageId] = obj
        } else {
          const obj = {
            attachmentHrefs: [{ name: attachmentInfo.name, href: attachmentInfo.localHref }],
            pageNewId: undefined
          }
          attachmentsByPage[pageId] = obj
        }
      }
    }
  })
}

const sortFiles = () => {
  const readPath = `${fileDirectory}/${subDirectory}`;
  logVerbose(`sortFiles: Reading from path: ${readPath}`);

  const files = fs.readdirSync(readPath)
  const htmlFiles = files.filter(fn => fn.endsWith('.html'))

  logVerbose(`sortFiles: Found ${htmlFiles.length} HTML files`);

  const threeBreadcrumbsFilenames = []
  const branchesWithFourOrMore = []
  let filesWithBreadcrumbs = 0;
  let filesWithoutBreadcrumbs = 0;

  htmlFiles.forEach(filename => {
    const file = fs.readFileSync(getFilePath(filename), 'utf-8')
    const dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
    if (breadcrumbs) {
      filesWithBreadcrumbs++;
      const breadcrumbListItems = breadcrumbs.getElementsByTagName('li')
  
      if (breadcrumbListItems.length === 1) {
        // Consistent. Always a shelf.
        sortedFiles.shelves.push(filename)
      }
  
      if (breadcrumbListItems.length === 2) {
        // Consistent. Always a book.
        sortedFiles.books.push(filename)
      }
  
      if (breadcrumbListItems.length === 3) {
        // PROBLEM: Could be chapter or page depending on what comes after.
        // Populate branchesWithFourOrMore FIRST, then handle this and check branches for existing structures to determine if something comes after or not.
        threeBreadcrumbsFilenames.push(filename)
      }
  
      if (breadcrumbListItems.length >= 4) {
        // Third breadcrumb is chapter, anything after is page
        const arr = [...breadcrumbListItems]
        const branch = arr.map(v => v.getElementsByTagName('a')[0].getAttribute('href'))
        branchesWithFourOrMore.push(branch)
        sortedFiles.pages.push(filename)
        sortedFiles.chapterFilenames.push(branch[3])
        sortedFiles.chapters[branch[3]] = {
          bookPreviousId: getIdFromFilename(branch[2]),
          chapterFilename: branch[3],
          chapterPreviousId: getIdFromFilename(branch[3]),
          pageFilenames: sortedFiles.chapters[branch[3]] && sortedFiles.chapters[branch[3]].pageFilenames ? [...sortedFiles.chapters[branch[3]].pageFilenames, filename] : [filename]
        }
      }
    } else {
      filesWithoutBreadcrumbs++;
      // Log the first few files without breadcrumbs to help debug
      if (filesWithoutBreadcrumbs <= 3) {
        logVerbose(`sortFiles: No breadcrumbs in file: ${filename}`, 'warning');
      }
    }
  })

  logVerbose(`sortFiles: ${filesWithBreadcrumbs} files with breadcrumbs, ${filesWithoutBreadcrumbs} without`);
  logVerbose(`sortFiles: Sorted into - shelves: ${sortedFiles.shelves.length}, books: ${sortedFiles.books.length}, chapters: ${Object.keys(sortedFiles.chapters).length}, pages: ${sortedFiles.pages.length}`);

  threeBreadcrumbsFilenames.forEach(filename => {
    const indexIncludingThisFile = branchesWithFourOrMore.findIndex(arr => arr.includes(filename))
    if (indexIncludingThisFile > -1) {
      // Is a chapter
    } else {
      // Is a page with no chapter files
      sortedFiles.pages.push(filename)
      sortedFiles.pagesBelongBook.push({
        pageFilename: filename
      })
    }
  })
}

const createChapters = async () => {
  currentPhase = 'chapters';
  const chapterFilenames = Object.keys(sortedFiles.chapters);
  const totalChapters = chapterFilenames.length;

  for (let i = 0; i < chapterFilenames.length; i++) {
    const chapterFilename = chapterFilenames[i];
    const file = fs.readFileSync(getFilePath(chapterFilename), 'utf-8');
    const dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs');
    const titleHeading = dom.window.document.getElementById('title-heading');
    const bookPreviousIdNeeded = sortedFiles.chapters[chapterFilename].bookPreviousId;
    const parentBook = books.find(book => book.previousId === bookPreviousIdNeeded);

    if (!parentBook) {
      logVerbose(`Warning: Missing parent book for chapter: ${chapterFilename}`, 'warning');
      continue;
    }

    const titleTextElement = dom.window.document.getElementById('title-text');
    let title = "generic title";
    if (titleTextElement) {
      title = titleTextElement.textContent.trim();
    }
    titleHeading.remove();
    breadcrumbs.remove();
    const htmlString = dom.serialize();

    if (title.includes(" : ")) {
      title = title.split(' : ')[1].trim();
    }

    logVerbose(`Creating chapter ${i + 1}/${totalChapters}: ${title}`);
    emitProgress(`Creating chapter: ${title}`, i, totalChapters);

    try {
      const chapterResp = await axios.createChapter({
        name: title,
        book_id: parentBook.book
      });

      const newChapterId = chapterResp.data.id;
      chapters.push({
        id: newChapterId,
        previousId: sortedFiles.chapters[chapterFilename].chapterPreviousId
      });

      sortedFiles.chapters[chapterFilename].pageFilenames.forEach(fn => {
        sortedFiles.pagesBelongChapter.push({
          chapterId: newChapterId,
          pageFilename: fn
        });
      });

      chapterCreatedCount++;
      logVerbose(`✓ Created chapter: ${title}`, 'success');
      emitProgress(`Created chapter: ${title}`, chapterCreatedCount, totalChapters);

      // Create general page for chapter
      try {
        const pageResp = await axios.createPage({
          chapter_id: newChapterId,
          name: "_General",
          html: htmlString
        });
        const pageId = getIdFromFilename(chapterFilename);
        if (!attachmentsByPage[pageId]) {
          attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: pageResp.data.id };
        } else {
          attachmentsByPage[pageId].pageNewId = pageResp.data.id;
        }
        chapterGeneralPages.push(chapterFilename);
      } catch (err) {
        retry.chapterGeneralPages.push({
          chapter_id: newChapterId,
          name: "_General",
          html: htmlString
        });
      }
    } catch (err) {
      logVerbose(`✗ Failed to create chapter: ${title}`, 'error');
      chaptersNotCreated.push(chapterFilename);
      retry.chapters.push({
        chapterParams: { name: title, book_id: parentBook.book },
        generalHtml: htmlString
      });
    }

    // Small delay between chapters
    if (i < chapterFilenames.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

const putBooksOnShelves = async () => {
  const shelfIds = books.map(book => book.shelf)
  const uniqueIds = shelfIds.filter(onlyUnique)
  const promises = uniqueIds.map((id) => {
    const shelfBooks = books.filter(b => b.shelf === id).map(b => b.book)
    return axios.updateShelf(id, { books: shelfBooks })
  })

  const updatedShelves = await Promise.all(promises)
  return updatedShelves
}

const createBooks = async () => {
  currentPhase = 'books';
  const shelfFilenames = new Set(sortedFiles.shelves);
  const totalBooks = sortedFiles.books.length;

  for (let i = 0; i < sortedFiles.books.length; i++) {
    const filename = sortedFiles.books[i];
    const file = fs.readFileSync(getFilePath(filename), 'utf-8');
    const dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs');
    const breadcrumbLinkItems = breadcrumbs.getElementsByTagName('a');
    const arr = [...breadcrumbLinkItems];

    let parentShelf;
    arr.forEach((item) => {
      const href = item.getAttribute('href');
      if (href.includes('Home_') || shelfFilenames.has(href)) {
        parentShelf = shelves.find(shelf => shelf.previousId === getIdFromHref(item));
      }
    });

    if (!parentShelf) {
      logVerbose(`Warning: No parent shelf found for book: ${filename}`, 'warning');
      continue;
    }

    const titleTextElement = dom.window.document.getElementById('title-text');
    let title = "generic title";
    if (titleTextElement) {
      title = titleTextElement.textContent.trim();
    }
    if (title.includes(" : ")) {
      title = title.split(' : ')[1].trim();
    }

    logVerbose(`Creating book ${i + 1}/${totalBooks}: ${title}`);
    emitProgress(`Creating book: ${title}`, i, totalBooks);

    replaceBreadcrumbsAndLinks(dom, breadcrumbs, filename);
    const htmlString = dom.serialize();

    try {
      const bookResp = await axios.createBook({ name: title });
      const bookId = bookResp.data.id;

      books.push({
        book: bookId,
        previousId: getIdFromFilename(filename),
        shelf: parentShelf.id
      });
      bookCreatedCount++;

      try {
        const pageResp = await axios.createPage({
          book_id: bookId,
          name: "_General",
          html: htmlString
        });
        const pageId = getIdFromFilename(filename);
        if (!attachmentsByPage[pageId]) {
          attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: pageResp.data.id };
        } else {
          attachmentsByPage[pageId].pageNewId = pageResp.data.id;
        }
      } catch (err) {
        logVerbose(`Failed to create general page for book: ${title}`, 'error');
      }

      logVerbose(`✓ Created book: ${title}`, 'success');
      emitProgress(`Created book: ${title}`, bookCreatedCount, totalBooks);
    } catch (err) {
      logVerbose(`✗ Failed to create book: ${title}`, 'error');
      booksNotCreated.push(filename);
    }

    // Small delay between books
    if (i < sortedFiles.books.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

const createShelves = async () => {
  currentPhase = 'shelves';
  const totalShelves = sortedFiles.shelves.length;
  let completedShelves = 0;

  for (let i = 0; i < sortedFiles.shelves.length; i++) {
    const shelfFileName = sortedFiles.shelves[i];
    const file = fs.readFileSync(getFilePath(shelfFileName), 'utf-8')
    const dom = new jsdom.JSDOM(file);
    const breadCrumbs = dom.window.document.getElementById('breadcrumbs')
    const titleHeading = dom.window.document.getElementById('title-heading')
    const breadcrumbsFirst = breadCrumbs.getElementsByClassName('first')
    breadCrumbs.remove()
    titleHeading.remove()
    const htmlString = dom.serialize()
    const title = breadcrumbsFirst[0].getElementsByTagName('a')[0].textContent.trim()

    logVerbose(`Creating shelf ${i + 1}/${totalShelves}: ${title}`);
    emitProgress(`Creating shelf: ${title}`, i, totalShelves);

    try {
      const bookResp = await axios.createBook({ name: `${title}: Home` });
      const bookId = bookResp.data.id;

      try {
        const pageResp = await axios.createPage({
          book_id: bookId,
          name: "_General",
          html: htmlString
        });
        const pageId = getIdFromFilename(shelfFileName);
        if (!attachmentsByPage[pageId]) {
          attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: pageResp.data.id };
        } else {
          attachmentsByPage[pageId].pageNewId = pageResp.data.id;
        }
      } catch (err) {
        logVerbose(`Failed to create general page for shelf: ${title}`, 'error');
      }

      const shelfResp = await axios.createShelf({
        name: title,
        books: [bookId],
      });

      shelves.push({
        id: shelfResp.data.id,
        previousId: getIdFromFilename(shelfFileName)
      });
      books.push({
        book: bookId,
        previousId: getIdFromFilename(shelfFileName),
        shelf: shelfResp.data.id
      });

      completedShelves++;
      logVerbose(`✓ Created shelf: ${title}`, 'success');
      emitProgress(`Created shelf: ${title}`, completedShelves, totalShelves);
    } catch (err) {
      logVerbose(`✗ Failed to create shelf: ${title}`, 'error');
    }
  }
}

const createAttachment = async () => {
  const params = {
    uploaded_to: 10306,
    name: 'Generic name!',
    file: fs.createReadStream('./html/ITDocs/attachments/3768481/3866673.jpg')
  }
  console.log(params)
  axios.createAttachment(params)
    .then(resp => {
      console.log(resp.data)
    })
    .catch(err => {
      console.log(err)
    })
}

const getBase64FromElement = (element) => {
  const path = getFilePath(element.getAttribute('src'))
  const data = fs.readFileSync(path)
  return data.toString('base64')
}

const replaceImgWithBase64 = (dom, fileId) => {
  let replacedImages = []
  const imgElements = dom.window.document.getElementsByTagName('img')
  const arr = [...imgElements]
  arr.forEach((img, i) => {
    if (img.getAttribute('src') && fs.existsSync(getFilePath(img.getAttribute('src')))) {
      replacedImages.push(img.getAttribute('src'))
      imgElements[i].setAttribute('src', `data:image/png;base64, ${getBase64FromElement(img)}`)
    }
  })
  return replacedImages
}

const createPages = async (pagesArray) => {
  const filenames = pagesArray.map(p => p.pageFilename)
  const totalPages = filenames.length;
  const isChapterPages = pagesArray[0]?.chapterId !== undefined;
  const pageType = isChapterPages ? 'chapter page' : 'standalone page';

  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    const file = fs.readFileSync(getFilePath(filename), 'utf-8')
    let dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
    const breadcrumbLinkItems = breadcrumbs.getElementsByTagName('a')
    const titleHeading = dom.window.document.getElementById('title-heading')
    var arr = [...breadcrumbLinkItems];
    let parentBook
    arr.forEach((item, idx) => {
      if (idx === 2) {
        const parentBookPreviousId = getIdFromHref(item)
        parentBook = books.find(b => b.previousId === parentBookPreviousId)
      }
    })

    const titleTextElement = dom.window.document.getElementById('title-text')
    let title = "title not found"
    if (titleTextElement) {
      title = dom.window.document.getElementById('title-text').textContent.trim()
    }

    if (title.includes(" : ")) {
      title = title.split(' : ')[1].trim()
    }

    logVerbose(`Creating ${pageType} ${i + 1}/${totalPages}: ${title}`);
    emitProgress(`Creating ${pageType}: ${title}`, i + 1, totalPages);

    replaceImgWithBase64(dom, getIdFromFilename(filename))
    titleHeading.remove()
    replaceBreadcrumbsAndLinks(dom, breadcrumbs, filename)
    const htmlString = dom.serialize()

    const params: ICreatePageParams = {
      name: `${title}`,
      html: htmlString
    }

    if (pagesArray[i].chapterId) {
      params.chapter_id = pagesArray[i].chapterId
    } else {
      params.book_id = parentBook.book
    }

    // Add delay between pages
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, timeoutBetweenPages));
    }

    try {
      const resp = await axios.createPage(params);
      const pageId = getIdFromFilename(filename)
      // Always register the BookStack page ID for attachment uploads
      if (!attachmentsByPage[pageId]) {
        attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: resp.data.id }
      } else {
        attachmentsByPage[pageId].pageNewId = resp.data.id
      }
      pageCreatedCount++
      logVerbose(`✓ Created page: ${title}`, 'success');
      emitProgress(`Created page: ${title}`, i + 1, totalPages);
    } catch (err) {
      logVerbose(`✗ Failed to create page: ${title}`, 'error');
      pagesNotCreated.push(filename)
    }
  }
}

const fixLinks = () => {
  sortFiles()
  const files = fs.readdirSync(`${fileDirectory}/${subDirectory}`)
  const htmlFiles = files.filter(fn => fn.endsWith('.html'))
  htmlFiles.forEach(filename => {
    if (filename !== 'index.html') {
      const file = fs.readFileSync(getFilePath(filename), 'utf-8')
      const dom = new jsdom.JSDOM(file);
      const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
      replaceBreadcrumbsAndLinks(dom, breadcrumbs, filename)
    }
  })
  const attachmentsCode = `module.exports = {
    attachmentsByPage: ${JSON.stringify(attachmentsByPage)}
  };`

  fs.writeFileSync("./outputJS/attachmentsFile.js", attachmentsCode);
}

const chapterRetry = async () => {
  let promises = retry.chapters.map((chapter) => {
    const { filename } = chapter.chapterParams
    return axios.createChapter(chapter.chapterParams)
      .then(resp => {
        const newChapterId = resp.data.id
        chapters.push({
          id: newChapterId,
          previousId: sortedFiles.chapters[filename].chapterPreviousId
        })
        sortedFiles.chapters[filename].pageFilenames.forEach(fn => {
          sortedFiles.pagesBelongChapter.push({
            chapterId: newChapterId,
            pageFilename: fn
          })
        })
        
        console.log(`\x1b[32m ${filename} \x1b[0m`)
        chapterCreatedCount++

        return resp
      })
      .then(resp => {
        // return axios.create
      })
  })
}

const handleRetry = async() => {
  if (retry.chapters.length > 0) {
    // await 
  }
  return
}

const displayResultsAndTrey = () => {
  console.log('------------------------------------------------')
  console.log(`\x1b[32m Books Created: ${bookCreatedCount} \x1b[0m`)
  console.log(`\x1b[32m Chapters Created: ${chapterCreatedCount} \x1b[0m`)
  console.log(`\x1b[32m Pages Created: ${pageCreatedCount} \x1b[0m`)
  console.log(`\x1b[31m Book Errors: ${booksNotCreated.length} \x1b[0m`)
  console.log(`\x1b[31m Chapter Errors: ${chaptersNotCreated.length} \x1b[0m`)
  console.log(`\x1b[31m Page Errors: ${pagesNotCreated.length} \x1b[0m`)
  logTrey({ 
    color: booksNotCreated.length > 0 || pagesNotCreated.length > 0 || retry.chapterGeneralPages.length > 0 ? '\x1b[91m' : '\x1b[32m'
    })

  console.log("Books Not Created:")
  booksNotCreated.forEach((book) => {
    console.log(`\x1b[91m ${book} \x1b[0m`)
    })
  console.log("Chapters Not Created:")
  chaptersNotCreated.forEach((chapter) => {
    console.log(`\x1b[91m ${chapter} \x1b[0m`)
    })
  console.log("Chapter Generals Not Created:")
  retry.chapterGeneralPages.forEach((chapter) => {
    console.log(`\x1b[91m ${chapter} \x1b[0m`)
    })
  console.log("Pages Not Created:")
  pagesNotCreated.forEach((page) => {
    console.log(`\x1b[91m ${page} \x1b[0m`)
  })
}

// Scan filesystem for ALL attachments in each page's folder
const scanAllAttachments = () => {
  const attachmentsPath = `${fileDirectory}/${subDirectory}/attachments`

  if (!fs.existsSync(attachmentsPath)) {
    console.log('No attachments folder found')
    return
  }

  const pageFolders = fs.readdirSync(attachmentsPath)

  pageFolders.forEach(pageId => {
    const folderPath = `${attachmentsPath}/${pageId}`
    if (!fs.statSync(folderPath).isDirectory()) return

    const files = fs.readdirSync(folderPath)

    files.forEach(filename => {
      const filePath = `${folderPath}/${filename}`
      if (fs.statSync(filePath).isDirectory()) return

      const href = `attachments/${pageId}/${filename}`

      // Get friendly name (filename without the numeric ID prefix if present)
      let name = filename

      const existingRecord = attachmentsByPage[pageId]
      if (existingRecord) {
        // Check if this file is already recorded (avoid duplicates)
        const alreadyExists = existingRecord.attachmentHrefs.some(a => a.href === href)
        if (!alreadyExists) {
          existingRecord.attachmentHrefs.push({ name, href })
        }
      } else {
        attachmentsByPage[pageId] = {
          attachmentHrefs: [{ name, href }],
          pageNewId: undefined
        }
      }
    })
  })

  // Update pageNewId for pages that were created
  // Match by pageId (previousId) to the BookStack page ID
  Object.keys(attachmentsByPage).forEach(pageId => {
    // This will be set during page creation already for pages that have content-linked attachments
    // For pages without content links, we need to find the BookStack page ID
    // This is handled in the page creation functions where attachmentsByPage[pageId].pageNewId is set
  })
}

const handleAttachments = () => {
  // Scan filesystem for all attachments
  scanAllAttachments()

  const newAttachmentsRecords = {...attachmentRecords}
  newAttachmentsRecords[subDirectory] = attachmentsByPage

  const attachmentsCode = `module.exports = {
    attachmentRecords: ${JSON.stringify(newAttachmentsRecords)}
  };`

  fs.writeFileSync("./outputJS/attachmentsFile.js", attachmentsCode);

  // Log summary
  let totalFiles = 0
  Object.values(attachmentsByPage).forEach((page: any) => {
    totalFiles += page.attachmentHrefs.length
  })
  console.log(`\x1b[36m Attachment records: ${Object.keys(attachmentsByPage).length} pages, ${totalFiles} files \x1b[0m`)
}

const init = async () => {
  console.log('\x1b[33m Sorting files... \x1b[0m')
  sortFiles()
  console.log('\x1b[32m Files sorted \x1b[0m')
  console.log('\x1b[33m Creating shelves... \x1b[0m')
  await createShelves()
  console.log('\x1b[32m Shelves created! \x1b[0m')
  console.log('\x1b[33m Creating books... \x1b[0m')
  await createBooks()
  console.log('\x1b[32m Books created! \x1b[0m')
  console.log('\x1b[33m Putting Books on Shelves... \x1b[0m')
  await putBooksOnShelves()
  console.log('\x1b[32m Books are on the shelves! \x1b[0m')
  console.log('\x1b[33m Creating chapters... \x1b[0m')
  
  setTimeout(async () => {
    await createChapters()
    console.log('\x1b[32m Chapters Created! \x1b[0m')
    console.log('\x1b[33m Creating Standalone Pages... \x1b[0m')
    await createPages(sortedFiles.pagesBelongBook)
    console.log('\x1b[32m Standalone Pages Created! \x1b[0m')
    console.log('\x1b[33m Creating Pages in Chapters... \x1b[0m')
    await createPages(sortedFiles.pagesBelongChapter)
    console.log('\x1b[32m Pages in Chapters Created! \x1b[0m')
    await handleRetry()

    handleAttachments()

    displayResultsAndTrey()
  }, 1000)
}

process.argv.forEach(function (val, index, array) {
  if (index === 4 && !!val) {
    subDirectory = val
  }

  if (index === 5 && !!val) {
    timeoutBetweenPages = parseFloat(val)
  }
});

if (process.argv[3] === 'import') {
  if (subDirectory) {
    init()
  } else {
    console.log('Please include an argument for subdirectory')
  }
}

if (process.argv[3] === 'sort') {
  sortFiles()
}
if (process.argv[3] === 'attachments') {
  handleAttachments()
}
if (process.argv[3] === 'fixLinks') {
  fixLinks()
}

// Exported function for web interface
export async function runImport(folder: string, reporter?: any): Promise<{ shelves: number; books: number; chapters: number; pages: number }> {
  subDirectory = folder;
  currentReporter = reporter;
  currentPhase = 'import';

  // Reset all module-level state for fresh import
  shelves = [];
  books = [];
  chapters = [];
  chapterGeneralPages = [];
  attachmentsByPage = {};
  pageCreatedCount = 0;
  chapterCreatedCount = 0;
  bookCreatedCount = 0;
  pagesNotCreated = [];
  chaptersNotCreated = [];
  booksNotCreated = [];
  sortedFiles.shelves = [];
  sortedFiles.books = [];
  sortedFiles.chapterFilenames = [];
  sortedFiles.chapters = {};
  sortedFiles.pages = [];
  sortedFiles.pagesBelongChapter = [];
  sortedFiles.pagesBelongBook = [];
  retry.chapters = [];
  retry.chapterGeneralPages = [];
  retry.pages = [];

  const log = (phase: string, message: string, level: string = 'info') => {
    if (reporter) {
      reporter.log(phase, message, level);
    } else {
      console.log(message);
    }
  };

  return new Promise((resolve) => {
    // Stage 1: Analyze
    if (reporter) {
      reporter.start({ phase: 'analyze', message: 'Analyzing export structure...' });
    }
    log('analyze', 'Scanning HTML files...', 'info');
    sortFiles();

    // Verbose logging of discovered content
    const totalPages = sortedFiles.pages.length;
    const totalChapters = Object.keys(sortedFiles.chapters).length;
    const standalonePages = sortedFiles.pagesBelongBook.length;
    const chapterPages = sortedFiles.pagesBelongChapter.length;

    log('analyze', `Discovered content structure:`, 'info');
    log('analyze', `  • ${sortedFiles.shelves.length} shelves (spaces)`, 'info');
    log('analyze', `  • ${sortedFiles.books.length} books`, 'info');
    log('analyze', `  • ${totalChapters} chapters`, 'info');
    log('analyze', `  • ${standalonePages} standalone pages`, 'info');
    log('analyze', `  • ${chapterPages} chapter pages`, 'info');
    log('analyze', `  • ${totalPages} total pages`, 'info');

    if (reporter) {
      reporter.complete({ phase: 'analyze', message: 'Analysis complete' });
    }

    const runImportSteps = async () => {
      // Stage 2: Shelves
      currentPhase = 'shelves';
      if (reporter) {
        reporter.start({ phase: 'shelves', message: `Creating ${sortedFiles.shelves.length} shelves...` });
        reporter.progress({ phase: 'shelves', message: 'Creating shelves...', current: 0, total: sortedFiles.shelves.length, counters: { shelves: 0, books: 0, chapters: 0, pages: 0 } });
      }
      await createShelves();
      log('shelves', `✓ Created ${shelves.length} shelves`, 'success');
      if (reporter) {
        reporter.complete({ phase: 'shelves', message: `Created ${shelves.length} shelves`, counters: { shelves: shelves.length, books: 0, chapters: 0, pages: 0 } });
      }

      // Stage 3: Books
      currentPhase = 'books';
      if (reporter) {
        reporter.start({ phase: 'books', message: `Creating ${sortedFiles.books.length} books...` });
        reporter.progress({ phase: 'books', message: 'Creating books...', current: 0, total: sortedFiles.books.length });
      }
      await createBooks();
      log('books', `✓ Created ${bookCreatedCount} books`, 'success');

      if (reporter) reporter.progress({ phase: 'books', message: 'Organizing books on shelves...' });
      await putBooksOnShelves();
      log('books', '✓ Books organized on shelves', 'success');
      if (reporter) {
        reporter.complete({ phase: 'books', message: `Created ${bookCreatedCount} books`, counters: { shelves: shelves.length, books: bookCreatedCount, chapters: 0, pages: 0 } });
      }

      // Stage 4: Chapters
      currentPhase = 'chapters';
      if (reporter) {
        reporter.start({ phase: 'chapters', message: `Creating ${totalChapters} chapters...` });
        reporter.progress({ phase: 'chapters', message: 'Creating chapters...', current: 0, total: totalChapters });
      }
      await createChapters();
      log('chapters', `✓ Created ${chapterCreatedCount} chapters`, 'success');
      if (reporter) {
        reporter.complete({ phase: 'chapters', message: `Created ${chapterCreatedCount} chapters`, counters: { shelves: shelves.length, books: bookCreatedCount, chapters: chapterCreatedCount, pages: 0 } });
      }

      // Stage 5: Pages
      currentPhase = 'pages';
      if (reporter) {
        reporter.start({ phase: 'pages', message: `Creating ${totalPages} pages...` });
      }

      // Standalone pages
      if (standalonePages > 0) {
        log('pages', `Creating ${standalonePages} standalone pages...`, 'info');
        if (reporter) reporter.progress({ phase: 'pages', message: `Creating standalone pages (0/${standalonePages})...`, current: 0, total: totalPages });
        await createPages(sortedFiles.pagesBelongBook);
        log('pages', `✓ Created ${standalonePages} standalone pages`, 'success');
      }

      // Chapter pages
      if (chapterPages > 0) {
        log('pages', `Creating ${chapterPages} chapter pages...`, 'info');
        if (reporter) reporter.progress({ phase: 'pages', message: `Creating chapter pages (0/${chapterPages})...`, current: standalonePages, total: totalPages });
        await createPages(sortedFiles.pagesBelongChapter);
        log('pages', `✓ Created ${chapterPages} chapter pages`, 'success');
      }

      log('pages', `✓ Total pages created: ${pageCreatedCount}`, 'success');
      if (reporter) {
        reporter.complete({ phase: 'pages', message: `Created ${pageCreatedCount} pages`, counters: { shelves: shelves.length, books: bookCreatedCount, chapters: chapterCreatedCount, pages: pageCreatedCount } });
      }

      await handleRetry();
      handleAttachments();

      resolve({
        shelves: shelves.length,
        books: bookCreatedCount,
        chapters: chapterCreatedCount,
        pages: pageCreatedCount,
      });
    };

    setTimeout(runImportSteps, 1000);
  });
}