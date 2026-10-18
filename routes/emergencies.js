const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')

const router = express.Router()

router.post('/', async (req, res) => {
  const { latitude, longitude } = req.body
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ success: false, message: 'Valid current coordinates are required' })
  }

  const emergency = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    latitude,
    longitude,
    timestamp: new Date(),
    status: 'ACTIVE',
  }
  await getDb().collection('emergencies').insertOne(emergency)
  const { _id, ...responseEmergency } = emergency
  return res.status(201).json({ success: true, message: 'Emergency activated.', emergency: responseEmergency })
})

router.get('/', async (req, res) => {
  const emergencies = await getDb().collection('emergencies').find({ userId: req.user.id }, { projection: { _id: 0 } }).sort({ timestamp: -1 }).toArray()
  return res.json({ success: true, emergencies })
})

module.exports = router
