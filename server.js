require('dotenv').config()

const express = require('express')
const cors = require('cors')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { Server } = require('socket.io')
const healthRoutes = require('./routes/health')
const authRoutes = require('./routes/auth')
const contactsRoutes = require('./routes/contacts')
const routesRoutes = require('./routes/routes')
const incidentsRoutes = require('./routes/incidents')
const journeysRoutes = require('./routes/journeys')
const emergenciesRoutes = require('./routes/emergencies')
const safeCirclesRoutes = require('./routes/safeCircles')

const app = express()
const port = process.env.PORT || 5000
const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:5173'
const usersFile = path.join(__dirname, 'data', 'users.json')
const journeysFile = path.join(__dirname, 'data', 'journeys.json')
const sharesFile = path.join(__dirname, 'data', 'journeyShares.json')
const contactsFile = path.join(__dirname, 'data', 'contacts.json')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function findUser(userId) {
  return readJson(usersFile).find((user) => user.id === userId)
}

function isKnownSocketIdentity(userId) {
  return Boolean(findUser(userId) || readJson(contactsFile).some((contact) => contact.id === userId))
}

function findActiveJourney(journeyId, userId) {
  return readJson(journeysFile).find((journey) => journey.id === journeyId && journey.userId === userId && journey.status === 'ACTIVE')
}

function hasActiveShare(journeyId, userId) {
  return readJson(sharesFile).some((share) => share.journeyId === journeyId && share.trustedContactUserId === userId && share.status === 'ACTIVE')
}

function findActiveCircle(circleId) {
  return readJson(path.join(__dirname, 'data', 'safeCircles.json')).find((circle) => circle.id === circleId && circle.status === 'ACTIVE' && new Date(circle.expiresAt).getTime() > Date.now())
}

app.use(cors())
app.use(express.json())
app.use('/api', healthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/contacts', contactsRoutes)
app.use('/api/routes', routesRoutes)
app.use('/api/incidents', incidentsRoutes)
app.use('/api/journeys', journeysRoutes)
app.use('/api/emergencies', emergenciesRoutes)
app.use('/api/safe-circles', safeCirclesRoutes)

const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: { origin: frontendOrigin, methods: ['GET', 'POST'] },
})
app.set('io', io)

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`)

  socket.on('identify_user', ({ userId } = {}) => {
    if (typeof userId === 'string' && userId.trim() && isKnownSocketIdentity(userId.trim())) {
      socket.data.userId = userId.trim()
      console.log(`Socket identified: ${socket.id} (${socket.data.userId})`)
    } else {
      socket.emit('journey_error', { message: 'User could not be identified' })
    }
  })

  socket.on('join_journey', ({ journeyId } = {}) => {
    if (typeof journeyId !== 'string' || !journeyId.trim()) return
    if (!socket.data.userId || !findActiveJourney(journeyId.trim(), socket.data.userId)) {
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

  socket.on('join_monitoring', ({ journeyId } = {}) => {
    if (typeof journeyId !== 'string' || !journeyId.trim() || !socket.data.userId || !hasActiveShare(journeyId.trim(), socket.data.userId)) {
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

  socket.on('location_update', ({ journeyId, userId, latitude, longitude, accuracy, timestamp } = {}) => {
    const coordinatesAreValid = typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    if (!coordinatesAreValid || typeof journeyId !== 'string' || typeof userId !== 'string' || userId !== socket.data.userId || !findUser(userId) || !findActiveJourney(journeyId, userId) || !socket.rooms.has(`journey:${journeyId}`)) {
      socket.emit('journey_error', { message: 'Location update was not authorized' })
      return
    }
    const location = { journeyId, userId, latitude, longitude, accuracy: typeof accuracy === 'number' ? accuracy : null, timestamp: typeof timestamp === 'number' ? timestamp : Date.now() }
    socket.to(`journey:${journeyId}`).emit('location_updated', location)
    socket.emit('location_updated', location)
  })

  socket.on('join_circle', ({ circleId } = {}) => {
    const circle = findActiveCircle(circleId)
    const members = readJson(path.join(__dirname, 'data', 'safeCircleMembers.json'))
    if (!socket.data.userId || !circle || !members.some((member) => member.circleId === circleId && member.userId === socket.data.userId && member.status === 'ACTIVE')) {
      socket.emit('circle_error', { message: 'You are not an active member of this circle' })
      return
    }
    const room = `circle:${circleId}`
    socket.join(room)
    socket.data.circleRoom = room
    socket.emit('circle_joined', { circleId, room })
  })

  socket.on('circle_location_update', ({ circleId, userId, latitude, longitude, accuracy, timestamp } = {}) => {
    const members = readJson(path.join(__dirname, 'data', 'safeCircleMembers.json'))
    const validCoordinates = [latitude, longitude].every((value) => typeof value === 'number' && Number.isFinite(value)) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    if (!validCoordinates || userId !== socket.data.userId || !members.some((member) => member.circleId === circleId && member.userId === userId && member.status === 'ACTIVE') || !socket.rooms.has(`circle:${circleId}`)) {
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

  socket.on('circle_member_joined', ({ circleId, userId } = {}) => {
    const members = readJson(path.join(__dirname, 'data', 'safeCircleMembers.json'))
    if (circleId && userId === socket.data.userId && members.some((member) => member.circleId === circleId && member.userId === userId && member.status === 'ACTIVE') && socket.rooms.has(`circle:${circleId}`)) {
      socket.to(`circle:${circleId}`).emit('circle_member_joined', { circleId, userId })
    }
  })

  socket.on('circle_member_left', ({ circleId, userId } = {}) => {
    if (circleId && userId === socket.data.userId) socket.to(`circle:${circleId}`).emit('circle_member_left', { circleId, userId })
  })

  socket.on('end_circle', ({ circleId } = {}) => {
    const circles = readJson(path.join(__dirname, 'data', 'safeCircles.json'))
    const circle = circles.find((candidate) => candidate.id === circleId && candidate.creatorId === socket.data.userId && candidate.status === 'ACTIVE')
    if (!circle) return socket.emit('circle_error', { message: 'Only the circle creator can end this circle' })
    circle.status = 'ENDED'
    fs.writeFileSync(path.join(__dirname, 'data', 'safeCircles.json'), `${JSON.stringify(circles, null, 2)}\n`)
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

httpServer.listen(port, () => {
  console.log(`Women's Safety API listening on port ${port}`)
})
