require('dotenv').config()
const { AxiosAdapter } = require('./axiosAdapter.js');

const credentials = {
  "url": process.env.URL,
  "id": process.env.ID,
  "secret": process.env.SECRET
};

const axios = new AxiosAdapter(credentials.url, credentials.id, credentials.secret)

const clearRecycleBin = async () => {
  try {
    await axios.clearRecycleBin();
  } catch (err) {
    console.log('clearRecycleBin failed.', err)
  }
}

clearRecycleBin()