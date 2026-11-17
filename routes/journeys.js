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

const ONE_HOUR_SECONDS = 3600

function getJourneyEstimatedDurationSeconds(journey) {
  const duration = Number(journey?.selectedRoute?.trafficDuration || journey?.selectedRoute?.duration || journey?.estimatedDurationSeconds)
  if (Number.isFinite(duration) && duration > 0) {
    return Math.round(duration)
  }
  return 1800 // default fallback 30m if route missing
}

function getJourneyTimeLimitSeconds(journey) {
  if (typeof journey?.timeLimitSeconds === 'number' && Number.isFinite(journey.timeLimitSeconds) && journey.timeLimitSeconds > 0) {
    return journey.timeLimitSeconds
  }
  if (typeof journey?.timeLimitMinutes === 'number' && Number.isFinite(journey.timeLimitMinutes) && journey.timeLimitMinutes > 0) {
    return journey.timeLimitMinutes * 60
  }
  // Formula: estimated time + 1 hour
  const estimatedSec = getJourneyEstimatedDurationSeconds(journey)
  return estimatedSec + ONE_HOUR_SECONDS
}

function getJourneyExpiresAt(journey) {
  if (journey?.expiresAt) {
    const parsed = new Date(journey.expiresAt)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const startMs = new Date(journey?.startTime || journey?.createdAt || Date.now()).getTime()
  const limitSeconds = getJourneyTimeLimitSeconds(journey)
  return new Date(startMs + limitSeconds * 1000)
}

function isJourneyExpired(journey) {
  if (!journey || journey.status !== 'ACTIVE') return false
  return getJourneyExpiresAt(journey) <= new Date()
}

async function expireJourney(journey, io) {
  const now = new Date()
  const estimatedDurationSeconds = getJourneyEstimatedDurationSeconds(journey)
  const timeLimitSeconds = getJourneyTimeLimitSeconds(journey)
  const timeLimitMinutes = Math.ceil(timeLimitSeconds / 60)
  const expiresAt = getJourneyExpiresAt(journey).toISOString()

  await journeysCollection().updateOne(
    { id: journey.id, status: 'ACTIVE' },
    {
      $set: {
        status: 'COMPLETED',
        completedAt: now.toISOString(),
        completionReason: 'TIME_LIMIT_EXCEEDED',
        estimatedDurationSeconds,
        timeLimitSeconds,
        timeLimitMinutes,
        expiresAt,
      },
    },
  )

  await sharesCollection().updateMany(
    { journeyId: journey.id, status: 'ACTIVE' },
    { $set: { status: 'EXPIRED', expiredAt: now.toISOString() } },
  )

  await recordAudit({
    journeyId: journey.id,
    ownerUserId: journey.userId,
    actorUserId: 'SYSTEM',
    shareId: null,
    action: 'AUTO_STOPPED_TIME_LIMIT_EXCEEDED',
    permissions: defaultPermissions,
  })

  if (io) {
    const room = `journey:${journey.id}`
    io.to(room).emit('journey_completed', {
      journeyId: journey.id,
      reason: 'TIME_LIMIT_EXCEEDED',
      message: 'This journey exceeded its estimated time + 1hr limit and was stopped automatically.',
    })
    io.to('admin:live-journeys').emit('admin_journey_removed', { journeyId: journey.id })
    io.to('admin:notifications').emit('admin_notification', {
      id: `journey-autostop-${journey.id}`,
      type: 'journey',
      title: 'Journey time limit reached',
      message: `Journey for user ${journey.userId} was automatically stopped after exceeding estimated time + 1hr (${timeLimitMinutes} min limit).`,
      severity: 'LOW',
      createdAt: now,
    })
    const sockets = await io.in(room).fetchSockets()
    sockets.filter((socket) => socket.data.isMonitor).forEach((socket) => socket.disconnect(true))
  }

  return {
    ...journey,
    status: 'COMPLETED',
    completedAt: now.toISOString(),
    completionReason: 'TIME_LIMIT_EXCEEDED',
    estimatedDurationSeconds,
    timeLimitSeconds,
    timeLimitMinutes,
    expiresAt,
  }
}

async function autoExpireJourneys(db, io) {
  if (!db) return []
  const activeJourneys = await db.collection('journeys').find({ status: 'ACTIVE' }).toArray()
  const expired = []
  for (const journey of activeJourneys) {
    if (isJourneyExpired(journey)) {
      const updated = await expireJourney(journey, io)
      expired.push(updated)
    }
  }
  return expired
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

  // Auto-expire any outdated open journey for this user so they are not blocked
  const userOpenJourneys = await journeysCollection().find(
    { userId, status: { $in: ['PLANNED', 'ACTIVE'] } },
  ).toArray()
  for (const candidate of userOpenJourneys) {
    if (isJourneyExpired(candidate)) {
      await expireJourney(candidate, req.app.get('io'))
    }
  }

  const openJourney = await journeysCollection().findOne(
    { userId, status: { $in: ['PLANNED', 'ACTIVE'] } },
    { projection: { _id: 0, id: 1, status: 1 } },
  )
  if (openJourney) {
    return res.status(409).json({
      success: false,
      message: 'You already have an open journey. Stop it before planning another journey.',
      journey: openJourney,
    })
  }

  // Strictly: estimated time + 1 hour (3600 seconds)
  const estimatedDurationSeconds = Math.max(
    60,
    Math.round(selectedRoute?.trafficDuration || selectedRoute?.duration || 1800),
  )
  const timeLimitSeconds = estimatedDurationSeconds + ONE_HOUR_SECONDS
  const timeLimitMinutes = Math.ceil(timeLimitSeconds / 60)
  const effectiveStartTime = startTime ? new Date(startTime).toISOString() : new Date().toISOString()
  const expiresAt = new Date(new Date(effectiveStartTime).getTime() + timeLimitSeconds * 1000).toISOString()

  const journey = {
    id: crypto.randomUUID(),
    userId,
    origin,
    destination,
    selectedRoute,
    startTime: effectiveStartTime,
    estimatedDurationSeconds,
    timeLimitSeconds,
    timeLimitMinutes,
    expiresAt,
    status,
    riskScore,
  }
  try {
    await journeysCollection().insertOne(journey)
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'You already have an open journey. Stop it before planning another journey.' })
    }
    throw error
  }
  const io = req.app.get('io')
  if (io) {
    io.to('admin:live-journeys').emit('admin_journey_added', { journeyId: journey.id })
    io.to('admin:notifications').emit('admin_notification', {
      id: `journey-started-${journey.id}`,
      type: 'journey',
      title: 'Journey started',
      message: `A new live journey (estimated travel time + 1hr limit: ${timeLimitMinutes} min) was started by ${req.user.name || req.user.id}.`,
      severity: 'MEDIUM',
      createdAt: effectiveStartTime,
    })
  }
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
  if (!journey) return res.json({ success: true, journey: null })
  if (isJourneyExpired(journey)) {
    await expireJourney(journey, req.app.get('io'))
    return res.json({ success: true, journey: null, expired: true })
  }
  return res.json({ success: true, journey })
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
  if (!journey) return res.json({ success: true, journey: null })
  if (isJourneyExpired(journey)) {
    await expireJourney(journey, req.app.get('io'))
    return res.json({ success: true, journey: null, expired: true })
  }
  return res.json({ success: true, journey })
})

router.patch('/:id/extend', async (req, res) => {
  const journey = await journeysCollection().findOne({ id: req.params.id, userId: req.user.id, status: 'ACTIVE' })
  if (!journey) return res.status(404).json({ success: false, message: 'Active journey not found' })

  const extraMinutes = Math.max(5, Math.min(180, Number(req.body.extraMinutes) || 15))
  const currentLimit = getJourneyTimeLimitMinutes(journey)
  const newLimit = currentLimit + extraMinutes
  const startMs = new Date(journey.startTime || journey.createdAt || Date.now()).getTime()
  const newExpiresAt = new Date(startMs + newLimit * 60 * 1000).toISOString()

  await journeysCollection().updateOne(
    { id: journey.id },
    {
      $set: {
        timeLimitMinutes: newLimit,
        expiresAt: newExpiresAt,
      },
    },
  )

  const updatedJourney = {
    ...journey,
    timeLimitMinutes: newLimit,
    expiresAt: newExpiresAt,
  }

  const io = req.app.get('io')
  if (io) {
    const room = `journey:${journey.id}`
    io.to(room).emit('journey_extended', {
      journeyId: journey.id,
      timeLimitMinutes: newLimit,
      expiresAt: newExpiresAt,
      extraMinutes,
    })

    router.patch('/:id/check-in', async (req, res) => {
      const response = req.body?.response
      if (!['YES', 'NO'].includes(response)) return res.status(400).json({ success: false, message: 'Response must be YES or NO' })
      const journey = await journeysCollection().findOne({ id: req.params.id, userId: req.user.id, status: 'ACTIVE' }, { projection: { _id: 0, id: 1, latestCheckIn: 1 } })
      if (!journey?.latestCheckIn || journey.latestCheckIn.respondedAt) return res.status(404).json({ success: false, message: 'No check-in is awaiting a response' })
      const respondedAt = new Date().toISOString()
      await journeysCollection().updateOne({ id: journey.id }, { $set: { 'latestCheckIn.respondedAt': respondedAt, 'latestCheckIn.response': response } })
      req.app.get('io')?.to('admin:notifications').emit('admin_notification', {
        id: `journey-check-in-${journey.id}-${respondedAt}`,
        type: 'journey',
        title: response === 'YES' ? 'Journey check-in confirmed' : 'Journey needs assistance',
        message: response === 'YES' ? 'The user confirmed they have reached the destination.' : 'The user has not reached the destination yet.',
        severity: response === 'YES' ? 'LOW' : 'HIGH',
        createdAt: respondedAt,
      })
      return res.json({ success: true, response, respondedAt })
    })
  }

  const { _id, ...journeyResponse } = updatedJourney
  return res.json({ success: true, journey: journeyResponse, message: `Journey extended by ${extraMinutes} minutes` })
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
    io.to('admin:live-journeys').emit('admin_journey_removed', { journeyId: journey.id })
    io.to('admin:notifications').emit('admin_notification', {
      id: `journey-stopped-${journey.id}`,
      type: 'journey',
      title: 'Journey ended',
      message: `A live journey was ended by ${req.user.name || req.user.id}.`,
      severity: 'LOW',
      createdAt: new Date(),
    })
    const sockets = await io.in(room).fetchSockets()
    sockets.filter((socket) => socket.data.isMonitor).forEach((socket) => socket.disconnect(true))
  }

  const { _id, ...journeyResponse } = journey
  journeyResponse.status = 'COMPLETED'
  return res.json({ success: true, journey: journeyResponse })
})

router.autoExpireJourneys = autoExpireJourneys

module.exports = router