const crypto = require('crypto')
const express = require('express')
const fs = require('fs')
const path = require('path')
const { geocodeLocation } = require('../services/routingService')

const router = express.Router()
const incidentsFile = path.join(__dirname, '..', 'data', 'incidents.json')
const categories = ['Harassment', 'Stalking', 'Theft', 'Suspicious Activity', 'Assault', 'Unsafe Road', 'Poor Lighting', 'Other']
const severities = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL']

function readIncidents() {
  return JSON.parse(fs.readFileSync(incidentsFile, 'utf8'))
}

function saveIncidents(incidents) {
  fs.writeFileSync(incidentsFile, `${JSON.stringify(incidents, null, 2)}\n`)
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
    const incidents = readIncidents()
    incidents.push(incident)
    saveIncidents(incidents)
    return res.status(201).json({ success: true, incident })
  } catch (error) {
    return res.status(502).json({ success: false, message: error instanceof Error ? error.message : 'Unable to locate the incident' })
  }
})

router.get('/', (req, res) => res.json({ success: true, incidents: readIncidents() }))

module.exports = router