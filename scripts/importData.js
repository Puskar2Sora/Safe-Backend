// Run with: node scripts/importData.js  (from the backend/ folder)
//
// Reads every *.json file in backend/data/ and loads it into an Atlas collection
// of the same name (incidents.json -> "incidents" collection, journeys.json ->
// "journeys" collection, and so on). Safe to re-run: each collection is cleared
// right before its file's contents are inserted, so running this twice doesn't
// create duplicates - it just re-syncs Atlas to whatever is currently in your
// local JSON files.

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const { connectToDatabase } = require('../config/db')

const dataDir = path.join(__dirname, '..', 'data')

async function importAll() {
  const db = await connectToDatabase()
  const files = fs.readdirSync(dataDir).filter((file) => file.endsWith('.json'))

  if (!files.length) {
    console.log(`No .json files found in ${dataDir}`)
    process.exit(0)
  }

  console.log(`Found ${files.length} file(s) in ${dataDir}:\n`)

  for (const file of files) {
    const collectionName = path.basename(file, '.json')
    const filePath = path.join(dataDir, file)

    let documents
    try {
      documents = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
      console.error(`  ${file}: SKIPPED - invalid JSON (${error.message})`)
      continue
    }

    if (!Array.isArray(documents)) {
      console.error(`  ${file}: SKIPPED - expected a top-level JSON array, got ${typeof documents}`)
      continue
    }

    if (documents.length === 0) {
      console.log(`  ${collectionName}: source file is empty, nothing to import`)
      continue
    }

    const collection = db.collection(collectionName)
    // Clear whatever's currently in this collection first, so re-running the
    // script syncs Atlas to the file's current contents instead of duplicating.
    await collection.deleteMany({})
    const result = await collection.insertMany(documents)
    console.log(`  ${collectionName}: imported ${result.insertedCount} document(s)`)
  }

  console.log('\nDone. Your existing "id" fields (e.g. incident.id, journey.id) are')
  console.log('preserved as regular fields - Mongo additionally assigns its own _id')
  console.log('to every document, which your existing route code does not need to')
  console.log('use unless you choose to switch lookups over to it later.')

  process.exit(0)
}

importAll().catch((error) => {
  console.error('\nImport failed:', error.message)
  process.exit(1)
})