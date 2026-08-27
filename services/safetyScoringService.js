const fs = require('fs')
const path = require('path')

const incidentsFile = path.join(__dirname, '..', 'data', 'incidents.json')
const proximityThresholdMeters = 1000
const severityWeights = { low: 10, moderate: 25, high: 45, critical: 70 }

function readIncidents() {
  return JSON.parse(fs.readFileSync(incidentsFile, 'utf8'))
}

function distanceBetween(latitude1, longitude1, latitude2, longitude2) {
  const earthRadius = 6371000
  const latitudeDelta = (latitude2 - latitude1) * Math.PI / 180
  const longitudeDelta = (longitude2 - longitude1) * Math.PI / 180
  const first = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitude1 * Math.PI / 180) * Math.cos(latitude2 * Math.PI / 180) * Math.sin(longitudeDelta / 2) ** 2
  return earthRadius * 2 * Math.atan2(Math.sqrt(first), Math.sqrt(1 - first))
}

function isIncidentNearRoute(incident, coordinates) {
  return coordinates.some(([latitude, longitude]) => distanceBetween(incident.latitude, incident.longitude, latitude, longitude) <= proximityThresholdMeters)
}

function recencyMultiplier(date) {
  const ageInDays = Math.max(0, (Date.now() - new Date(date).getTime()) / 86400000)
  if (!Number.isFinite(ageInDays)) return 0.25
  if (ageInDays <= 7) return 1
  if (ageInDays <= 30) return 0.75
  if (ageInDays <= 90) return 0.5
  return 0.25
}

function getRiskLevel(score) {
  if (score <= 25) return 'LOW'
  if (score <= 50) return 'MODERATE'
  if (score <= 75) return 'HIGH'
  return 'CRITICAL'
}

function scoreRoute(route, incidents) {
  const relevantIncidents = incidents.filter((incident) => isIncidentNearRoute(incident, route.coordinates))
  const score = Math.min(100, Math.round(relevantIncidents.reduce((total, incident) => total + (severityWeights[String(incident.severity).toLowerCase()] || severityWeights.moderate) * recencyMultiplier(incident.date), 0)))
  const explanation = relevantIncidents.length === 0
    ? 'No recorded incidents were found near this route.'
    : `${relevantIncidents.length} recorded incident${relevantIncidents.length === 1 ? '' : 's'} near this route, weighted by severity and recency.`

  return {
    ...route,
    riskScore: score,
    riskLevel: getRiskLevel(score),
    incidentCount: relevantIncidents.length,
    explanation,
  }
}

function scoreRoutes(routes) {
  return routes.map((route) => scoreRoute(route, readIncidents()))
}

module.exports = { scoreRoutes }