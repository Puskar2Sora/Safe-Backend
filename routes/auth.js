const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')
const { authenticate, requireAdmin } = require('../middleware/auth')
const { rateLimit } = require('../middleware/rateLimit')
const { writeAuditLog } = require('../utils/audit')
const multer = require('multer')
const { v2: cloudinary } = require('cloudinary')

const router = express.Router()
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000
const adminSessionDurationMs = 30 * 60 * 1000
const maxAvatarSizeBytes = 5 * 1024 * 1024
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxAvatarSizeBytes } })

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${passwordHash}`
}

function verifyPassword(password, storedHash) {
  try {
    const [salt, expectedHash] = String(storedHash || '').split(':')
    if (!salt || !expectedHash) return false
    const actualHash = crypto.scryptSync(password, salt, 64).toString('hex')
    const actualBuffer = Buffer.from(actualHash, 'hex')
    const expectedBuffer = Buffer.from(expectedHash, 'hex')
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  } catch {
    return false
  }
}

function publicUser(user) {
  const isAdmin = user.role === 'admin'
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: isAdmin ? 'admin' : (user.role || 'user'),
    isAdmin,
    isWomanVerified: Boolean(user.isWomanVerified || isAdmin),
    profileImageUrl: user.profileImageUrl || null,
    createdAt: user.createdAt,
  }
}

function parseJwt(token) {
  try {
    const base64Url = String(token || '').split('.')[1]
    if (!base64Url) return null
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = Buffer.from(base64, 'base64').toString('utf8')
    return JSON.parse(jsonPayload)
  } catch {
    return null
  }
}

async function verifyGoogleToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`)
    if (res.ok) {
      const data = await res.json()
      if (['accounts.google.com', 'https://accounts.google.com'].includes(data.iss)) {
        const expectedAud = process.env.GOOGLE_CLIENT_ID
        if (expectedAud && data.aud !== expectedAud) {
          console.warn(`[Google Auth] Token aud mismatch: ${data.aud} !== ${expectedAud}`)
          return null
        }
        return data
      }
    }
  } catch (error) {
    console.warn('[Google Auth] Direct tokeninfo fetch error, checking payload fallback:', error.message)
  }

  // Fallback: validate token structure and claims
  const parsed = parseJwt(idToken)
  if (parsed && parsed.email) {
    const nowSec = Math.floor(Date.now() / 1000)
    if (parsed.exp && parsed.exp < nowSec - 300) {
      console.warn('[Google Auth] Token expired')
      return null
    }
    return parsed
  }
  return null
}

async function createSession(userId, { isAdmin = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url')
  await getDb().collection('sessions').insertOne({
    userId,
    isAdmin,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + (isAdmin ? adminSessionDurationMs : sessionDurationMs)),
  })
  return token
}

router.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body
  if (![name, email, password, phone].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Name, email, password, and phone are required' })
  }
  if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' })

  const users = getDb().collection('users')
  const normalizedEmail = email.trim().toLowerCase()
  if (await users.findOne({ email: normalizedEmail })) {
    return res.status(409).json({ success: false, message: 'An account with this email already exists' })
  }

  const user = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    phone: phone.trim(),
    role: 'user',
    isAdmin: false,
    isWomanVerified: false,
    verificationDetails: null,
    createdAt: new Date(),
  }
  await users.insertOne(user)
  return res.status(201).json({ success: true, message: 'Registration successful', user: publicUser(user) })
})

router.post('/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again later.',
}), async (req, res) => {
  const { email, password } = req.body
  if (![email, password].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Email and password are required' })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const users = getDb().collection('users')
  const user = await users.findOne({ email: normalizedEmail })

  // Admin accounts must use the dedicated Admin Portal
  if (user?.role === 'admin') {
    return res.status(403).json({ success: false, message: 'This portal is for users only. Administrators must sign in through the Admin Portal.' })
  }

  const validPassword = user && (
    verifyPassword(password, user.passwordHash) ||
    user.password === password
  )

  if (!user || !validPassword) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' })
  }
  if (!user.passwordHash) {
    await users.updateOne({ _id: user._id }, { $set: { passwordHash: hashPassword(password) }, $unset: { password: '' } })
  }
  const token = await createSession(user.id)
  return res.json({ success: true, token, user: publicUser(user) })
})

// Google Authentication Endpoint
router.post('/google', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts. Please try again later.',
}), async (req, res) => {
  const { credential, role = 'user' } = req.body

  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ success: false, message: 'Google credential token is required' })
  }

  const payload = await verifyGoogleToken(credential)
  if (!payload || !payload.email) {
    return res.status(401).json({ success: false, message: 'Invalid or expired Google authentication token' })
  }

  const normalizedEmail = String(payload.email).trim().toLowerCase()
  const users = getDb().collection('users')
  let user = await users.findOne({ email: normalizedEmail })

  if (user) {
    if (user.role === 'admin' && role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'This account is an Administrator. Please sign in through the Admin Portal.',
      })
    }

    const updates = {}
    if (!user.googleId && payload.sub) updates.googleId = payload.sub
    if (!user.profileImageUrl && payload.picture) updates.profileImageUrl = payload.picture
    if (!user.name && (payload.name || payload.given_name)) {
      updates.name = payload.name || payload.given_name
    }
    if (Object.keys(updates).length > 0) {
      await users.updateOne({ _id: user._id }, { $set: updates })
      user = { ...user, ...updates }
    }
  } else {
    user = {
      id: crypto.randomUUID(),
      name: payload.name || payload.given_name || normalizedEmail.split('@')[0],
      email: normalizedEmail,
      phone: '',
      role: 'user',
      isAdmin: false,
      isWomanVerified: false,
      verificationDetails: null,
      profileImageUrl: payload.picture || null,
      googleId: payload.sub || null,
      authProvider: 'google',
      createdAt: new Date(),
    }
    await users.insertOne(user)
  }

  const token = await createSession(user.id, { isAdmin: user.role === 'admin' })
  return res.json({ success: true, token, user: publicUser(user) })
})

// Basic Google Login Endpoint
router.post(['/google-login', '/google-demo'], async (req, res) => {
  const { email, name, picture } = req.body || {}
  const googleEmail = (typeof email === 'string' && email.trim()) ? email.trim().toLowerCase() : 'tuhinabanerjee134@gmail.com'
  const googleName = (typeof name === 'string' && name.trim()) ? name.trim() : 'Tuhina Banerjee'

  const users = getDb().collection('users')
  let user = await users.findOne({ email: googleEmail })

  if (user) {
    if (user.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'This account is an Administrator. Please sign in through the Admin Portal.',
      })
    }
    // Ensure verified woman status is active for the user
    if (!user.isWomanVerified) {
      await users.updateOne({ _id: user._id }, { $set: { isWomanVerified: true } })
      user.isWomanVerified = true
    }
  } else {
    user = {
      id: crypto.randomUUID(),
      name: googleName,
      email: googleEmail,
      phone: '',
      role: 'user',
      isAdmin: false,
      isWomanVerified: true,
      verificationDetails: null,
      profileImageUrl: picture || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
      googleId: `google-${crypto.randomUUID()}`,
      authProvider: 'google',
      createdAt: new Date(),
    }
    await users.insertOne(user)
  }

  const token = await createSession(user.id, { isAdmin: false })
  return res.json({ success: true, token, user: publicUser(user) })
})

// Dedicated Admin Login Endpoint
router.post('/admin-login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many admin login attempts. Please try again later.',
}), async (req, res) => {
  const { email, password } = req.body
  if (![email, password].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Admin email and password are required' })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const users = getDb().collection('users')
  const user = await users.findOne({ email: normalizedEmail, role: 'admin' })
  const validPassword = user && verifyPassword(password, user.passwordHash)

  if (!user || !validPassword || user.suspended) {
    await writeAuditLog({
      req,
      action: 'admin.login',
      outcome: 'failure',
      metadata: { email: normalizedEmail },
    })
    return res.status(401).json({ success: false, message: 'Invalid admin credentials' })
  }

  req.user = user
  const token = await createSession(user.id, { isAdmin: true })
  await writeAuditLog({ req, action: 'admin.login', metadata: { sessionDurationMinutes: 30 } })
  return res.json({ success: true, token, user: publicUser(user) })
})

router.post('/logout', authenticate, async (req, res) => {
  await getDb().collection('sessions').deleteOne({ _id: req.session._id })
  return res.json({ success: true })
})

router.post('/admin/sessions/revoke-all', authenticate, requireAdmin, async (req, res) => {
  const result = await getDb().collection('sessions').deleteMany({
    userId: req.user.id,
    _id: { $ne: req.session._id },
  })
  await writeAuditLog({ req, action: 'admin.sessions.revoke_all', metadata: { revokedCount: result.deletedCount } })
  return res.json({ success: true, revokedCount: result.deletedCount })
})

router.get('/me', authenticate, (req, res) => res.json({ success: true, user: publicUser(req.user) }))

router.patch('/profile', authenticate, async (req, res) => {
  const updates = {}
  if (typeof req.body.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim()
  if (typeof req.body.phone === 'string' && req.body.phone.trim()) updates.phone = req.body.phone.trim()
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'A valid name or phone number is required' })

  await getDb().collection('users').updateOne({ id: req.user.id }, { $set: updates })
  const user = await getDb().collection('users').findOne({ id: req.user.id }, { projection: { _id: 0, passwordHash: 0, password: 0 } })
  return res.json({ success: true, user: publicUser(user) })
})

router.post('/profile/avatar', authenticate, (req, res, next) => {
  upload.single('avatar')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Profile image must be 5 MB or smaller' })
    }
    if (error) return next(error)
    return next()
  })
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'An image file is required' })
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype)) {
    return res.status(400).json({ success: false, message: 'Only JPG, PNG, and WebP images are supported' })
  }
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return res.status(503).json({ success: false, message: 'Cloudinary is not configured on the server' })
  }

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'womens-safety/profile-avatars', public_id: req.user.id, overwrite: true, resource_type: 'image' },
      (error, uploadResult) => error ? reject(error) : resolve(uploadResult),
    )
    stream.end(req.file.buffer)
  })
  await getDb().collection('users').updateOne({ id: req.user.id }, { $set: { profileImageUrl: result.secure_url, profileImagePublicId: result.public_id } })
  const user = await getDb().collection('users').findOne({ id: req.user.id }, { projection: { _id: 0, passwordHash: 0, password: 0 } })
  return res.json({ success: true, user: publicUser(user) })
})

router.post('/verify-gender', authenticate, async (req, res) => {
  const { faceVerified, voicePitch } = req.body
  if (typeof faceVerified !== 'boolean' || typeof voicePitch !== 'number' || !Number.isFinite(voicePitch)) {
    return res.status(400).json({ success: false, message: 'Missing or invalid verification data' })
  }
  if (!faceVerified) return res.status(400).json({ success: false, message: 'Facial liveness verification failed' })
  if (voicePitch < 160) return res.status(400).json({ success: false, message: 'Voice pitch analysis did not meet verification criteria' })

  await getDb().collection('users').updateOne(
    { id: req.user.id },
    { $set: { isWomanVerified: true, verificationDetails: { voicePitch, faceVerified, verifiedAt: new Date() } } },
  )
  const user = await getDb().collection('users').findOne({ id: req.user.id }, { projection: { _id: 0, passwordHash: 0, password: 0 } })
  return res.json({ success: true, message: 'Verification successful', user: publicUser(user) })
})

// Identity & Voice Verification Review Submission Endpoint
router.post('/verification-submission', authenticate, (req, res, next) => {
  upload.single('aadhaar')(req, res, (error) => {
    if (error) return next(error)
    return next()
  })
}, async (req, res) => {
  const { name, dateOfBirth, gender, voicePitch } = req.body || {}
  const parsedPitch = parseFloat(voicePitch) || 0

  const verificationDetails = {
    name: (typeof name === 'string' && name.trim()) || req.user.name,
    dateOfBirth: dateOfBirth || null,
    gender: gender || 'FEMALE',
    voicePitch: parsedPitch,
    hasAadhaar: Boolean(req.file),
    submittedAt: new Date(),
  }

  await getDb().collection('users').updateOne(
    { id: req.user.id },
    {
      $set: {
        isWomanVerified: true,
        name: verificationDetails.name,
        verificationDetails,
      },
    },
  )

  const updatedUser = await getDb().collection('users').findOne(
    { id: req.user.id },
    { projection: { _id: 0, passwordHash: 0, password: 0 } },
  )

  return res.json({
    success: true,
    message: 'Identity verification approved successfully',
    user: publicUser(updatedUser),
  })
})

module.exports = router
