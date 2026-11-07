const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')
const { authenticate, requireAdmin } = require('../middleware/auth')
const { writeAuditLog } = require('../utils/audit')

const router = express.Router()
const defaultAdminSettings = {
  alertRadius: '5 km',
  routingProvider: 'google',
  autoDispatchEnabled: true,
}

async function countByDate(collection, field, start, end) {
  const [result] = await collection.aggregate([
    {
      $project: {
        parsedDate: {
          $convert: { input: `$${field}`, to: 'date', onError: null, onNull: null },
        },
      },
    },
    { $match: { parsedDate: { $gte: start, $lte: end } } },
    { $count: 'count' },
  ]).toArray()
  return result?.count || 0
}

async function latestDate(collection, field) {
  const [result] = await collection.aggregate([
    {
      $project: {
        parsedDate: {
          $convert: { input: `$${field}`, to: 'date', onError: null, onNull: null },
        },
      },
    },
    { $match: { parsedDate: { $ne: null } } },
    { $sort: { parsedDate: -1 } },
    { $limit: 1 },
  ]).toArray()
  return result?.parsedDate || null
}

async function monthlyCounts(collection, field) {
  const rows = await collection.aggregate([
    {
      $project: {
        parsedDate: {
          $convert: { input: `$${field}`, to: 'date', onError: null, onNull: null },
        },
      },
    },
    { $match: { parsedDate: { $ne: null } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$parsedDate' } },
        count: { $sum: 1 },
      },
    },
  ]).toArray()
  return new Map(rows.map((row) => [row._id, row.count]))
}

// GET /api/admin/stats - returns strictly real metrics computed directly from database collections
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDb()
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)

    // 1. Real User Counts
    const [totalUsers, usersThisWeek, usersLastWeek] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('users').countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      db.collection('users').countDocuments({ createdAt: { $gte: fourteenDaysAgo, $lt: sevenDaysAgo } }),
    ])

    let userGrowth = '0%'
    if (usersLastWeek > 0) {
      const growthPercent = Math.round(((usersThisWeek - usersLastWeek) / usersLastWeek) * 100)
      userGrowth = growthPercent >= 0 ? `+${growthPercent}%` : `${growthPercent}%`
    } else if (usersThisWeek > 0) {
      userGrowth = `+${usersThisWeek}`
    }

    // 2. Real Incident Reports Count
    const [incidentReports, incidentsThisWeek, incidentsLastWeek] = await Promise.all([
      db.collection('incidents').countDocuments(),
      db.collection('incidents').countDocuments({ date: { $gte: sevenDaysAgo.toISOString() } }),
      db.collection('incidents').countDocuments({
        date: { $gte: fourteenDaysAgo.toISOString(), $lt: sevenDaysAgo.toISOString() },
      }),
    ])

    let incidentGrowth = '0%'
    if (incidentsLastWeek > 0) {
      const diff = Math.round(((incidentsThisWeek - incidentsLastWeek) / incidentsLastWeek) * 100)
      incidentGrowth = diff >= 0 ? `+${diff}%` : `${diff}%`
    } else if (incidentsThisWeek > 0) {
      incidentGrowth = `+${incidentsThisWeek}`
    }

    // 3. Real High-Risk Zones Calculation
    // Find all incidents flagged HIGH or CRITICAL
    const highRiskIncidents = await db.collection('incidents')
      .find({ severity: { $in: ['HIGH', 'CRITICAL'] } })
      .project({ location: 1, latitude: 1, longitude: 1, date: 1 })
      .toArray()

    const uniqueZones = new Set()
    const uniqueRecentZones = new Set()

    highRiskIncidents.forEach((item) => {
      const zoneKey = item.location ? item.location.split(',')[0].trim() : `${item.latitude?.toFixed(2)},${item.longitude?.toFixed(2)}`
      uniqueZones.add(zoneKey)
      if (item.date && new Date(item.date) >= sevenDaysAgo) {
        uniqueRecentZones.add(zoneKey)
      }
    })

    const highRiskZones = uniqueZones.size
    const riskZoneChange = uniqueRecentZones.size > 0 ? `+${uniqueRecentZones.size}` : '0'

    // 4. Real Active SOS Alerts Count
    const past24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const [activeSosAlerts, resolvedEmergenciesRecent, activeEmergenciesWithLocation] = await Promise.all([
      db.collection('emergencies').countDocuments({ status: 'ACTIVE' }),
      db.collection('emergencies').countDocuments({ status: 'RESOLVED', timestamp: { $gte: past24h } }),
      db.collection('emergencies').countDocuments({
        status: 'ACTIVE',
        latitude: { $type: 'number' },
        longitude: { $type: 'number' },
      }),
    ])
    const sosChange = resolvedEmergenciesRecent > 0 ? `-${resolvedEmergenciesRecent}` : '0'
    const responseReadiness = activeSosAlerts === 0
      ? 100
      : Math.round((activeEmergenciesWithLocation / activeSosAlerts) * 100)

    // 5. Real 7-Day Incident Trend with Dynamic Current Calendar Dates
    const trends = []
    const analyticsSeries = {
      users: [],
      reports: [],
      journeys: [],
      sos: [],
      broadcasts: [],
    }
    const dateSources = [
      [db.collection('users'), 'createdAt'],
      [db.collection('incidents'), 'date'],
      [db.collection('journeys'), 'startTime'],
      [db.collection('emergencies'), 'timestamp'],
      [db.collection('broadcastAlerts'), 'createdAt'],
    ]
    const monthlyMaps = await Promise.all(dateSources.map(([collection, field]) => monthlyCounts(collection, field)))
    const incidentMap = monthlyMaps[1]
    const monthKeys = [...new Set(monthlyMaps.flatMap((counts) => [...counts.keys()]))].sort()
    const chartMonths = monthKeys.length > 0 ? monthKeys : [`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`]
    const formatMonth = (monthKey) => {
      const [year, month] = monthKey.split('-').map(Number)
      return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    }

    chartMonths.forEach((monthKey) => {
      const dateLabel = formatMonth(monthKey)
      const count = incidentMap.get(monthKey) || 0
      trends.push({ date: dateLabel, count })
      analyticsSeries.users.push({ date: dateLabel, count: monthlyMaps[0].get(monthKey) || 0 })
      analyticsSeries.reports.push({ date: dateLabel, count })
      analyticsSeries.journeys.push({ date: dateLabel, count: monthlyMaps[2].get(monthKey) || 0 })
      analyticsSeries.sos.push({ date: dateLabel, count: monthlyMaps[3].get(monthKey) || 0 })
      analyticsSeries.broadcasts.push({ date: dateLabel, count: monthlyMaps[4].get(monthKey) || 0 })
    })

    // 6. Real Recent Incidents List (strictly real items)
    const recentIncidentsFromDb = await db.collection('incidents')
      .find({})
      .sort({ date: -1 })
      .limit(6)
      .project({ _id: 0 })
      .toArray()

    const recentIncidents = recentIncidentsFromDb.map((item, index) => ({
      id: item.id || `inc-${index}`,
      category: item.category || 'Incident',
      location: (item.location || 'Unknown location').split(',')[0].trim(),
      fullLocation: item.location,
      description: item.description || '',
      severity: item.severity || 'MODERATE',
      timeAgo: formatTimeAgo(item.date),
      date: item.date,
      latitude: item.latitude,
      longitude: item.longitude,
    }))

    // 7. Real Incident Map Coordinates
    const mapIncidents = await db.collection('incidents')
      .find({ latitude: { $exists: true }, longitude: { $exists: true } }, { projection: { _id: 0, id: 1, latitude: 1, longitude: 1, category: 1, severity: 1, location: 1 } })
      .limit(50)
      .toArray()

    return res.json({
      success: true,
      stats: {
        totalUsers,
        incidentReports,
        highRiskZones,
        activeSosAlerts,
        responseReadiness,
        responseReadinessDetails: {
          activeSosAlerts,
          activeSosWithLocation: activeEmergenciesWithLocation,
        },
        userGrowth,
        incidentGrowth,
        riskZoneChange,
        sosChange,
        trends,
        analyticsSeries,
        recentIncidents,
        mapIncidents,
      },
    })
  } catch (error) {
    console.error('Error fetching admin stats:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch admin stats' })
  }
})

router.get('/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    const stored = await getDb().collection('adminSettings').findOne({ id: 'platform' }, { projection: { _id: 0 } })
    return res.json({ success: true, settings: { ...defaultAdminSettings, ...(stored || {}) } })
  } catch (error) {
    console.error('Error fetching admin settings:', error)
    return res.status(500).json({ success: false, message: 'Failed to load platform settings' })
  }
})

router.patch('/settings', authenticate, requireAdmin, async (req, res) => {
  const { alertRadius, routingProvider, autoDispatchEnabled } = req.body
  const validRadii = ['2 km', '5 km', '10 km']
  const validProviders = ['google', 'mapbox', 'osm']
  if (!validRadii.includes(alertRadius) || !validProviders.includes(routingProvider) || typeof autoDispatchEnabled !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Invalid platform settings' })
  }

  try {
    const settings = { id: 'platform', alertRadius, routingProvider, autoDispatchEnabled, updatedAt: new Date(), updatedBy: req.user.id }
    await getDb().collection('adminSettings').replaceOne({ id: 'platform' }, settings, { upsert: true })
    await writeAuditLog({ req, action: 'admin.settings.update', targetType: 'settings', targetId: 'platform', metadata: { alertRadius, routingProvider, autoDispatchEnabled } })
    return res.json({ success: true, settings: { ...settings } })
  } catch (error) {
    console.error('Error saving admin settings:', error)
    return res.status(500).json({ success: false, message: 'Failed to save platform settings' })
  }
})

// POST /api/admin/broadcast - broadcast emergency warning
router.post('/broadcast', authenticate, requireAdmin, async (req, res) => {
  const { title, message, severity, zone } = req.body
  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'Broadcast alert message is required' })
  }

  const alert = {
    id: crypto.randomUUID(),
    title: title?.trim() || 'Urgent Safety Broadcast',
    message: message.trim(),
    severity: severity || 'HIGH',
    zone: zone || 'All Zones',
    createdAt: new Date(),
    createdBy: req.user.name || 'Admin',
  }

  try {
    await getDb().collection('broadcastAlerts').insertOne(alert)
    const io = req.app.get('io')
    if (io) {
      io.emit('safety_broadcast', alert)
      io.to('admin:notifications').emit('admin_notification', {
        id: alert.id,
        type: 'broadcast',
        title: alert.title,
        message: alert.message,
        severity: alert.severity,
        createdAt: alert.createdAt,
      })
    }
    await writeAuditLog({ req, action: 'admin.broadcast.create', targetType: 'broadcast', targetId: alert.id, metadata: { severity: alert.severity, zone: alert.zone } })
    const { _id, ...resAlert } = alert
    return res.json({ success: true, message: 'Emergency broadcast dispatched successfully', alert: resAlert })
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to broadcast alert' })
  }
})

// GET /api/admin/broadcasts - list past broadcasts
router.get('/broadcasts', authenticate, requireAdmin, async (req, res) => {
  try {
    const alerts = await getDb().collection('broadcastAlerts')
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray()
    return res.json({ success: true, alerts })
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load broadcasts' })
  }
})

router.get('/audit-logs', authenticate, requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100)
  try {
    const logs = await getDb().collection('adminAuditLogs')
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
    return res.json({ success: true, logs })
  } catch (error) {
    console.error('Error fetching admin audit logs:', error)
    return res.status(500).json({ success: false, message: 'Failed to load audit logs' })
  }
})

// GET /api/admin/users - list users with full profile, verification and activity data
router.get('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDb()
    const users = await db.collection('users')
      .find({}, { projection: { password: 0, passwordHash: 0, _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray()

    const enrichedUsers = await Promise.all(
      users.map(async (u) => {
        const [emergencyCount, activeEmergencies, journeyCount, contactCount, incidentCount, contactsList, latestEmergency] = await Promise.all([
          db.collection('emergencies').countDocuments({ userId: u.id }),
          db.collection('emergencies').countDocuments({ userId: u.id, status: 'ACTIVE' }),
          db.collection('journeys').countDocuments({ userId: u.id }),
          db.collection('contacts').countDocuments({ userId: u.id }),
          db.collection('incidents').countDocuments({ userId: u.id }),
          db.collection('contacts').find({ userId: u.id }, { projection: { _id: 0, name: 1, phone: 1, relationship: 1 } }).limit(10).toArray(),
          db.collection('emergencies').findOne({ userId: u.id }, { projection: { _id: 0 }, sort: { timestamp: -1 } }),
        ])

        return {
          ...u,
          emergencyCount,
          activeEmergencies,
          journeyCount,
          contactCount,
          incidentCount,
          contacts: contactsList,
          latestEmergency: latestEmergency || null,
          verificationDetails: u.verificationDetails || null,
        }
      })
    )

    return res.json({ success: true, users: enrichedUsers })
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load users' })
  }
})

// PATCH /api/admin/users/:userId/verify - toggle woman verification status
router.patch('/users/:userId/verify', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDb()
    const { userId } = req.params
    const { isWomanVerified } = req.body

    const update = { isWomanVerified: Boolean(isWomanVerified) }
    if (isWomanVerified) {
      update.verificationDetails = {
        manualReview: true,
        verifiedAt: new Date(),
        manuallyVerifiedBy: req.user.email || 'Admin',
      }
    }

    const result = await db.collection('users').updateOne(
      { id: userId },
      { $set: update }
    )

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }

    await writeAuditLog({
      req,
      action: 'admin.user.verify',
      targetType: 'user',
      targetId: userId,
      metadata: { isWomanVerified: Boolean(isWomanVerified) },
    })
    return res.json({ success: true, message: `User verification updated to ${isWomanVerified}` })
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update user verification' })
  }
})

// GET /api/admin/incidents - list all incidents
router.get('/incidents', authenticate, requireAdmin, async (req, res) => {
  try {
    const incidents = await getDb().collection('incidents')
      .find({}, { projection: { _id: 0 } })
      .sort({ date: -1 })
      .limit(50)
      .toArray()
    return res.json({ success: true, incidents })
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load incidents' })
  }
})

router.get('/live-journeys', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDb()
    const journeys = await db.collection('journeys')
      .find({ status: 'ACTIVE' }, { projection: { _id: 0 } })
      .sort({ startTime: -1 })
      .toArray()

    const users = await db.collection('users')
      .find({ id: { $in: journeys.map((journey) => journey.userId) } }, {
        projection: { _id: 0, id: 1, name: 1, email: 1, phone: 1, profileImageUrl: 1 },
      })
      .toArray()
    const usersById = new Map(users.map((user) => [user.id, user]))

    return res.json({
      success: true,
      journeys: journeys.map((journey) => ({
        id: journey.id,
        userId: journey.userId,
        status: journey.status,
        startTime: journey.startTime,
        origin: journey.origin,
        destination: journey.destination,
        selectedRoute: journey.selectedRoute
          ? {
              routeId: journey.selectedRoute.routeId,
              coordinates: journey.selectedRoute.coordinates,
              distance: journey.selectedRoute.distance,
              duration: journey.selectedRoute.duration,
              riskLevel: journey.selectedRoute.riskLevel,
              riskScore: journey.selectedRoute.riskScore,
            }
          : null,
        latestLocation: journey.latestLocation || null,
        user: usersById.get(journey.userId) || { id: journey.userId, name: 'Unknown user' },
      })),
    })
  } catch (error) {
    console.error('Error fetching live admin journeys:', error)
    return res.status(500).json({ success: false, message: 'Failed to load live journeys' })
  }
})

function formatTimeAgo(dateString) {
  if (!dateString) return 'Recently'
  const diff = Date.now() - new Date(dateString).getTime()
  if (diff < 0) return 'Just now'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return `${days} d ago`
}

module.exports = router
