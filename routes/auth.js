const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')
const { authenticate } = require('../middleware/auth')
const multer = require('multer')
const { v2: cloudinary } = require('cloudinary')

const router = express.Router()
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

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
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    isWomanVerified: Boolean(user.isWomanVerified),
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

  const user = await getDb().collection('users').findOne({ email: email.trim().toLowerCase() })
  const validPassword = user && (verifyPassword(password, user.passwordHash) || user.password === password)
  if (!user || !validPassword) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' })
  }
  if (!user.passwordHash) {
    await getDb().collection('users').updateOne({ _id: user._id }, { $set: { passwordHash: hashPassword(password) }, $unset: { password: '' } })
  }
  const token = await createSession(user.id)
  return res.json({ success: true, token, user: publicUser(user) })
})

router.post('/logout', authenticate, async (req, res) => {
  await getDb().collection('sessions').deleteOne({ _id: req.session._id })
  return res.json({ success: true })
})

router.get('/me', authenticate, (req, res) => res.json({ success: true, user: req.user }))

router.patch('/profile', authenticate, async (req, res) => {
  const updates = {}
  if (typeof req.body.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim()
  if (typeof req.body.phone === 'string' && req.body.phone.trim()) updates.phone = req.body.phone.trim()
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'A valid name or phone number is required' })

  await getDb().collection('users').updateOne({ id: req.user.id }, { $set: updates })
  const user = await getDb().collection('users').findOne({ id: req.user.id }, { projection: { _id: 0, passwordHash: 0, password: 0 } })
  return res.json({ success: true, user })
})

router.post('/profile/avatar', authenticate, upload.single('avatar'), async (req, res) => {
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
  return res.json({ success: true, user })
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
  return res.json({ success: true, message: 'Verification successful', user })
})

module.exports = router
