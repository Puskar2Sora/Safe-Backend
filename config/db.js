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
  const openJourneys = await db.collection('journeys')
    .find({ status: { $in: ['PLANNED', 'ACTIVE'] } }, { projection: { _id: 1, userId: 1 } })
    .sort({ startTime: -1 })
    .toArray()
  const retainedUsers = new Set()
  const duplicateIds = []
  for (const journey of openJourneys) {
    if (retainedUsers.has(journey.userId)) duplicateIds.push(journey._id)
    else retainedUsers.add(journey.userId)
  }
  if (duplicateIds.length) {
    await db.collection('journeys').updateMany(
      { _id: { $in: duplicateIds } },
      { $set: { status: 'COMPLETED', completedAt: new Date().toISOString(), completionReason: 'superseded_duplicate_open_journey' } },
    )
  }
  await db.collection('journeys').createIndex(
    { userId: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ['PLANNED', 'ACTIVE'] } } },
  )
  console.log('Connected to MongoDB Atlas')
  return db
}

function getDb() {
  if (!db) {
    throw new Error('Database not connected yet - call connectToDatabase() first')
  }
  return db
}

async function closeDatabase() {
  await client.close()
  db = undefined
}

module.exports = { connectToDatabase, getDb, closeDatabase }

