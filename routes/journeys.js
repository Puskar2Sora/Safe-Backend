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
function auditCollection() {
  return getDb().collection('journeyAccessAudit')
}

const permissions = ['LOCATION', 'ROUTE', 'STATUS']
const defaultPermissions = ['LOCATION', 'ROUTE', 'STATUS']

function isExpired(share) {
  return Boolean(share.expiresAt && new Date(share.expiresAt) <= new Date())
}

async function expireShare(share) {
  if (!isExpired(share)) return false
  await sharesCollection().updateOne({ id: share.id, status: 'ACTIVE' }, { $set: { status: 'EXPIRED', expiredAt: new Date().toISOString() } })
  await auditCollection().insertOne({
    id: crypto.randomUUID(),
    journeyId: share.journeyId,
    ownerUserId: share.ownerUserId,
    actorUserId: share.trustedContactUserId,
    shareId: share.id,
    action: 'EXPIRED',
    createdAt: new Date().toISOString(),
  })
  return true
}

async function activeShare(query) {
  const share = await sharesCollection().findOne({ ...query, status: 'ACTIVE' }, { projection: { _id: 0 } })
  if (!share) return null
  if (await expireShare(share)) return null
  return share
}

async function recordAudit({ journeyId, ownerUserId, actorUserId, shareId, action, permissions: grantedPermissions }) {
  await auditCollection().insertOne({
    id: crypto.randomUUID(),
    journeyId,
    ownerUserId,
    actorUserId,
    shareId,
    action,
    permissions: grantedPermissions,
    createdAt: new Date().toISOString(),
  })
}

router.post('/', async (req, res) => {
  const { origin, destination, selectedRoute, startTime, status = 'ACTIVE', riskScore } = req.body
  const userId = req.user.id

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

router.get('/', async (req, res) => {
  const journeys = await journeysCollection()
    .find({ userId: req.user.id }, { projection: { _id: 0 } })
    .sort({ startTime: -1 })
    .toArray()
  return res.json({ success: true, journeys })
})

router.get('/:userId/active/:journeyId', async (req, res) => {
  if (req.params.userId !== req.user.id) return res.status(403).json({ success: false, message: 'You are not authorized to access this journey' })
  const journey = await journeysCollection().findOne(
    { userId: req.params.userId, id: req.params.journeyId, status: 'ACTIVE' },
    { projection: { _id: 0 } },
  )
  return res.json({ success: true, journey: journey || null })
})

router.post('/:journeyId/share', async (req, res) => {
  const { trustedContactUserIds, expiresAt, accessPermissions = defaultPermissions } = req.body
  const ownerUserId = req.user.id
  const journey = await journeysCollection().findOne({ id: req.params.journeyId, userId: ownerUserId, status: 'ACTIVE' })
  if (!journey) return res.status(403).json({ success: false, message: 'Only the active journey owner can share this journey' })
  if (!Array.isArray(trustedContactUserIds) || trustedContactUserIds.length === 0) {
    return res.status(400).json({ success: false, message: 'Select at least one trusted contact' })
  }
  if (!Array.isArray(accessPermissions) || accessPermissions.length === 0 || accessPermissions.some((permission) => !permissions.includes(permission))) {
    return res.status(400).json({ success: false, message: `Permissions must be selected from ${permissions.join(', ')}` })
  }
  const expiry = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 24 * 60 * 60 * 1000)
  if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
    return res.status(400).json({ success: false, message: 'Access expiry must be a valid future date' })
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
        permissions: [...new Set(accessPermissions)],
        createdAt: new Date().toISOString(),
        expiresAt: expiry.toISOString(),
      }
    })

  if (!newShares.length) return res.status(400).json({ success: false, message: 'Selected contacts are invalid' })

  await sharesCollection().insertMany(newShares)
  await Promise.all(newShares.map((share) => recordAudit({
    journeyId: journey.id,
    ownerUserId,
    actorUserId: ownerUserId,
    shareId: share.id,
    action: 'GRANTED',
    permissions: share.permissions,
  })))
  const sharesResponse = newShares.map(({ _id, ...share }) => share)
  return res.status(201).json({ success: true, shares: sharesResponse })
})

router.get('/:journeyId/shares', async (req, res) => {
  const requesterUserId = req.user.id
  const journey = await journeysCollection().findOne({ id: req.params.journeyId }, { projection: { _id: 0 } })
  const shares = await sharesCollection().find({ journeyId: req.params.journeyId, status: 'ACTIVE' }, { projection: { _id: 0 } }).toArray()
  await Promise.all(shares.map(expireShare))
  const activeShares = shares.filter((share) => !isExpired(share))

  if (!journey || (requesterUserId !== journey.userId && !activeShares.some((share) => share.trustedContactUserId === requesterUserId))) {
    return res.status(403).json({ success: false, message: 'You are not authorized to view these shares' })
  }
  if (requesterUserId !== journey.userId) return res.json({ success: true, shares: activeShares.filter((share) => share.trustedContactUserId === requesterUserId) })
  return res.json({ success: true, shares: activeShares })
})

router.delete('/:journeyId/share/:shareId', async (req, res) => {
  const ownerUserId = req.user.id
  const journey = await journeysCollection().findOne({ id: req.params.journeyId, userId: ownerUserId })
  if (!journey) return res.status(403).json({ success: false, message: 'Only the journey owner can revoke sharing' })

  const share = await sharesCollection().findOne({ id: req.params.shareId, journeyId: journey.id })
  if (!share) return res.status(404).json({ success: false, message: 'Journey share not found' })

  await sharesCollection().updateOne({ id: share.id }, { $set: { status: 'REVOKED' } })
  await recordAudit({ journeyId: journey.id, ownerUserId, actorUserId: ownerUserId, shareId: share.id, action: 'REVOKED', permissions: share.permissions || defaultPermissions })
  const { _id, ...shareResponse } = share
  shareResponse.status = 'REVOKED'
  return res.json({ success: true, share: shareResponse })
})

router.get('/:journeyId/monitor', async (req, res) => {
  const requesterUserId = req.user.id
  const journey = await journeysCollection().findOne({ id: req.params.journeyId, status: 'ACTIVE' }, { projection: { _id: 0 } })
  const share = await activeShare({ journeyId: req.params.journeyId, trustedContactUserId: requesterUserId })
  if (!journey || !share) return res.status(403).json({ success: false, message: 'This journey has not been shared with you' })
  await recordAudit({ journeyId: journey.id, ownerUserId: journey.userId, actorUserId: requesterUserId, shareId: share.id, action: 'VIEWED', permissions: share.permissions || defaultPermissions })
  const grantedPermissions = share.permissions || defaultPermissions
  const sharedJourney = { ...journey }
  if (!grantedPermissions.includes('LOCATION')) {
    delete sharedJourney.origin
    delete sharedJourney.destination
  }
  if (!grantedPermissions.includes('ROUTE')) delete sharedJourney.selectedRoute
  if (!grantedPermissions.includes('STATUS')) delete sharedJourney.status
  return res.json({ success: true, journey: sharedJourney, share })
})

router.get('/:journeyId/access-audit', async (req, res) => {
  const journey = await journeysCollection().findOne({ id: req.params.journeyId, userId: req.user.id })
  if (!journey) return res.status(403).json({ success: false, message: 'Only the journey owner can view access audit logs' })
  const audit = await auditCollection().find({ journeyId: journey.id }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray()
  return res.json({ success: true, audit })
})

router.get('/:userId/active', async (req, res) => {
  if (req.params.userId !== req.user.id) return res.status(403).json({ success: false, message: 'You are not authorized to access this journey' })
  const journey = await journeysCollection().findOne({ userId: req.params.userId, status: 'ACTIVE' }, { projection: { _id: 0 } })
  return res.json({ success: true, journey: journey || null })
})

router.patch('/:id/stop', async (req, res) => {
  const journey = await journeysCollection().findOne({ id: req.params.id, userId: req.user.id })
  if (!journey) return res.status(404).json({ success: false, message: 'Journey not found' })

  await journeysCollection().updateOne({ id: journey.id }, { $set: { status: 'COMPLETED' } })
  await sharesCollection().updateMany(
    { journeyId: journey.id, status: 'ACTIVE' },
    { $set: { status: 'EXPIRED', expiresAt: new Date().toISOString() } },
  )
  await recordAudit({ journeyId: journey.id, ownerUserId: journey.userId, actorUserId: journey.userId, shareId: null, action: 'JOURNEY_COMPLETED', permissions: defaultPermissions })

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