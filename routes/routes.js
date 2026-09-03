const express = require('express')
const { findRoute, reverseGeocodeLocation, searchLocations } = require('../services/routingService')
const { scoreRoutes } = require('../services/safetyScoringService')

const router = express.Router()

router.get('/search', async (req, res) => {
  const query = req.query.q
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.json({ success: true, suggestions: [] })
  }

  const latitude = req.query.lat ? Number(req.query.lat) : null
  const longitude = req.query.lon ? Number(req.query.lon) : null
  const userCoords = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null

  try {
    const suggestions = await searchLocations(query, userCoords)

    // Surface exact / prefix name matches first, like professional map apps do -
    // typing "Barasat" should show "Barasat" itself before "Barasat Road, ..." or
    // unrelated places that merely mention it in the address.
    const normalizedQuery = query.trim().toLowerCase()
    const rank = (item) => {
      const name = (item.name || '').toLowerCase()
      if (name === normalizedQuery) return 0
      if (name.startsWith(normalizedQuery)) return 1
      if (name.includes(normalizedQuery)) return 2
      return 3
    }
    const rankedSuggestions = [...suggestions].sort((a, b) => rank(a) - rank(b))

    return res.json({ success: true, suggestions: rankedSuggestions })
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unable to search locations',
      suggestions: [],
    })
  }
})

router.get('/reverse', async (req, res) => {
  const latitude = Number(req.query.latitude)
  const longitude = Number(req.query.longitude)
  const coordinatesAreValid = Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180

  if (!coordinatesAreValid) return res.status(400).json({ success: false, message: 'Valid coordinates are required' })

  try {
    const location = await reverseGeocodeLocation(latitude, longitude)
    return res.json({ success: true, location })
  } catch (error) {
    return res.status(502).json({ success: false, message: error instanceof Error ? error.message : 'Unable to identify your location' })
  }
})

// A location from the client is either plain text the person typed (needs geocoding)
// or an already-resolved coordinate from clicking a suggestion / "use my current
// location" (must be passed straight through - re-geocoding it risks matching a
// different, same-named place and throws away the precision we already had).
function isValidLocationInput(value) {
  if (typeof value === 'string') return Boolean(value.trim())
  if (value && typeof value === 'object') {
    return Number.isFinite(Number(value.latitude)) && Number.isFinite(Number(value.longitude))
  }
  return false
}

router.post('/', async (req, res) => {
  const { from, to } = req.body

  if (![from, to].every(isValidLocationInput)) {
    return res.status(400).json({ success: false, message: 'From and to locations are required' })
  }

  try {
    const route = await findRoute(from, to)
    const scoredRoutes = scoreRoutes(route.routes)
    const recommendedRoute = scoredRoutes.reduce((safest, candidate) => candidate.riskScore < safest.riskScore ? candidate : safest)
    return res.json({
      success: true,
      route: {
        ...route,
        routes: scoredRoutes,
        recommendedRouteId: recommendedRoute.routeId,
      },
    })
  } catch (error) {
    return res.status(502).json({ success: false, message: error instanceof Error ? error.message : 'Unable to calculate route' })
  }
})

module.exports = router