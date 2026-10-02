const { MongoClient, ServerApiVersion } = require('mongodb')

const uri = process.env.MONGODB_URI
if (!uri) {
  throw new Error('MONGODB_URI is not set in your .env file')
}

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
})

let db

async function connectToDatabase() {
  if (db) return db
  await client.connect()
  // The database name comes from the connection string's path, or defaults here
  // if you didn't put one in the URI (e.g. mongodb+srv://.../womens_safety).
  db = client.db(process.env.MONGODB_DB_NAME || 'womens_safety')
  console.log('Connected to MongoDB Atlas')
  return db
}

function getDb() {
  if (!db) {
    throw new Error('Database not connected yet - call connectToDatabase() first')
  }
  return db
}

module.exports = { connectToDatabase, getDb }