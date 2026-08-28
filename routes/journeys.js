const crypto = require('crypto')
const express = require('express')
const fs = require('fs')
const path = require('path')
const usersFile = path.join(__dirname, '..', 'data', 'users.json')

const router = express.Router()
const journeysFile = path.join(__dirname, '..', 'data', 'journeys.json')
const sharesFile = path.join(__dirname, '..', 'data', 'journeyShares.json')
const statuses = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED']

function readJourneys() {
  return JSON.parse(fs.readFileSync(journeysFile, 'utf8'))
}

function saveJourneys(journeys) {
  fs.writeFileSync(journeysFile, `${JSON.stringify(journeys, null, 2)}\n`)
}

function readShares() {
  return JSON.parse(fs.readFileSync(sharesFile, 'utf8'))
}

function saveShares(shares) {
  fs.writeFileSync(sharesFile, `${JSON.stringify(shares, null, 2)}\n`)
}

function readUsers() {
  return JSON.parse(fs.readFileSync(usersFile, 'utf8'))
}

router.post('/', (req, res) => {
  const { userId, origin, destination, selectedRoute, startTime, status = 'ACTIVE', riskScore } = req.body

  if (!userId || !origin || !destination || !selectedRoute || !startTime || riskScore === undefined) {
    return res.status(400).json({ success: false, message: 'User, origin, destination, selected route, start time, and risk score are required' })
  }
  if (!statuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid journey status' })
  }
  const journey = { id: crypto.randomUUID(), userId, origin, destination, selectedRoute, startTime, status, riskScore }
  const journeys = readJourneys()
  journeys.push(journey)
  saveJourneys(journeys)
  return res.status(201).json({ success: true, journey })
})

router.get('/:userId/active/:journeyId', (req, res) => {
  const journey = readJourneys().find((candidate) => candidate.userId === req.params.userId && candidate.id === req.params.journeyId && candidate.status === 'ACTIVE')
  return res.json({ success: true, journey: journey || null })
})

router.post('/:journeyId/share', (req, res) => {
  const { ownerUserId, trustedContactUserIds, expiresAt } = req.body
  const journey = readJourneys().find((candidate) => candidate.id === req.params.journeyId && candidate.userId === ownerUserId && candidate.status === 'ACTIVE')
  if (!journey) return res.status(403).json({ success: false, message: 'Only the active journey owner can share this journey' })
  if (!Array.isArray(trustedContactUserIds) || trustedContactUserIds.length === 0) return res.status(400).json({ success: false, message: 'Select at least one trusted contact' })

  const contacts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'contacts.json'), 'utf8'))
  const ownerContacts = contacts.filter((contact) => contact.userId === ownerUserId)
  const users = readUsers()
  const newShares = trustedContactUserIds.filter((contactId) => ownerContacts.some((contact) => contact.id === contactId)).map((contactId) => {
    const contact = ownerContacts.find((candidate) => candidate.id === contactId)
    const linkedUser = users.find((user) => user.phone === contact.phone)
    return {
    id: crypto.randomUUID(),
    journeyId: journey.id,
    ownerUserId,
    trustedContactUserId: contact.trustedContactUserId || linkedUser?.id || contact.id,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    }
  })
  if (!newShares.length) return res.status(400).json({ success: false, message: 'Selected contacts are invalid' })
  const shares = readShares()
  shares.push(...newShares)
  saveShares(shares)
  return res.status(201).json({ success: true, shares: newShares })
})

router.get('/:journeyId/shares', (req, res) => {
  const requesterUserId = req.query.userId
  const journey = readJourneys().find((candidate) => candidate.id === req.params.journeyId)
  const shares = readShares().filter((share) => share.journeyId === req.params.journeyId && share.status === 'ACTIVE')
  if (!journey || (requesterUserId !== journey.userId && !shares.some((share) => share.trustedContactUserId === requesterUserId))) {
    return res.status(403).json({ success: false, message: 'You are not authorized to view these shares' })
  }
  return res.json({ success: true, shares })
})

router.delete('/:journeyId/share/:shareId', (req, res) => {
  const { ownerUserId } = req.body
  const journey = readJourneys().find((candidate) => candidate.id === req.params.journeyId && candidate.userId === ownerUserId)
  if (!journey) return res.status(403).json({ success: false, message: 'Only the journey owner can revoke sharing' })
  const shares = readShares()
  const share = shares.find((candidate) => candidate.id === req.params.shareId && candidate.journeyId === journey.id)
  if (!share) return res.status(404).json({ success: false, message: 'Journey share not found' })
  share.status = 'REVOKED'
  saveShares(shares)
  return res.json({ success: true, share })
})

router.get('/:journeyId/monitor', (req, res) => {
  const requesterUserId = req.query.userId
  const journey = readJourneys().find((candidate) => candidate.id === req.params.journeyId && candidate.status === 'ACTIVE')
  const share = readShares().find((candidate) => candidate.journeyId === req.params.journeyId && candidate.trustedContactUserId === requesterUserId && candidate.status === 'ACTIVE')
  if (!journey || !share) return res.status(403).json({ success: false, message: 'This journey has not been shared with you' })
  return res.json({ success: true, journey, share })
})

router.get('/:userId/active', (req, res) => {
  const journey = readJourneys().find((candidate) => candidate.userId === req.params.userId && candidate.status === 'ACTIVE')
  return res.json({ success: true, journey: journey || null })
})

router.patch('/:id/stop', async (req, res) => {
  const journeys = readJourneys()
  const journey = journeys.find((candidate) => candidate.id === req.params.id)
  if (!journey) return res.status(404).json({ success: false, message: 'Journey not found' })

  journey.status = 'COMPLETED'
  saveJourneys(journeys)
  const shares = readShares().map((share) => share.journeyId === journey.id && share.status === 'ACTIVE' ? { ...share, status: 'EXPIRED', expiresAt: new Date().toISOString() } : share)
  saveShares(shares)
  const io = req.app.get('io')
  if (io) {
    const room = `journey:${journey.id}`
    io.to(room).emit('journey_completed', { journeyId: journey.id })
    const sockets = await io.in(room).fetchSockets()
    sockets.filter((socket) => socket.data.isMonitor).forEach((socket) => socket.disconnect(true))
  }
  return res.json({ success: true, journey })
})

module.exports = router