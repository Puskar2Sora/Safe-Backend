const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')

const router = express.Router()
const statuses = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED']

function journeysCollection() {
  return getDb().collection('journeys')
}
function sharesCollection() {
  return getDb().collection('journeyShares')
}
function usersCollection() {
  return getDb().collection('users')
}
function contactsCollection() {
  return getDb().collection('contacts')
}

router.post('/', async (req, res) => {
  const { userId, origin, destination, selectedRoute, startTime, status = 'ACTIVE', riskScore } = req.body

  if (!userId || !origin || !destination || !selectedRoute || !startTime || riskScore === undefined) {
    return res.status(400).json({ success: false, message: 'User, origin, destination, selected route, start time, and risk score are required' })
  }
  if (!statuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid journey status' })
  }

  const journey = { id: crypto.randomUUID(), userId, origin, destination, selectedRoute, startTime, status, riskScore }
  await journeysCollection().insertOne(journey)
  const { _id, ...journeyResponse } = journey
  return res.status(201).json({ success: true, journey: journeyResponse })
})

router.get('/:userId/active/:journeyId', async (req, res) => {
  const journey = await journeysCollection().findOne(
    { userId: req.params.userId, id: req.params.journeyId, status: 'ACTIVE' },
    { projection: { _id: 0 } },
  )
  return res.json({ success: true, journey: journey || null })
})

router.post('/:journeyId/share', async (req, res) => {
  const { ownerUserId, trustedContactUserIds, expiresAt } = req.body
  const journey = await journeysCollection().findOne({ id: req.params.journeyId, userId: ownerUserId, status: 'ACTIVE' })
  if (!journey) return res.status(403).json({ success: false, message: 'Only the active journey owner can share this journey' })
  if (!Array.isArray(trustedContactUserIds) || trustedContactUserIds.length === 0) {
    return res.status(400).json({ success: false, message: 'Select at least one trusted contact' })
  }

  const ownerContacts = await contactsCollection().find({ userId: ownerUserId }).toArray()
  const users = await usersCollection().find({}).toArray()

  const newShares = trustedContactUserIds
    .filter((contactId) => ownerContacts.some((contact) => contact.id === contactId))
    .map((contactId) => {
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

  await sharesCollection().insertMany(newShares)
  const sharesResponse = newShares.map(({ _id, ...share }) => share)
  return res.status(201).json({ success: true, shares: sharesResponse })
})

router.get('/:journeyId/shares', async (req, res) => {
  const requesterUserId = req.query.userId
  const journey = await journeysCollection().findOne({ id: req.params.journeyId }, { projection: { _id: 0 } })
  const shares = await sharesCollection()
    .find({ journeyId: req.params.journeyId, status: 'ACTIVE' }, { projection: { _id: 0 } })
    .toArray()

  if (!journey || (requesterUserId !== journey.userId && !shares.some((share) => share.trustedContactUserId === requesterUserId))) {
    return res.status(403).json({ success: false, message: 'You are not authorized to view these shares' })
  }
  return res.json({ success: true, shares })
})

router.delete('/:journeyId/share/:shareId', async (req, res) => {
  const { ownerUserId } = req.body
  const journey = await journeysCollection().findOne({ id: req.params.journeyId, userId: ownerUserId })
  if (!journey) return res.status(403).json({ success: false, message: 'Only the journey owner can revoke sharing' })

  const share = await sharesCollection().findOne({ id: req.params.shareId, journeyId: journey.id })
  if (!share) return res.status(404).json({ success: false, message: 'Journey share not found' })

  await sharesCollection().updateOne({ id: share.id }, { $set: { status: 'REVOKED' } })
  const { _id, ...shareResponse } = share
  shareResponse.status = 'REVOKED'
  return res.json({ success: true, share: shareResponse })
})

router.get('/:journeyId/monitor', async (req, res) => {
  const requesterUserId = req.query.userId
  const journey = await journeysCollection().findOne({ id: req.params.journeyId, status: 'ACTIVE' }, { projection: { _id: 0 } })
  const share = await sharesCollection().findOne(
    { journeyId: req.params.journeyId, trustedContactUserId: requesterUserId, status: 'ACTIVE' },
    { projection: { _id: 0 } },
  )
  if (!journey || !share) return res.status(403).json({ success: false, message: 'This journey has not been shared with you' })
  return res.json({ success: true, journey, share })
})

router.get('/:userId/active', async (req, res) => {
  const journey = await journeysCollection().findOne({ userId: req.params.userId, status: 'ACTIVE' }, { projection: { _id: 0 } })
  return res.json({ success: true, journey: journey || null })
})

router.patch('/:id/stop', async (req, res) => {
  const journey = await journeysCollection().findOne({ id: req.params.id })
  if (!journey) return res.status(404).json({ success: false, message: 'Journey not found' })

  await journeysCollection().updateOne({ id: journey.id }, { $set: { status: 'COMPLETED' } })
  await sharesCollection().updateMany(
    { journeyId: journey.id, status: 'ACTIVE' },
    { $set: { status: 'EXPIRED', expiresAt: new Date().toISOString() } },
  )

  const io = req.app.get('io')
  if (io) {
    const room = `journey:${journey.id}`
    io.to(room).emit('journey_completed', { journeyId: journey.id })
    const sockets = await io.in(room).fetchSockets()
    sockets.filter((socket) => socket.data.isMonitor).forEach((socket) => socket.disconnect(true))
  }

  const { _id, ...journeyResponse } = journey
  journeyResponse.status = 'COMPLETED'
  return res.json({ success: true, journey: journeyResponse })
})

module.exports = router