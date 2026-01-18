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
  let title = dom.window.document.getElementById('title-text')?.textContent || ''
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
  const files = fs.readdirSync(`${fileDirectory}/${subDirectory}`)
  const htmlFiles = files.filter(fn => fn.endsWith('.html'))
  
  const threeBreadcrumbsFilenames = []
  const branchesWithFourOrMore = []
  htmlFiles.forEach(filename => {
    const file = fs.readFileSync(getFilePath(filename), 'utf-8')
    const dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
    if (breadcrumbs) {
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
    }
  })

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
  const chapterFilenames = Object.keys(sortedFiles.chapters)
  console.log('DEBUG: Total books in array:', books.length)
  console.log('DEBUG: Book previousIds:', books.map(b => b.previousId))
  console.log('DEBUG: Chapter count:', chapterFilenames.length)

  const promises = chapterFilenames.map((chapterFilename, i) => {
    const file = fs.readFileSync(getFilePath(chapterFilename), 'utf-8')
    const dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
    const titleHeading = dom.window.document.getElementById('title-heading')
    const bookPreviousIdNeeded = sortedFiles.chapters[chapterFilename].bookPreviousId
    const parentBook = books.find(book => book.previousId === bookPreviousIdNeeded)

    if (!parentBook) {
      console.log('DEBUG: Missing parent book for chapter:', chapterFilename)
      console.log('DEBUG: Looking for bookPreviousId:', bookPreviousIdNeeded)
      console.log('DEBUG: sortedFiles.chapters entry:', JSON.stringify(sortedFiles.chapters[chapterFilename]))
    }

    const titleTextElement = dom.window.document.getElementById('title-text')
    let title = "generic title"
    if (titleTextElement) {
      title = dom.window.document.getElementById('title-text').textContent
    }
    titleHeading.remove()
    breadcrumbs.remove()
    const htmlString = dom.serialize()

    if (title.includes(" : ")) {
      title = title.split(' : ')[1]
    }

    const params = {
      name: title,
      book_id: parentBook.book
    }
    
    return new Promise(resolve => setTimeout(resolve, i * timeoutBetweenPages))
      .then(() => {
        return axios.createChapter(params)
          .then(resp => {
            const newChapterId = resp.data.id
            chapters.push({
              id: newChapterId,
              previousId: sortedFiles.chapters[chapterFilename].chapterPreviousId
            })
            sortedFiles.chapters[chapterFilename].pageFilenames.forEach(fn => {
              sortedFiles.pagesBelongChapter.push({
                chapterId: newChapterId,
                pageFilename: fn
              })
            })
            
            console.log(`\x1b[32m ${chapterFilename} \x1b[0m`)
            chapterCreatedCount++

            return newChapterId
          })
          .then(newChapterId => {
            const generalPageParams = {
              chapter_id: newChapterId,
              name: "_General",
              html: htmlString
            }
            return axios.createPage(generalPageParams)
              .then(resp => {
                const pageId = getIdFromFilename(chapterFilename)
                if (!attachmentsByPage[pageId]) {
                  attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: resp.data.id }
                } else {
                  attachmentsByPage[pageId].pageNewId = resp.data.id
                }
                chapterGeneralPages.push(chapterFilename)
              })
              .catch(err => {
                retry.chapterGeneralPages.push(generalPageParams)
              })
          })
          .catch(err => {
            console.log(err)
            chaptersNotCreated.push(chapterFilename)
            retry.chapters.push({
              chapterParams: params,
              generalHtml: htmlString
            })
            console.log(`\x1b[31m ${chapterFilename} \x1b[0m`)
          })
      })
  })

  const createdChapters = Promise.all(promises)
  return createdChapters
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
  // Build a set of shelf filenames for quick lookup
  const shelfFilenames = new Set(sortedFiles.shelves)

  const promises = sortedFiles.books.map((filename, i) => {
    const file = fs.readFileSync(getFilePath(filename), 'utf-8')
    const dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
    const breadcrumbLinkItems = breadcrumbs.getElementsByTagName('a')
    var arr = [...breadcrumbLinkItems];
    let parentShelf
    arr.forEach((item, i) => {
      const href = item.getAttribute('href')
      // Check if this breadcrumb points to a shelf file (either by 'Home_' pattern or by matching shelf filenames)
      if (href.includes('Home_') || shelfFilenames.has(href)) {
        parentShelf = shelves.find(shelf => shelf.previousId === getIdFromHref(item))
      }
    })

    if (!parentShelf) {
      console.log('DEBUG: No parent shelf found for book:', filename)
      console.log('DEBUG: Breadcrumbs:', arr.map(a => a.getAttribute('href')))
      console.log('DEBUG: Shelf filenames:', [...shelfFilenames])
      console.log('DEBUG: Shelves array:', shelves)
    }
    
    const titleTextElement = dom.window.document.getElementById('title-text')
    let title = "generic title"
    if (titleTextElement) {
      title = dom.window.document.getElementById('title-text').textContent
    }

    if (title.includes(" : ")) {
      title = title.split(' : ')[1]
    }

    replaceBreadcrumbsAndLinks(dom, breadcrumbs, filename)
    const htmlString = dom.serialize()

    let bookId
    return new Promise(resolve => setTimeout(resolve, i * timeoutBetweenPages))
      .then(() => {
        return axios.createBook({
          name: `${title}`,
        })
          .then(resp => {
            bookId = resp.data.id
            books.push({
              book: bookId,
              previousId: getIdFromFilename(filename), 
              shelf: parentShelf.id
            })
            bookCreatedCount++
            return axios.createPage({
              book_id: bookId,
              name: "_General",
              html: htmlString
            })
              .then(resp2 => {
                const pageId = getIdFromFilename(filename)
                if (!attachmentsByPage[pageId]) {
                  attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: resp2.data.id }
                } else {
                  attachmentsByPage[pageId].pageNewId = resp2.data.id
                }
                return resp2
              })
              .catch(err2 => {
                console.log(err2)
              })
          })
          .then(resp => {
            console.log(`\x1b[32m ${filename} \x1b[0m`)
            return resp.data
          })
          .catch(err => {
            console.log('createBook ERR:', err)
            console.log(`\x1b[31m ${filename} \x1b[0m`)
            booksNotCreated.push(filename)
          })
    })
  })
  const createdBooks = await Promise.all(promises)
  return createdBooks
}

const createShelves = async () => {
  const shelfPromises = sortedFiles.shelves.map((shelfFileName, i) => {
    const file = fs.readFileSync(getFilePath(shelfFileName), 'utf-8')
    const dom = new jsdom.JSDOM(file);
    const breadCrumbs = dom.window.document.getElementById('breadcrumbs')
    const titleHeading = dom.window.document.getElementById('title-heading')
    const breadcrumbsFirst = breadCrumbs.getElementsByClassName('first')
    breadCrumbs.remove()
    titleHeading.remove()
    const htmlString = dom.serialize()
    const title = breadcrumbsFirst[0].getElementsByTagName('a')[0].textContent

    let bookId
    return axios.createBook({
      name: `${title}: Home`
    })
      .then(resp => {
        bookId = resp.data.id
        return axios.createPage({
          book_id: bookId,
          name: "_General",
          html: htmlString
        })
          .then(resp => {
            const pageId = getIdFromFilename(shelfFileName)
            if (!attachmentsByPage[pageId]) {
              attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: resp.data.id }
            } else {
              attachmentsByPage[pageId].pageNewId = resp.data.id
            }
          })
          .catch(err => {
            console.log('book general page error')
          })
      })
      .then(resp => {
        return axios.createShelf({
          name: title,
          books: [bookId],
        })
      })
      .then(resp => {
        shelves.push({
          id: resp.data.id,
          previousId: getIdFromFilename(shelfFileName)
        })
        books.push({
          book: bookId,
          previousId: getIdFromFilename(shelfFileName), 
          shelf: resp.data.id
        })
        return resp.data
      })
      .catch(err => {
        console.log(err)
      })
  })
  const createdShelves = await Promise.all(shelfPromises)
  return createdShelves
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
  const promises = filenames.map((filename, i) => {
    const file = fs.readFileSync(getFilePath(filename), 'utf-8')
    let dom = new jsdom.JSDOM(file);
    const breadcrumbs = dom.window.document.getElementById('breadcrumbs')
    const breadcrumbLinkItems = breadcrumbs.getElementsByTagName('a')
    const titleHeading = dom.window.document.getElementById('title-heading')
    var arr = [...breadcrumbLinkItems];
    let parentBook
    arr.forEach((item, i) => {
      if (i === 2) {
        const parentBookPreviousId = getIdFromHref(item)
        parentBook = books.find(b => b.previousId === parentBookPreviousId)
      }
    })
    
    const titleTextElement = dom.window.document.getElementById('title-text')
    let title = "title not found"
    if (titleTextElement) {
      title = dom.window.document.getElementById('title-text').textContent
    }

    if (title.includes(" : ")) {
      title = title.split(' : ')[1]
    }
    
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
    return new Promise(resolve => setTimeout(resolve, i * timeoutBetweenPages))
      .then(() => {
        return axios.createPage(params)
         .then(resp => {
            console.log(`\x1b[32m ${filename} \x1b[0m`)
            const pageId = getIdFromFilename(filename)
            // Always register the BookStack page ID for attachment uploads
            if (!attachmentsByPage[pageId]) {
              attachmentsByPage[pageId] = { attachmentHrefs: [], pageNewId: resp.data.id }
            } else {
              attachmentsByPage[pageId].pageNewId = resp.data.id
            }
            pageCreatedCount++
         })
         .catch(err => {
            console.log(`\x1b[31m ${filename} \x1b[0m`)
            pagesNotCreated.push(filename)
            console.log(err)
         })
      })
  })

  const createdPages = Promise.all(promises)
  return createdPages
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