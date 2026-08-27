const crypto = require('crypto')
const express = require('express')
const fs = require('fs')
const path = require('path')

const router = express.Router()
const emergenciesFile = path.join(__dirname, '..', 'data', 'emergencies.json')

function readEmergencies() {
  return JSON.parse(fs.readFileSync(emergenciesFile, 'utf8'))
}

function saveEmergencies(emergencies) {
  fs.writeFileSync(emergenciesFile, `${JSON.stringify(emergencies, null, 2)}\n`)
}

router.post('/', (req, res) => {
  const { userId, latitude, longitude } = req.body

  if (!userId || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ success: false, message: 'User ID and current location are required' })
  }

  const emergency = {
    id: crypto.randomUUID(),
    userId,
    latitude,
    longitude,
    timestamp: new Date().toISOString(),
    status: 'ACTIVE',
  }
  const emergencies = readEmergencies()
  emergencies.push(emergency)
  saveEmergencies(emergencies)
  return res.status(201).json({ success: true, message: 'Emergency activated.', emergency })
})

module.exports = router