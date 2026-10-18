require('dotenv').config()

const crypto = require('crypto')
const assert = require('node:assert/strict')
const { after, before, test } = require('node:test')
const request = require('supertest')
const { app } = require('../server')
const { connectToDatabase, getDb, closeDatabase } = require('../config/db')

const email = `integration-${crypto.randomUUID()}@example.test`
let user
let token
let databaseError

before(async () => {
  try {
    await connectToDatabase()
  } catch (error) {
    databaseError = error
  }
})

after(async () => {
  if (!user) return
  const db = getDb()
  await Promise.all([
    db.collection('users').deleteOne({ id: user.id }),
    db.collection('sessions').deleteMany({ userId: user.id }),
    db.collection('contacts').deleteMany({ userId: user.id }),
    db.collection('journeys').deleteMany({ userId: user.id }),
    db.collection('emergencies').deleteMany({ userId: user.id }),
    db.collection('safeCircles').deleteMany({ creatorId: user.id }),
    db.collection('safeCircleMembers').deleteMany({ userId: user.id }),
  ])
  await closeDatabase()
})

function skipIfUnavailable(t) {
  if (databaseError) t.skip(`MongoDB unavailable: ${databaseError.message}`)
}

test('authentication creates a server session and rejects invalid credentials', async (t) => {
  skipIfUnavailable(t)
  const registration = await request(app).post('/api/auth/register').send({
    name: 'Integration User',
    email,
    password: 'integration-password',
    phone: '5550100',
  })
  assert.equal(registration.status, 201)
  user = registration.body.user

  const invalid = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password' })
  assert.equal(invalid.status, 401)

  const login = await request(app).post('/api/auth/login').send({ email, password: 'integration-password' })
  assert.equal(login.status, 200)
  assert.equal(typeof login.body.token, 'string')
  token = login.body.token

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)
  assert.equal(me.status, 200)
  assert.equal(me.body.user.id, user.id)
})

test('contacts require the session owner and persist through read-back', async (t) => {
  skipIfUnavailable(t)
  if (!token) t.skip('authentication setup did not complete')
  const unauthorized = await request(app).post('/api/contacts').send({ name: 'No Auth', phone: '1', relationship: 'Test' })
  assert.equal(unauthorized.status, 401)

  const created = await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({
    name: 'Trusted Contact',
    phone: '5550101',
    relationship: 'Friend',
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.contact.userId, user.id)

  const listed = await request(app).get(`/api/contacts/${user.id}`).set('Authorization', `Bearer ${token}`)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.contacts.length, 1)
  assert.equal(listed.body.contacts[0].name, 'Trusted Contact')
})

test('journeys persist, list only the session owner, and can be stopped', async (t) => {
  skipIfUnavailable(t)
  if (!token) t.skip('authentication setup did not complete')
  const payload = {
    origin: { latitude: 22.5, longitude: 88.3, displayName: 'Origin' },
    destination: { latitude: 22.6, longitude: 88.4, displayName: 'Destination' },
    selectedRoute: { routeId: 'route-1', coordinates: [[22.5, 88.3], [22.6, 88.4]], distance: 1000, duration: 600, riskScore: 10, riskLevel: 'LOW' },
    startTime: new Date().toISOString(),
    status: 'ACTIVE',
    riskScore: 10,
  }
  const created = await request(app).post('/api/journeys').set('Authorization', `Bearer ${token}`).send(payload)
  assert.equal(created.status, 201)
  const journeyId = created.body.journey.id

  const listed = await request(app).get('/api/journeys').set('Authorization', `Bearer ${token}`)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.journeys.some((journey) => journey.id === journeyId), true)

  const stopped = await request(app).patch(`/api/journeys/${journeyId}/stop`).set('Authorization', `Bearer ${token}`)
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.journey.status, 'COMPLETED')
})

test('SOS and Safe Circle flows require authentication and persist data', async (t) => {
  skipIfUnavailable(t)
  if (!token) t.skip('authentication setup did not complete')
  const unauthorized = await request(app).post('/api/emergencies').send({ latitude: 22.5, longitude: 88.3 })
  assert.equal(unauthorized.status, 401)

  const emergency = await request(app).post('/api/emergencies').set('Authorization', `Bearer ${token}`).send({ latitude: 22.5, longitude: 88.3 })
  assert.equal(emergency.status, 201)

  const circle = await request(app).post('/api/safe-circles').set('Authorization', `Bearer ${token}`).send({ name: 'Integration Circle', latitude: 22.5, longitude: 88.3 })
  assert.equal(circle.status, 201)
  const nearby = await request(app).get('/api/safe-circles/nearby?latitude=22.5&longitude=88.3').set('Authorization', `Bearer ${token}`)
  assert.equal(nearby.status, 200)
  assert.equal(nearby.body.circles.some((item) => item.id === circle.body.circle.id), true)
})
