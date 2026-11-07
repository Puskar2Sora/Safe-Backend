const buckets = new Map()

function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${req.path}`
    const now = Date.now()
    const current = buckets.get(key)
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs }

    bucket.count += 1
    buckets.set(key, bucket)

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)))
      return res.status(429).json({ success: false, message })
    }

    return next()
  }
}

function clearRateLimitBuckets() {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

const cleanupTimer = setInterval(clearRateLimitBuckets, 60 * 1000)
cleanupTimer.unref()

module.exports = { rateLimit }
