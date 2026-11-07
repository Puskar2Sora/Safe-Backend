const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')
const { getPlatformSettings } = require('../utils/platformSettings')

const router = express.Router()

router.post('/', async (req, res) => {
  const settings = await getPlatformSettings()
  if (!settings.emergencyAlertsEnabled) return res.status(503).json({ success: false, message: 'Emergency alerts are temporarily disabled by an administrator' })
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
  const io = req.app.get('io')
  if (io) {
    io.to('admin:notifications').emit('admin_notification', {
      id: emergency.id,
      type: 'sos',
      title: 'Active SOS alert',
      message: `Emergency activated by user ${req.user.name || req.user.id}`,
      severity: 'CRITICAL',
      createdAt: emergency.timestamp,
    })
  }
  const { _id, ...responseEmergency } = emergency
  return res.status(201).json({ success: true, message: 'Emergency activated.', emergency: responseEmergency })
})

router.get('/', async (req, res) => {
  const emergencies = await getDb().collection('emergencies').find({ userId: req.user.id }, { projection: { _id: 0 } }).sort({ timestamp: -1 }).toArray()
  return res.json({ success: true, emergencies })
})

module.exports = router
