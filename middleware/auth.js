const crypto = require('crypto')
const { getDb } = require('../config/db')

async function getUserFromToken(token) {
  if (!token) return null

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const session = await getDb().collection('sessions').findOne({ tokenHash, expiresAt: { $gt: new Date() } })
  if (!session) return null

  const user = await getDb().collection('users').findOne({ id: session.userId }, { projection: { _id: 0, passwordHash: 0, password: 0 } })
  if (!user) return null
  return { user, session }
}

async function authenticate(req, res, next) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const authenticated = await getUserFromToken(token)
  if (!authenticated) return res.status(401).json({ success: false, message: 'Authentication is required or your session has expired' })

  req.user = authenticated.user
  req.session = authenticated.session
  await getDb().collection('sessions').updateOne({ _id: req.session._id }, { $set: { lastUsedAt: new Date() } })
  return next()
}

function requireUserId(req, res, next) {
  if (req.params.userId && req.params.userId !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You are not authorized to access this user' })
  }
  return next()
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' })
  }
  return next()
}

module.exports = { authenticate, getUserFromToken, requireUserId, requireAdmin }
