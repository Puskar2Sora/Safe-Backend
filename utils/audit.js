const crypto = require('crypto')
const { getDb } = require('../config/db')

async function writeAuditLog({ req, action, outcome = 'success', targetType, targetId, metadata = {} }) {
  const user = req?.user
  await getDb().collection('adminAuditLogs').insertOne({
    id: crypto.randomUUID(),
    actorId: user?.id || null,
    actorEmail: user?.email || null,
    action,
    outcome,
    targetType: targetType || null,
    targetId: targetId || null,
    metadata,
    ipAddress: req?.ip || null,
    userAgent: req?.get('user-agent') || null,
    createdAt: new Date(),
  })
}

module.exports = { writeAuditLog }
