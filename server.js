require('dotenv').config()
const { connectToDatabase } = require('./config/db')
const express = require('express')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
const { getDb } = require('./config/db')
const healthRoutes = require('./routes/health')
const authRoutes = require('./routes/auth')
const contactsRoutes = require('./routes/contacts')
const routesRoutes = require('./routes/routes')
const incidentsRoutes = require('./routes/incidents')
const journeysRoutes = require('./routes/journeys')
const emergenciesRoutes = require('./routes/emergencies')
const safeCirclesRoutes = require('./routes/safeCircles')
const { authenticate, getUserFromToken } = require('./middleware/auth')

const app = express()
const port = process.env.PORT || 5000
const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:5173'
async function findActiveJourney(journeyId, userId) {
  return getDb().collection('journeys').findOne({ id: journeyId, userId, status: 'ACTIVE' })
}

async function hasActiveShare(journeyId, userId) {
  return getDb().collection('journeyShares').findOne({
    journeyId,
    trustedContactUserId: userId,
    status: 'ACTIVE',
    permissions: { $in: ['LOCATION'] },
    $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date().toISOString() } }],
  })
}

async function findActiveCircle(circleId) {
  return getDb().collection('safeCircles').findOne({ id: circleId, status: 'ACTIVE', expiresAt: { $gt: new Date() } })
}

app.use(cors())
app.use(express.json())
app.use('/api', healthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/contacts', authenticate, contactsRoutes)
app.use('/api/routes', authenticate, routesRoutes)
app.use('/api/incidents', authenticate, incidentsRoutes)
app.use('/api/journeys', authenticate, journeysRoutes)
app.use('/api/emergencies', authenticate, emergenciesRoutes)
app.use('/api/safe-circles', authenticate, safeCirclesRoutes)

const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: { origin: frontendOrigin, methods: ['GET', 'POST'] },
})
app.set('io', io)
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
    const authenticated = await getUserFromToken(token)
    if (!authenticated) return next(new Error('Authentication is required'))
    socket.data.user = authenticated.user
    socket.data.userId = authenticated.user.id
    return next()
  } catch (error) {
    return next(error)
  }
})

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`)

  socket.on('identify_user', () => {
    console.log(`Socket identified: ${socket.id} (${socket.data.userId})`)
  })

  socket.on('join_journey', async ({ journeyId } = {}) => {
    if (typeof journeyId !== 'string' || !journeyId.trim()) return
    if (!socket.data.userId || !(await findActiveJourney(journeyId.trim(), socket.data.userId))) {
      socket.emit('journey_error', { message: 'You are not authorized to join this journey' })
      return
    }
    const room = `journey:${journeyId.trim()}`
    socket.join(room)
    socket.data.journeyRoom = room
    const connectedUsers = io.sockets.adapter.rooms.get(room)?.size || 0
    socket.emit('journey_joined', { journeyId: journeyId.trim(), room, connectedUsers })
    socket.to(room).emit('user_connected', { journeyId: journeyId.trim(), userId: socket.data.userId, connectedUsers })
  })

  socket.on('join_monitoring', async ({ journeyId } = {}) => {
    if (typeof journeyId !== 'string' || !journeyId.trim() || !socket.data.userId || !(await hasActiveShare(journeyId.trim(), socket.data.userId))) {
      socket.emit('journey_error', { message: 'You are not authorized to monitor this journey' })
      return
    }
    const room = `journey:${journeyId.trim()}`
    socket.join(room)
    socket.data.isMonitor = true
    socket.data.journeyRoom = room
    const connectedUsers = io.sockets.adapter.rooms.get(room)?.size || 0
    socket.emit('journey_joined', { journeyId: journeyId.trim(), room, connectedUsers })
    socket.to(room).emit('user_connected', { journeyId: journeyId.trim(), userId: socket.data.userId, connectedUsers })
  })

  socket.on('location_update', async ({ journeyId, userId, latitude, longitude, accuracy, timestamp } = {}) => {
    const coordinatesAreValid = typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    if (!coordinatesAreValid || typeof journeyId !== 'string' || typeof userId !== 'string' || userId !== socket.data.userId || !(await findActiveJourney(journeyId, userId)) || !socket.rooms.has(`journey:${journeyId}`)) {
      socket.emit('journey_error', { message: 'Location update was not authorized' })
      return
    }
    const location = { journeyId, userId, latitude, longitude, accuracy: typeof accuracy === 'number' ? accuracy : null, timestamp: typeof timestamp === 'number' ? timestamp : Date.now() }
    socket.to(`journey:${journeyId}`).emit('location_updated', location)
    socket.emit('location_updated', location)
  })

  socket.on('join_circle', async ({ circleId } = {}) => {
    const circle = await findActiveCircle(circleId)
    const member = await getDb().collection('safeCircleMembers').findOne({ circleId, userId: socket.data.userId, status: 'ACTIVE' })
    if (!socket.data.userId || !circle || !member) {
      socket.emit('circle_error', { message: 'You are not an active member of this circle' })
      return
    }
    const room = `circle:${circleId}`
    socket.join(room)
    socket.data.circleRoom = room
    socket.emit('circle_joined', { circleId, room })
  })

  socket.on('circle_location_update', async ({ circleId, userId, latitude, longitude, accuracy, timestamp } = {}) => {
    const member = await getDb().collection('safeCircleMembers').findOne({ circleId, userId, status: 'ACTIVE' })
    const validCoordinates = [latitude, longitude].every((value) => typeof value === 'number' && Number.isFinite(value)) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    if (!validCoordinates || userId !== socket.data.userId || !member || !socket.rooms.has(`circle:${circleId}`)) {
      socket.emit('circle_error', { message: 'Circle location update was not authorized' })
      return
    }
    socket.to(`circle:${circleId}`).emit('circle_location_update', { circleId, userId, latitude: Number(latitude.toFixed(3)), longitude: Number(longitude.toFixed(3)), accuracy: typeof accuracy === 'number' ? accuracy : null, timestamp: typeof timestamp === 'number' ? timestamp : Date.now() })
  })

  socket.on('leave_circle', ({ circleId } = {}) => {
    const room = `circle:${circleId || socket.data.circleRoom?.replace('circle:', '') || ''}`
    if (socket.rooms.has(room)) socket.leave(room)
    socket.data.circleRoom = undefined
  })

  socket.on('circle_member_joined', async ({ circleId, userId } = {}) => {
    const member = await getDb().collection('safeCircleMembers').findOne({ circleId, userId, status: 'ACTIVE' })
    if (circleId && userId === socket.data.userId && member && socket.rooms.has(`circle:${circleId}`)) {
      socket.to(`circle:${circleId}`).emit('circle_member_joined', { circleId, userId })
    }
  })

  socket.on('circle_member_left', ({ circleId, userId } = {}) => {
    if (circleId && userId === socket.data.userId) socket.to(`circle:${circleId}`).emit('circle_member_left', { circleId, userId })
  })

  socket.on('end_circle', async ({ circleId } = {}) => {
    const circle = await getDb().collection('safeCircles').findOne({ id: circleId, creatorId: socket.data.userId, status: 'ACTIVE' })
    if (!circle) return socket.emit('circle_error', { message: 'Only the circle creator can end this circle' })
    await getDb().collection('safeCircles').updateOne({ _id: circle._id }, { $set: { status: 'ENDED' } })
    io.to(`circle:${circleId}`).emit('circle_ended', { circleId })
  })

  socket.on('leave_journey', ({ journeyId } = {}) => {
    const room = `journey:${journeyId || socket.data.journeyRoom?.replace('journey:', '') || ''}`
    if (!socket.rooms.has(room)) return
    socket.leave(room)
    socket.data.journeyRoom = undefined
    socket.to(room).emit('user_disconnected', { journeyId, userId: socket.data.userId, connectedUsers: io.sockets.adapter.rooms.get(room)?.size || 0 })
  })

  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (!room.startsWith('journey:')) continue
      socket.to(room).emit('user_disconnected', { journeyId: room.replace('journey:', ''), userId: socket.data.userId, connectedUsers: Math.max(0, (io.sockets.adapter.rooms.get(room)?.size || 1) - 1) })
    }
  })

  socket.on('disconnect', (reason) => console.log(`Socket disconnected: ${socket.id} (${reason})`))
})
async function start() {
  await connectToDatabase()
  httpServer.listen(port, () => {
    console.log(`Women's Safety API listening on port ${port}`)
  })
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start server:', error)
    process.exit(1)
  })
}

module.exports = { app, httpServer, io, start }
