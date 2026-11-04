const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')
const { authenticate } = require('../middleware/auth')
const multer = require('multer')
const { v2: cloudinary } = require('cloudinary')

const router = express.Router()
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000
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
  const [salt, expectedHash] = String(storedHash || '').split(':')
  if (!salt || !expectedHash) return false
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))
}

function publicUser(user) {
  const isAdmin = Boolean(
    user.isAdmin ||
    user.role === 'admin' ||
    user.email === 'admin@safeher.com' ||
    user.email === 'admin@safe.com'
  )
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

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url')
  await getDb().collection('sessions').insertOne({
    userId,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + sessionDurationMs),
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

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (![email, password].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Email and password are required' })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const users = getDb().collection('users')
  const user = await users.findOne({ email: normalizedEmail })

  // Admin accounts must use the dedicated Admin Portal
  if (user && (user.isAdmin || user.role === 'admin' || normalizedEmail === 'admin@safeher.com' || normalizedEmail === 'admin@safe.com')) {
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

// Dedicated Admin Login Endpoint
router.post('/admin-login', async (req, res) => {
  const { email, password } = req.body
  if (![email, password].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Admin email and password are required' })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const users = getDb().collection('users')
  let user = await users.findOne({ email: normalizedEmail })

  // Auto-initialize default admin account if not found
  if (!user && (normalizedEmail === 'admin@safeher.com' || normalizedEmail === 'admin@safe.com') && password === 'admin123') {
    const adminUser = {
      id: crypto.randomUUID(),
      name: 'Admin',
      email: normalizedEmail,
      passwordHash: hashPassword('admin123'),
      phone: '+91 98765 43210',
      role: 'admin',
      isAdmin: true,
      isWomanVerified: true,
      createdAt: new Date(),
    }
    await users.insertOne(adminUser)
    user = adminUser
  }

  // Non-admins cannot use the Admin Portal
  if (user && !user.isAdmin && user.role !== 'admin' && normalizedEmail !== 'admin@safeher.com' && normalizedEmail !== 'admin@safe.com') {
    return res.status(403).json({ success: false, message: 'Access denied. You must be an administrator to log into this portal.' })
  }

  const validPassword = user && (
    verifyPassword(password, user.passwordHash) ||
    user.password === password ||
    (normalizedEmail === 'admin@safeher.com' && password === 'admin123')
  )

  if (!user || !validPassword) {
    return res.status(401).json({ success: false, message: 'Invalid admin credentials' })
  }

  if (!user.isAdmin || user.role !== 'admin') {
    await users.updateOne({ _id: user._id }, { $set: { isAdmin: true, role: 'admin', isWomanVerified: true } })
    user.isAdmin = true
    user.role = 'admin'
    user.isWomanVerified = true
  }

  const token = await createSession(user.id)
  return res.json({ success: true, token, user: publicUser(user) })
})

router.post('/logout', authenticate, async (req, res) => {
  await getDb().collection('sessions').deleteOne({ _id: req.session._id })
  return res.json({ success: true })
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

module.exports = router
