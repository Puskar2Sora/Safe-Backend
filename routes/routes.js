const express = require('express')
const { findRoute } = require('../services/routingService')
const { scoreRoutes } = require('../services/safetyScoringService')

const router = express.Router()

router.post('/', async (req, res) => {
  const { from, to } = req.body

  if (![from, to].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'From and to locations are required' })
  }

  try {
    const route = await findRoute(from.trim(), to.trim())
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