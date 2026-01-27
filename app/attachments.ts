require('dotenv').config();
const fs = require( 'fs' );
const path = require('path');
const { AxiosAdapter } = require('../axiosAdapter.js');

const fileDirectory = process.env.PATH_TO_HTML
let subDirectory
let notAttached = []

// Dynamic loader for attachment records (avoids Node.js module caching issues)
function loadAttachmentRecords(): { [key: string]: any } {
  const filePath = path.resolve(__dirname, '../outputJS/attachmentsFile.js');
  // Clear the require cache to get fresh data
  delete require.cache[require.resolve(filePath)];
  const { attachmentRecords } = require(filePath);
  return attachmentRecords;
}

const getFilePath = (filename) => {
  return `${fileDirectory}/${subDirectory}/${filename}`
}

const credentials = {
  "url": process.env.URL,
  "id": process.env.ID,
  "secret": process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const run = async () => {
  const attachmentRecords = loadAttachmentRecords();
  const attachments = attachmentRecords[subDirectory]
  const keys = Object.keys(attachments)
  let uploadParamCollection = []

  let skippedNoPage = 0

  keys.forEach((key) => {
    const obj = attachments[key]

    // Skip attachments for pages that weren't created in BookStack
    if (!obj.pageNewId) {
      skippedNoPage += obj.attachmentHrefs.length
      return
    }

    obj.attachmentHrefs.forEach(v => {
      const filePath = getFilePath(v.href)
      // Check if file exists before adding to queue
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath)
        // Skip files larger than 50MB
        if (stats.size > 50 * 1024 * 1024) {
          console.log(`\x1b[33m Skipping large file (${Math.round(stats.size / 1024 / 1024)}MB): ${v.name} \x1b[0m`)
          return
        }
        uploadParamCollection.push({
          uploaded_to: obj.pageNewId,
          name: v.name,
          filePath: filePath
        })
      } else {
        console.log(`\x1b[31m File not found: ${filePath} \x1b[0m`)
      }
    })
  })

  if (skippedNoPage > 0) {
    console.log(`\x1b[33m Skipped ${skippedNoPage} attachments (pages not imported to BookStack) \x1b[0m`)
  }

  console.log(`\x1b[36m Starting upload of ${uploadParamCollection.length} attachments... \x1b[0m`)

  let successCount = 0
  let errorCount = 0

  // Upload sequentially with delay to avoid rate limiting
  for (let i = 0; i < uploadParamCollection.length; i++) {
    const params = uploadParamCollection[i]
    try {
      const fileStream = fs.createReadStream(params.filePath)
      const resp = await axios.createAttachment({
        uploaded_to: params.uploaded_to,
        name: params.name,
        file: fileStream
      })
      successCount++
      console.log(`\x1b[32m [${successCount}/${uploadParamCollection.length}] ${params.name} \x1b[0m`)

      // Small delay between uploads to avoid rate limiting
      await sleep(100)
    } catch (err: any) {
      errorCount++
      const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error'
      console.log(`\x1b[31m [ERROR] ${params.name}: ${errMsg} \x1b[0m`)
      notAttached.push({ name: params.name, error: errMsg })
    }
  }

  console.log('\n------------------------------------------------')
  console.log(`\x1b[32m Successfully uploaded: ${successCount} \x1b[0m`)
  console.log(`\x1b[31m Failed: ${errorCount} \x1b[0m`)
  if (notAttached.length > 0) {
    console.log('\nFailed attachments:')
    notAttached.forEach(item => console.log(`  - ${item.name}: ${item.error}`))
  }
  return
}

process.argv.forEach(function (val, index, array) {
  console.log(val)
  if (index === 4 && !!val) {
    subDirectory = val
  }
});

if (process.argv[3] === 'attach') {
  run()
}

// Exported function for web interface
export async function runAttachments(folder: string, reporter?: any): Promise<{ uploaded: number; failed: number }> {
  subDirectory = folder;
  notAttached = [];

  const attachmentRecords = loadAttachmentRecords();
  const attachments = attachmentRecords[subDirectory];

  if (!attachments) {
    if (reporter) {
      reporter.warning({ phase: 'attachments', message: 'No attachment records found for this folder' });
    }
    return { uploaded: 0, failed: 0 };
  }

  const keys = Object.keys(attachments);
  let uploadParamCollection = [];
  let skippedNoPage = 0;

  keys.forEach((key) => {
    const obj = attachments[key];

    if (!obj.pageNewId) {
      skippedNoPage += obj.attachmentHrefs.length;
      return;
    }

    obj.attachmentHrefs.forEach(v => {
      const filePath = getFilePath(v.href);
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 50 * 1024 * 1024) {
          if (reporter) reporter.warning({ phase: 'attachments', message: `Skipping large file: ${v.name}` });
          return;
        }
        uploadParamCollection.push({
          uploaded_to: obj.pageNewId,
          name: v.name,
          filePath: filePath
        });
      }
    });
  });

  if (skippedNoPage > 0 && reporter) {
    reporter.warning({ phase: 'attachments', message: `Skipped ${skippedNoPage} attachments (pages not imported)` });
  }

  if (reporter) {
    reporter.progress({ phase: 'attachments', message: `Uploading ${uploadParamCollection.length} attachments...`, current: 0, total: uploadParamCollection.length });
  }

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < uploadParamCollection.length; i++) {
    const params = uploadParamCollection[i];
    try {
      const fileStream = fs.createReadStream(params.filePath);
      await axios.createAttachment({
        uploaded_to: params.uploaded_to,
        name: params.name,
        file: fileStream
      });
      successCount++;

      if (reporter && (i % 10 === 0 || i === uploadParamCollection.length - 1)) {
        reporter.progress({
          phase: 'attachments',
          message: `Uploaded ${params.name}`,
          current: i + 1,
          total: uploadParamCollection.length
        });
      }

      await sleep(100);
    } catch (err: any) {
      errorCount++;
      const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
      if (reporter) reporter.warning({ phase: 'attachments', message: `Failed: ${params.name} - ${errMsg}` });
      notAttached.push({ name: params.name, error: errMsg });
    }
  }

  if (reporter) {
    reporter.complete({
      phase: 'attachments',
      message: `Attachments complete: ${successCount} uploaded, ${errorCount} failed`,
      counters: { attachments: successCount }
    });
  }

  return { uploaded: successCount, failed: errorCount };
}