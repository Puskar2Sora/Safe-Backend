const { getDb } = require('../config/db')
const proximityThresholdMeters = 1000
const severityWeights = { low: 10, moderate: 25, high: 45, critical: 70 }

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

async function scoreRoutes(routes) {
  const incidents = await getDb().collection('incidents').find({}, { projection: { _id: 0 } }).toArray()
  return routes.map((route) => scoreRoute(route, incidents))
}

async function assessLocationSafety(latitude, longitude, radiusMeters = 3000) {
  const incidents = await getDb().collection('incidents').find({}, { projection: { _id: 0 } }).toArray()

  const nearbyIncidents = incidents
    .map((incident) => {
      const distanceMeters = distanceBetween(latitude, longitude, incident.latitude, incident.longitude)
      return { ...incident, distanceMeters }
    })
    .filter((incident) => incident.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)

  const totalRisk = nearbyIncidents.reduce((total, incident) => {
    const weight = severityWeights[String(incident.severity).toLowerCase()] || severityWeights.moderate
    return total + weight * recencyMultiplier(incident.date)
  }, 0)

  // Safety score scale from 0 to 100 (100 = completely safe, lower = riskier)
  const safetyScore = Math.max(10, Math.min(100, Math.round(100 - Math.min(90, totalRisk))))
  const riskLevel = getRiskLevel(totalRisk)

  let riskLabel = 'Low'
  let riskSubtext = 'No high-risk zones detected in your area.'
  let safetyLabel = 'Safe'

  if (riskLevel === 'LOW') {
    riskLabel = 'Low'
    safetyLabel = safetyScore >= 90 ? 'Very Safe' : 'Safe'
    riskSubtext = nearbyIncidents.length === 0
      ? 'No recorded incidents within 3 km.'
      : `${nearbyIncidents.length} minor concern in the area.`
  } else if (riskLevel === 'MODERATE') {
    riskLabel = 'Moderate'
    safetyLabel = 'Moderate'
    riskSubtext = `${nearbyIncidents.length} incident${nearbyIncidents.length === 1 ? '' : 's'} recorded within 3 km.`
  } else if (riskLevel === 'HIGH') {
    riskLabel = 'High'
    safetyLabel = 'Caution'
    riskSubtext = `${nearbyIncidents.length} incidents nearby. Exercise caution.`
  } else {
    riskLabel = 'Critical'
    safetyLabel = 'Alert'
    riskSubtext = 'Multiple severe incidents recorded nearby.'
  }

  return {
    safetyScore,
    safetyLabel,
    riskLevel,
    riskLabel,
    riskSubtext,
    incidentCount: nearbyIncidents.length,
    radiusMeters,
    nearestIncident: nearbyIncidents[0] || null,
  }
}

module.exports = { scoreRoutes, assessLocationSafety }
