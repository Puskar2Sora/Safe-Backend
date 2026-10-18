const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildTrafficSegments, buildGoogleTrafficSegments, decodeGooglePolyline, estimateTrafficLevel } = require('../services/routingService')

test('traffic segments preserve route geometry and classify estimated conditions', () => {
  const coordinates = [[22.5, 88.3], [22.51, 88.31], [22.52, 88.32]]
  const segments = buildTrafficSegments(coordinates, [], 'estimated')

  assert.equal(segments.length, 2)
  assert.deepEqual(segments[0].coordinates, [coordinates[0], coordinates[1]])
  assert.ok(['LOW', 'MODERATE', 'HIGH', 'SEVERE'].includes(segments[0].trafficLevel))
})

test('Mapbox congestion annotations map to normalized traffic levels', () => {
  const coordinates = [[22.5, 88.3], [22.51, 88.31], [22.52, 88.32]]
  const segments = buildTrafficSegments(coordinates, ['heavy', 'severe'], 'mapbox')

  assert.deepEqual(segments.map((segment) => segment.trafficLevel), ['HIGH', 'SEVERE'])
})

test('Mapbox routes without usable annotations use visible estimated segments', () => {
  const coordinates = [[22.5, 88.3], [22.51, 88.31], [22.52, 88.32], [22.53, 88.33]]
  const segments = buildTrafficSegments(coordinates, ['unknown', null], 'mapbox')

  assert.ok(segments.some((segment) => segment.trafficLevel !== 'LOW'))
})

test('estimated traffic changes predictably with time of day', () => {
  assert.equal(estimateTrafficLevel(new Date(2025, 0, 1, 2), 1), 'LOW')
  assert.equal(estimateTrafficLevel(new Date(2025, 0, 1, 8), 0), 'SEVERE')
})

test('Google traffic intervals decode and map to colored route segments', () => {
  const coordinates = decodeGooglePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
  const segments = buildGoogleTrafficSegments(coordinates, {
    travelAdvisory: {
      speedReadingIntervals: [
        { startPolylinePointIndex: 0, endPolylinePointIndex: 1, speed: 'NORMAL' },
        { startPolylinePointIndex: 1, endPolylinePointIndex: 2, speed: 'SLOW' },
      ],
    },
  })

  assert.equal(coordinates.length, 3)
  assert.deepEqual(segments.map((segment) => segment.trafficLevel), ['LOW', 'MODERATE'])
})
