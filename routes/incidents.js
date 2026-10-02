const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')
const { geocodeLocation } = require('../services/routingService')

const router = express.Router()
const categories = ['Harassment', 'Stalking', 'Theft', 'Suspicious Activity', 'Assault', 'Unsafe Road', 'Poor Lighting', 'Other']
const severities = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL']

function incidentsCollection() {
  return getDb().collection('incidents')
}

router.post('/', async (req, res) => {
  const { category, severity, description, location } = req.body

  if (![category, severity, description, location].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Category, severity, description, and location are required' })
  }
  if (!categories.includes(category) || !severities.includes(severity.toUpperCase())) {
    return res.status(400).json({ success: false, message: 'Invalid category or severity' })
  }

  try {
    const coordinates = await geocodeLocation(location.trim())
    const incident = {
      id: crypto.randomUUID(),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      category,
      severity: severity.toUpperCase(),
      description: description.trim(),
      location: coordinates.displayName,
      date: new Date().toISOString(),
    }

    await incidentsCollection().insertOne(incident)
    // insertOne mutates `incident` in place, adding Mongo's own _id - strip it
    // before responding so API consumers see the exact same shape as before.
    const { _id, ...incidentResponse } = incident
    return res.status(201).json({ success: true, incident: incidentResponse })
  } catch (error) {
    return res.status(502).json({ success: false, message: error instanceof Error ? error.message : 'Unable to locate the incident' })
  }
})

router.get('/', async (req, res) => {
  try {
    // Exclude Mongo's _id from the response - nothing downstream expects it,
    // and this keeps the payload identical to what the old file-based version sent.
    const incidents = await incidentsCollection().find({}, { projection: { _id: 0 } }).toArray()
    return res.json({ success: true, incidents })
  } catch (error) {
    return res.status(502).json({ success: false, message: 'Unable to load incidents' })
  }
})

module.exports = router