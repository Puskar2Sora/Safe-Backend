const geocodingUrl = 'https://nominatim.openstreetmap.org/search'
const reverseGeocodingUrl = 'https://nominatim.openstreetmap.org/reverse'
const routingUrl = 'https://router.project-osrm.org/route/v1/driving'
const mapboxRoutingUrl = 'https://api.mapbox.com/directions/v5/mapbox/driving-traffic'
const googleRoutesUrl = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const trafficLevels = ['LOW', 'MODERATE', 'HIGH', 'SEVERE']

function hasUsableApiKey(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  const normalized = value.trim().toLowerCase()
  return !['your_google_api_key', 'your_mapbox_access_token', 'your_api_key', 'change_me'].includes(normalized)
}

async function fetchWithRetry(url, options = {}) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timeout)
      return response
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
    }
  }
  throw lastError
}

async function geocodeLocation(location) {
  const response = await fetchWithRetry(`${geocodingUrl}?format=jsonv2&limit=1&q=${encodeURIComponent(location)}`, {
    headers: { 'User-Agent': "Women's Safety Platform MVP" },
  })

  if (!response.ok) throw new Error('Geocoding service is unavailable')
  const results = await response.json()
  if (!results.length) throw new Error(`Could not find a location for "${location}"`)
  const [result] = results

  return {
    latitude: Number(result.lat),
    longitude: Number(result.lon),
    displayName: result.display_name,
  }
}

async function reverseGeocodeLocation(latitude, longitude) {
  const response = await fetchWithRetry(`${reverseGeocodingUrl}?format=jsonv2&zoom=18&lat=${latitude}&lon=${longitude}`, {
    headers: { 'User-Agent': "Women's Safety Platform MVP" },
  })

  if (!response.ok) throw new Error('Location lookup service is unavailable')
  const result = await response.json()
  if (!result.display_name) throw new Error('Could not identify your current location')

  return { latitude, longitude, displayName: result.display_name }
}

// A location coming from the client can be either:
//  - plain text the person typed and never picked a suggestion for (needs geocoding), or
//  - an already-resolved coordinate, from clicking an autocomplete suggestion or from
//    "use my current location" (must NOT be re-geocoded - that would throw away precision
//    and can resolve to the wrong place for common/duplicate names).
function isResolvedLocation(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isFinite(Number(value.latitude)) &&
    Number.isFinite(Number(value.longitude))
  )
}

async function resolveLocation(input) {
  if (isResolvedLocation(input)) {
    return {
      latitude: Number(input.latitude),
      longitude: Number(input.longitude),
      displayName: input.displayName || input.name || `${input.latitude}, ${input.longitude}`,
    }
  }
  if (typeof input === 'string' && input.trim()) {
    return geocodeLocation(input.trim())
  }
  throw new Error('A location is required')
}

function trafficLevelFromCongestion(congestion) {
  const normalized = typeof congestion === 'string' ? congestion.toLowerCase() : ''
  if (normalized === 'severe') return 'SEVERE'
  if (normalized === 'heavy') return 'HIGH'
  if (normalized === 'moderate') return 'MODERATE'
  if (normalized === 'low') return 'LOW'
  return null
}

function estimateTrafficLevel(date = new Date(), segmentIndex = 0) {
  const hour = date.getHours()
  const isPeak = (hour >= 7 && hour <= 10) || (hour >= 17 && hour <= 21)
  if (isPeak) return segmentIndex % 5 === 0 ? 'SEVERE' : segmentIndex % 2 === 0 ? 'HIGH' : 'MODERATE'
  if (hour >= 11 && hour <= 16) return segmentIndex % 4 === 0 ? 'HIGH' : 'MODERATE'
  return segmentIndex % 3 === 0 ? 'MODERATE' : 'LOW'
}

function buildTrafficSegments(coordinates, congestion = [], source = 'estimated') {
  const usableCongestion = congestion.filter((value) => trafficLevelFromCongestion(value))
  return coordinates.slice(0, -1).map((start, index) => ({
    coordinates: [start, coordinates[index + 1]],
    trafficLevel: source === 'mapbox' && usableCongestion.length > 0
      ? trafficLevelFromCongestion(usableCongestion[Math.min(usableCongestion.length - 1, Math.floor(index * usableCongestion.length / Math.max(1, coordinates.length - 1)))]) || estimateTrafficLevel(new Date(), index)
      : estimateTrafficLevel(new Date(), index),
  }))
}

function enrichRoute(route, index, source = 'estimated') {
  const coordinates = route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude])
  const congestion = route.legs?.flatMap((leg) => leg.annotation?.congestion || []) || []
  const annotatedDuration = route.legs?.flatMap((leg) => leg.annotation?.duration || []).reduce((sum, value) => sum + Number(value || 0), 0) || 0
  const trafficSegments = buildTrafficSegments(coordinates, congestion, source)
  const baseDuration = Number(route.duration)
  const trafficScore = Math.round(trafficSegments.reduce((sum, segment) => sum + trafficLevels.indexOf(segment.trafficLevel) * 33.33, 0) / Math.max(1, trafficSegments.length))
  const typicalDuration = Number(route.durationTypical || route.duration_typical || route.duration)
  const trafficDuration = source === 'mapbox' && annotatedDuration > 0
    ? annotatedDuration
    : Math.round(typicalDuration * (1 + trafficScore / 100 * 0.35))
  const highestTrafficIndex = trafficSegments.reduce((highest, segment) => Math.max(highest, trafficLevels.indexOf(segment.trafficLevel)), 0)
  return {
    routeId: `route-${index + 1}`,
    coordinates,
    distance: route.distance,
    duration: baseDuration,
    trafficDuration,
    trafficDelaySeconds: Math.max(0, Math.round(trafficDuration - baseDuration)),
    trafficLevel: highestTrafficIndex >= 3
      ? 'SEVERE'
      : highestTrafficIndex >= 2
        ? 'HIGH'
        : trafficSegments.some((segment) => segment.trafficLevel === 'MODERATE') ? 'MODERATE' : 'LOW',
    trafficScore,
    trafficSource: source,
    trafficProvider: source === 'mapbox' ? 'Mapbox' : 'Estimated',
    trafficSegments,
  }
}

function decodeGooglePolyline(encoded) {
  const coordinates = []
  let index = 0
  let latitude = 0
  let longitude = 0
  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let byte
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    latitude += (result & 1) ? ~(result >> 1) : result >> 1
    result = 0
    shift = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    longitude += (result & 1) ? ~(result >> 1) : result >> 1
    coordinates.push([latitude / 1e5, longitude / 1e5])
  }
  return coordinates
}

function parseDuration(value) {
  const match = typeof value === 'string' ? value.match(/^([\d.]+)s$/) : null
  return match ? Number(match[1]) : Number(value) || 0
}

function googleTrafficLevel(speed) {
  if (speed === 'TRAFFIC_JAM') return 'SEVERE'
  if (speed === 'SLOW') return 'MODERATE'
  return 'LOW'
}

function buildGoogleTrafficSegments(coordinates, route) {
  const details = route.travelAdvisory?.speedReadingIntervals
    || route.polyline?.trafficSpeedCategories
    || []
  if (!Array.isArray(details) || details.length === 0) return buildTrafficSegments(coordinates, [], 'estimated')
  if (typeof details[0] === 'string') {
    return coordinates.slice(0, -1).map((start, index) => ({
      coordinates: [start, coordinates[index + 1]],
      trafficLevel: googleTrafficLevel(details[Math.min(details.length - 1, Math.floor(index * details.length / Math.max(1, coordinates.length - 1)))])
    }))
  }
  return details.flatMap((detail) => {
    const start = Number(detail.startPolylinePointIndex)
    const end = Number(detail.endPolylinePointIndex)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= coordinates.length || end <= start) return []
    return [{
      coordinates: coordinates.slice(start, end + 1),
      trafficLevel: googleTrafficLevel(detail.speed),
    }]
  })
}

function enrichGoogleRoute(route, index) {
  const coordinates = decodeGooglePolyline(route.polyline?.encodedPolyline || '')
  const trafficSegments = buildGoogleTrafficSegments(coordinates, route)
  const trafficDuration = parseDuration(route.duration)
  const baseDuration = parseDuration(route.staticDuration) || trafficDuration
  const trafficScore = Math.round(trafficSegments.reduce((sum, segment) => sum + trafficLevels.indexOf(segment.trafficLevel) * 33.33, 0) / Math.max(1, trafficSegments.length))
  const highestTrafficIndex = trafficSegments.reduce((highest, segment) => Math.max(highest, trafficLevels.indexOf(segment.trafficLevel)), 0)
  return {
    routeId: `route-${index + 1}`,
    coordinates,
    distance: Number(route.distanceMeters) || 0,
    duration: baseDuration,
    trafficDuration,
    trafficDelaySeconds: Math.max(0, Math.round(trafficDuration - baseDuration)),
    trafficLevel: highestTrafficIndex >= 3 ? 'SEVERE' : highestTrafficIndex >= 2 ? 'HIGH' : trafficSegments.some((segment) => segment.trafficLevel === 'MODERATE') ? 'MODERATE' : 'LOW',
    trafficScore,
    trafficSource: 'google',
    trafficProvider: 'Google Routes API',
    trafficSegments,
  }
}

async function findGoogleRoute(origin, destination) {
  const response = await fetchWithRetry(googleRoutesUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
      destination: { location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      computeAlternativeRoutes: true,
      polylineQuality: 'HIGH',
      polylineEncoding: 'ENCODED_POLYLINE',
      extraComputations: ['TRAFFIC_ON_POLYLINE'],
    }),
  })
  if (!response.ok) throw new Error('Google Routes traffic service is unavailable')
  const result = await response.json()
  return result.routes?.map((route, index) => enrichGoogleRoute(route, index)) || []
}

async function findMapboxRoute(origin, destination) {
  const points = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`
  const url = `${mapboxRoutingUrl}/${points}?alternatives=true&overview=full&geometries=geojson&annotations=congestion,duration&access_token=${encodeURIComponent(process.env.MAPBOX_ACCESS_TOKEN)}`
  const response = await fetchWithRetry(url)
  if (!response.ok) throw new Error('Mapbox traffic routing service is unavailable')
  const result = await response.json()
  return result.routes?.map((route, index) => enrichRoute(route, index, 'mapbox')) || []
}

async function findRoute(from, to) {
  const origin = await resolveLocation(from)
  const destination = await resolveLocation(to)
  if (hasUsableApiKey(process.env.GOOGLE_MAPS_API_KEY)) {
    try {
      const routes = await findGoogleRoute(origin, destination)
      if (routes.length) return { origin, destination, routes }
    } catch (error) {
      if (!hasUsableApiKey(process.env.MAPBOX_ACCESS_TOKEN)) throw error
    }
  }
  if (hasUsableApiKey(process.env.MAPBOX_ACCESS_TOKEN)) {
    const routes = await findMapboxRoute(origin, destination)
    if (routes.length) return { origin, destination, routes }
  }
  const longitudeDelta = destination.longitude - origin.longitude
  const latitudeDelta = destination.latitude - origin.latitude
  const midpointLongitude = (origin.longitude + destination.longitude) / 2
  const midpointLatitude = (origin.latitude + destination.latitude) / 2
  const offsets = [0, -0.025, 0.025]
  const routeRequests = offsets.map((offset) => {
    const waypoint = offset === 0 ? null : {
      latitude: midpointLatitude + longitudeDelta * offset,
      longitude: midpointLongitude - latitudeDelta * offset,
    }
    const points = waypoint
      ? `${origin.longitude},${origin.latitude};${waypoint.longitude},${waypoint.latitude};${destination.longitude},${destination.latitude}`
      : `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`
    return fetchWithRetry(`${routingUrl}/${points}?alternatives=true&overview=full&geometries=geojson`).then(async (response) => {
      if (!response.ok) throw new Error('Routing service is unavailable')
      const result = await response.json()
      return result.routes?.[0]
    })
  })
  const routeResults = []
  for (const routeRequest of routeRequests) {
    try {
      routeResults.push({ status: 'fulfilled', value: await routeRequest })
    } catch (error) {
      routeResults.push({ status: 'rejected', reason: error })
    }
  }
  const routes = routeResults.filter((result) => result.status === 'fulfilled' && result.value).map((result) => result.value)
  if (!routes.length) throw new Error('No route was found between these locations')

  return {
    origin,
    destination,
    routes: routes.map((route, index) => enrichRoute(route, index)),
  }
}

async function searchLocations(query, userCoords = null) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return []
  }

  let url = `${geocodingUrl}?format=jsonv2&limit=12&addressdetails=1&countrycodes=in&q=${encodeURIComponent(query.trim())}`

  if (userCoords && Number.isFinite(userCoords.latitude) && Number.isFinite(userCoords.longitude)) {
    const lat = userCoords.latitude
    const lon = userCoords.longitude
    const left = lon - 1.0
    const right = lon + 1.0
    const top = lat + 1.0
    const bottom = lat - 1.0
    url += `&viewbox=${left},${top},${right},${bottom}&bounded=0`
  }

  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': "Women's Safety Platform MVP" },
  })

  if (!response.ok) return []
  let results = await response.json()
  if (!Array.isArray(results)) return []

  // Nominatim often needs the country in the query to resolve partial Indian
  // place names, even when countrycodes=in is already supplied.
  if (results.length === 0 && !query.trim().toLowerCase().endsWith('india')) {
    let fallbackUrl = `${geocodingUrl}?format=jsonv2&limit=12&addressdetails=1&countrycodes=in&q=${encodeURIComponent(`${query.trim()}, India`)}`
    if (userCoords && Number.isFinite(userCoords.latitude) && Number.isFinite(userCoords.longitude)) {
      const lat = userCoords.latitude
      const lon = userCoords.longitude
      fallbackUrl += `&viewbox=${lon - 1},${lat + 1},${lon + 1},${lat - 1}&bounded=0`
    }
    const fallbackResponse = await fetchWithRetry(fallbackUrl, {
      headers: { 'User-Agent': "Women's Safety Platform MVP" },
    })
    if (fallbackResponse.ok) results = await fallbackResponse.json()
  }

  if (!Array.isArray(results)) return []

  return results.map((item) => {
    const name = item.name || item.address?.amenity || item.address?.shop || item.address?.building || item.address?.road || item.address?.suburb || item.address?.city || item.display_name.split(',')[0]
    const fullDisplayName = item.display_name

    let subtitle = ''
    if (fullDisplayName.startsWith(name)) {
      subtitle = fullDisplayName.slice(name.length).replace(/^[,\s]+/, '')
    } else {
      subtitle = [
        item.address?.suburb || item.address?.neighbourhood,
        item.address?.city || item.address?.town || item.address?.municipality,
        item.address?.state,
        item.address?.country,
      ]
        .filter(Boolean)
        .join(', ')
    }

    const latitude = Number(item.lat)
    const longitude = Number(item.lon)
    const distanceKm = userCoords
      ? Math.sqrt(Math.pow((latitude - userCoords.latitude) * 111, 2) + Math.pow((longitude - userCoords.longitude) * 111 * Math.cos(userCoords.latitude * Math.PI / 180), 2))
      : null

    return {
      placeId: item.place_id,
      name: name || item.display_name,
      subtitle: subtitle || item.display_name,
      displayName: item.display_name,
      latitude,
      longitude,
      type: item.type || item.category || 'location',
      distanceKm,
    }
  })
}

module.exports = { findRoute, geocodeLocation, reverseGeocodeLocation, searchLocations, resolveLocation, buildTrafficSegments, estimateTrafficLevel, decodeGooglePolyline, buildGoogleTrafficSegments }