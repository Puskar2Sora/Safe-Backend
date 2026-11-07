const { getDb } = require('../config/db')

const defaults = {
  emergencyAlertsEnabled: true,
  incidentReportingEnabled: true,
  broadcastsEnabled: true,
  locationSharingEnabled: true,
  maintenanceMode: false,
}

async function getPlatformSettings() {
  const stored = await getDb().collection('adminSettings').findOne({ id: 'platform' }, { projection: { _id: 0 } })
  return { ...defaults, ...(stored || {}) }
}

module.exports = { getPlatformSettings }
