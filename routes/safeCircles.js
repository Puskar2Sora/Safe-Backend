const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')

const router = express.Router()
const earthRadius = 6371000
const circles = () => getDb().collection('safeCircles')
const members = () => getDb().collection('safeCircleMembers')
const requests = () => getDb().collection('safeCircleRequests')

function distanceBetween(aLat, aLon, bLat, bLon) {
  const lat = (bLat - aLat) * Math.PI / 180
  const lon = (bLon - aLon) * Math.PI / 180
  const value = Math.sin(lat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(lon / 2) ** 2
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

async function expireCircles() {
  await circles().updateMany({ status: 'ACTIVE', expiresAt: { $lte: new Date() } }, { $set: { status: 'EXPIRED' } })
}

async function activeCircle(id) {
  await expireCircles()
  return circles().findOne({ id, status: 'ACTIVE', expiresAt: { $gt: new Date() } })
}

router.post('/', async (req, res) => {
  const { name, maxMembers = 5, expiresInMinutes = 60 } = req.body
  const latitude = Number(req.body.latitude)
  const longitude = Number(req.body.longitude)
  const memberLimit = Number(maxMembers)
  const expiryMinutes = Number(expiresInMinutes)
  if (!name?.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ success: false, message: 'Name and valid current location are required' })
  }
  if (!Number.isInteger(memberLimit) || memberLimit < 2 || memberLimit > 20 || !Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
    return res.status(400).json({ success: false, message: 'Circle limits are invalid' })
  }

  const now = new Date()
  const circle = { id: crypto.randomUUID(), creatorId: req.user.id, name: name.trim(), status: 'ACTIVE', maxMembers: memberLimit, createdAt: now, expiresAt: new Date(now.getTime() + expiryMinutes * 60000), latitude, longitude }
  await circles().insertOne(circle)
  await members().insertOne({ id: crypto.randomUUID(), circleId: circle.id, userId: req.user.id, status: 'ACTIVE', joinedAt: now, leftAt: null })
  const { _id, ...responseCircle } = circle
  return res.status(201).json({ success: true, circle: responseCircle })
})

router.get('/nearby', async (req, res) => {
  const latitude = Number(req.query.latitude)
  const longitude = Number(req.query.longitude)
  const radius = Number(req.query.radius || 5000)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ success: false, message: 'Current location is required' })
  await expireCircles()
  const active = await circles().find({ status: 'ACTIVE', expiresAt: { $gt: new Date() } }, { projection: { _id: 0 } }).toArray()
  const allMembers = await members().find({ status: 'ACTIVE' }, { projection: { _id: 0 } }).toArray()
  const allRequests = await requests().find({ status: 'PENDING' }, { projection: { _id: 0 } }).toArray()
  const result = active.map((circle) => {
    const circleMembers = allMembers.filter((member) => member.circleId === circle.id)
    const isMember = circleMembers.some((member) => member.userId === req.user.id)
    const isPending = allRequests.some((request) => request.circleId === circle.id && request.userId === req.user.id)
    return { id: circle.id, name: circle.name, status: circle.status, maxMembers: circle.maxMembers, memberCount: circleMembers.length, distanceMeters: Math.round(distanceBetween(latitude, longitude, circle.latitude, circle.longitude)), userStatus: isMember ? 'MEMBER' : isPending ? 'PENDING' : 'NONE' }
  }).filter((circle) => circle.distanceMeters <= radius)
  return res.json({ success: true, circles: result })
})

router.get('/:id', async (req, res) => {
  const circle = await activeCircle(req.params.id)
  const member = await members().findOne({ circleId: req.params.id, userId: req.user.id, status: 'ACTIVE' })
  if (!circle || !member) return res.status(403).json({ success: false, message: 'You are not an active member of this circle' })
  const circleMembers = await members().find({ circleId: circle.id, status: 'ACTIVE' }, { projection: { _id: 0, userId: 1, joinedAt: 1 } }).toArray()
  const { _id, ...responseCircle } = circle
  return res.json({ success: true, circle: { ...responseCircle, members: circleMembers } })
})

router.get('/:id/requests', async (req, res) => {
  const circle = await activeCircle(req.params.id)
  if (!circle || circle.creatorId !== req.user.id) return res.status(403).json({ success: false, message: 'Only the circle creator can view requests' })
  return res.json({ success: true, requests: await requests().find({ circleId: circle.id, status: 'PENDING' }, { projection: { _id: 0 } }).toArray() })
})

router.post('/:id/request', async (req, res) => {
  const circle = await activeCircle(req.params.id)
  if (!circle) return res.status(400).json({ success: false, message: 'Circle is expired or inactive' })
  if (await members().findOne({ circleId: circle.id, userId: req.user.id, status: 'ACTIVE' })) return res.status(409).json({ success: false, message: 'You are already a member' })
  if (await members().countDocuments({ circleId: circle.id, status: 'ACTIVE' }) >= circle.maxMembers) return res.status(409).json({ success: false, message: 'This circle is full' })
  if (await requests().findOne({ circleId: circle.id, userId: req.user.id, status: 'PENDING' })) return res.status(409).json({ success: false, message: 'Join request already sent' })
  const request = { id: crypto.randomUUID(), circleId: circle.id, userId: req.user.id, status: 'PENDING', createdAt: new Date() }
  await requests().insertOne(request)
  const { _id, ...responseRequest } = request
  return res.status(201).json({ success: true, message: 'Join request sent', request: responseRequest })
})

router.patch('/:id/requests/:requestId', async (req, res) => {
  const circle = await activeCircle(req.params.id)
  if (!circle || circle.creatorId !== req.user.id) return res.status(403).json({ success: false, message: 'Only the circle creator can decide requests' })
  const decision = req.body.decision
  const request = await requests().findOne({ id: req.params.requestId, circleId: circle.id, status: 'PENDING' })
  if (!request || !['ACCEPTED', 'REJECTED'].includes(decision)) return res.status(400).json({ success: false, message: 'Invalid join request' })
  if (decision === 'ACCEPTED') {
    if (await members().countDocuments({ circleId: circle.id, status: 'ACTIVE' }) >= circle.maxMembers) return res.status(409).json({ success: false, message: 'This circle is full' })
    await members().insertOne({ id: crypto.randomUUID(), circleId: circle.id, userId: request.userId, status: 'ACTIVE', joinedAt: new Date(), leftAt: null })
  }
  await requests().updateOne({ _id: request._id }, { $set: { status: decision } })
  return res.json({ success: true, request: { ...request, status: decision } })
})

router.post('/:id/leave', async (req, res) => {
  const result = await members().updateOne({ circleId: req.params.id, userId: req.user.id, status: 'ACTIVE' }, { $set: { status: 'LEFT', leftAt: new Date() } })
  if (!result.modifiedCount) return res.status(403).json({ success: false, message: 'You are not an active member' })
  return res.json({ success: true })
})

router.patch('/:id/end', async (req, res) => {
  const result = await circles().findOneAndUpdate({ id: req.params.id, creatorId: req.user.id, status: 'ACTIVE' }, { $set: { status: 'ENDED' } }, { returnDocument: 'after', projection: { _id: 0 } })
  if (!result) return res.status(403).json({ success: false, message: 'Only the circle creator can end it' })
  return res.json({ success: true, circle: result })
})

module.exports = router
