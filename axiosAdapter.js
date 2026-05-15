const Axios = require('axios');
const axiosRetry = require('axios-retry').default;
const qs = require('qs');

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

class AxiosAdapter {
  constructor(baseURL, id, secret) {
    const instance = Axios.create({
      baseURL,
      paramsSerializer: {
        serialize: (params) =>
          qs.stringify(params, { arrayFormat: 'comma' })
      }
    })

    axiosRetry(instance, {
      retries: 7,
      retryDelay: (retryCount) => {
        console.log(`Retry attempt: ${retryCount}`);
        return retryCount * 2000; // time interval between retries
      },
      retryCondition: (error) => {
        if (error.response) {
          // if retry condition is not specified, by default idempotent requests are retried
          return error.response.status === 500 || error.response.status === 404;
        }
        return false
      },
    });

    this.baseURL = baseURL
    this.id = id
    this.secret = secret
    this.client = instance
  }

  getHeaders = (contentType = 'application/x-www-form-urlencoded') => {
    const headers = {
      'Content-Type': contentType,
      'Authorization': `Token ${this.id}:${this.secret}`
    }

    return headers

  }

  get = (url, params) =>
    this.client.get(url, {
      headers: this.getHeaders(),
      params,
    })

  put = (url, id, data) =>
    this.client.put(`${url}/${id}`, JSON.stringify(data), {
      headers: this.getHeaders('application/json')
    })

  delete = (url, id) =>
    this.client.delete(`${url}/${id}`, {
      headers: this.getHeaders()
    })

  postJson = (url, data) =>
    this.client.post(url, JSON.stringify(data), {
      headers: this.getHeaders('application/json')
    })

  postMFD = (url, data) =>
    this.client.post(url, data, {
      headers: this.getHeaders('multipart/form-data')
    })

  createShelf = async (body) => {
    return this.postJson('/shelves', body)
  }

  createBook = async (body) => {
    return this.postJson('/books', body)
  }

  createChapter = async (body) => {
    return this.postJson('/chapters', body)
  }

  createPage = async (body) => {
    return this.postJson('/pages', body)
  }

  createAttachment = async (body) => {
    return this.postMFD('/attachments', body)
  }

  createImageGallery = async (body) => {
    return this.postMFD('/image-gallery', body)
  }

  getBooks = async () => {
    return this.get('/books')
  }

  getShelves = async () => {
    return this.get('/shelves')
  }

  getPages = async () => {
    return this.get('/pages')
  }

  getChapters = async () => {
    return this.get('/chapters')
  }

  getShelf = async (id) => {
    return this.get(`/shelves/${id}`)
  }

  updateShelf = async (id, params) => {
    return this.put('/shelves', id, params)
  }

  deleteShelf = async (id) => {
    return this.delete('/shelves', id)
  }

  deleteBook = async (id) => {
    return this.delete('/books', id)
  }

  deletePage = async (id) => {
    return this.delete('/pages', id)
  }

  deleteChapter = async (id) => {
    return this.delete('/chapters', id)
  }

  async getAllShelves() {
    let allShelves = [];

    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await withRetry(
        () => this.get('/shelves', { offset, count: limit }),
        'getAllShelves'
      );

      const pages = response.data.data;
      allShelves = allShelves.concat(pages);

      if (pages.length < limit) break;
      offset += limit;
      await sleep(BASE_DELAY);
    }

    console.log(`Found ${allShelves.length} shelves in BookStack`);
    return allShelves;
  }

  async getAllAttachments() {
    let allAttachments = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await withRetry(
        () => this.get('/attachments', { offset, count: limit }),
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

  async getAllImageGallery() {
    let allImages = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await withRetry(
        () => this.get('/image-gallery', { offset, count: limit }),
        'getAllImageGallery'
      );

      const images = response.data.data;
      allImages = allImages.concat(images);

      if (images.length < limit) break;
      offset += limit;
      await sleep(BASE_DELAY);
    }

    console.log(`Found ${allImages.length} images in BookStack`);
    return allImages;
  }

  async getAllPagesByShelf(shelfId) {
    let allPages = [];

    if (shelfId) {
      // get all pages by shelfId
      const shelfRes = await this.get(`/shelves/${shelfId}`);

      const promises = await Promise.all(
        shelfRes.data.books.map(async book => {
          const response = await this.get('/pages', { filter: { book_id: book.id } });
          return response.data.data;
        })
      );

      for (let pages of promises)
        allPages = allPages.concat(pages);
    }

    console.log(`Found ${allPages.length} pages for shelf ${shelfId} in BookStack`);
    return allPages;
  }

  async getAllPages() {
    let allPages = [];

    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await withRetry(
        () => this.get('/pages', { offset, count: limit }),
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

  async getPageDetails(pageId) {
    const response = await withRetry(
      () => this.get(`/pages/${pageId}`),
      `getPage:${pageId}`
    );
    return response.data;
  }

  async getPageAttachments(pageId) {
    const response = await withRetry(
      () => this.get('/attachments', { filter: { uploaded_to: pageId } }),
      `getPageAttachments:${pageId}`
    );
    return response.data.data;
  }

  async getPageImageGallery(pageId) {
    const response = await withRetry(
      () => this.get('/image-gallery', { filter: { uploaded_to: pageId } }),
      `getPageImageGallery:${pageId}`
    );
    return response.data.data;
  }

  async updatePageHtml(pageId, html, name) {
    const response = await withRetry(
      () => this.put('/pages', pageId, { html, name }),
      `updatePage:${pageId}`
    );
    return response.data;
  }

  async clearRecycleBin() {
    console.log('clearing recycle bin');
    let bins;
    let deleted = 0;
    do {
      let res = await this.get('/recycle-bin', { count: 50 });
      bins = res.data.data;
      await Promise.all(bins.map(async bin => {
        let res = await this.delete('/recycle-bin', bin.id);
        deleted += res.data.delete_count;
      }))
    } while (bins.length);
    console.log(`cleared recycle bin: ${deleted}`);
  }
}

module.exports = { AxiosAdapter }