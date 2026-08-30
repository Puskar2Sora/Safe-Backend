const geocodingUrl = 'https://nominatim.openstreetmap.org/search'
const reverseGeocodingUrl = 'https://nominatim.openstreetmap.org/reverse'
const routingUrl = 'https://router.project-osrm.org/route/v1/driving'

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

async function findRoute(from, to) {
  const origin = await geocodeLocation(from)
  const destination = await geocodeLocation(to)
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
    routes: routes.map((route, index) => ({
      routeId: `route-${index + 1}`,
      coordinates: route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]),
      distance: route.distance,
      duration: route.duration,
    })),
  }
}

async function searchLocations(query, userCoords = null) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return []
  }

  let url = `${geocodingUrl}?format=jsonv2&limit=8&addressdetails=1&q=${encodeURIComponent(query.trim())}`

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
  const results = await response.json()
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

    return {
      placeId: item.place_id,
      name: name || item.display_name,
      subtitle: subtitle || item.display_name,
      displayName: item.display_name,
      latitude: Number(item.lat),
      longitude: Number(item.lon),
      type: item.type || item.category || 'location',
    }
  })
}

module.exports = { findRoute, geocodeLocation, reverseGeocodeLocation, searchLocations }