require('dotenv').config()
const { AxiosAdapter } = require('../axiosAdapter.js');

const credentials = {
  "url": process.env.URL,
  "id": process.env.ID,
  "secret": process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret)

const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

const deleteShelf = async (shelfId: number) => {
  const shelf = await axios.getShelf(shelfId)
    .then(resp => {
      return resp.data
    })
  const bookPromises = shelf.books.map(book => {
    return axios.deleteBook(book.id)
      .then(() => {
        return
      })
      .catch(err => {
        console.log('error deleting books')
      })
  })
  const shelfPromise = () => {
    return axios.deleteShelf(shelf.id)
      .then(() => {
        return
      })
      .catch((err) => {
        console.log('Error deleting shelf:', err)
      })
  }

  Promise.all([...bookPromises, shelfPromise()])
    .then(() => {
      console.log('Deleted shelf')
    })
    .catch(err => {
      console.log(err)
    })
}

const confirmDeletion = (shelfId: string, shelfName: string, bookCount: number): Promise<boolean> => {
  return new Promise((resolve) => {
    console.log('')
    console.log('\x1b[33m╔════════════════════════════════════════════════════════════╗\x1b[0m')
    console.log('\x1b[33m║  ⚠️  WARNING: This action cannot be undone!                 ║\x1b[0m')
    console.log('\x1b[33m╚════════════════════════════════════════════════════════════╝\x1b[0m')
    console.log('')
    console.log(`  You are about to delete:`)
    console.log(`    \x1b[36mShelf:\x1b[0m  ${shelfName}`)
    console.log(`    \x1b[36mBooks:\x1b[0m  ${bookCount} (and all their chapters/pages)`)
    console.log('')

    readline.question('\x1b[31mType the shelf name to confirm deletion:\x1b[0m ', (answer) => {
      if (answer === shelfName) {
        resolve(true)
      } else {
        console.log('\x1b[33mShelf name did not match. Deletion cancelled.\x1b[0m')
        resolve(false)
      }
    });
  });
}

const showShelvesToUser = async () => {
  console.log('Getting shelf IDs')
  let shelves: any[] = []

  await axios.getShelves()
    .then(resp => {
      shelves = resp.data.data
      shelves.forEach(shelf => {
        console.log(`${shelf.name} ID:\x1b[32m ${shelf.id}\x1b[0m`)
      })
    })
    .catch(err => {
      console.log(err)
    })

  readline.question('\nEnter shelf ID to delete (or press Enter to cancel): ', async (id) => {
    if (!id || id.trim() === '') {
      console.log('Cancelled.')
      readline.close()
      return
    }

    // Get shelf details for confirmation
    try {
      const shelfResp = await axios.getShelf(id)
      const shelf = shelfResp.data
      const bookCount = shelf.books?.length || 0

      const confirmed = await confirmDeletion(id, shelf.name, bookCount)

      if (confirmed) {
        console.log(`\n\x1b[31mDeleting "${shelf.name}"...\x1b[0m`);
        await deleteShelf(id)
      }
    } catch (err: any) {
      console.log(`\x1b[31mError: Could not find shelf with ID ${id}\x1b[0m`)
    }

    readline.close();
  });
}

const run = () => {
  showShelvesToUser()
}

if (process.argv[3] === 'deleteById') {
  run()
}