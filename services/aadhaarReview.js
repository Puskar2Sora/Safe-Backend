const crypto = require('crypto')

function createRequestId() {
  return crypto.randomUUID()
}

function normalizeResult(result, requestId) {
  const allowedStatuses = ['PASSED', 'REVIEW_REQUIRED', 'FAILED']
  const status = allowedStatuses.includes(result?.status) ? result.status : 'REVIEW_REQUIRED'
  return {
    status,
    provider: String(result?.provider || 'provider-neutral-hook'),
    requestId,
    receivedAt: new Date(),
    extracted: {
      name: typeof result?.extracted?.name === 'string' ? result.extracted.name : null,
      dateOfBirth: typeof result?.extracted?.dateOfBirth === 'string' ? result.extracted.dateOfBirth : null,
    },
    documentQuality: result?.documentQuality === 'PASS' || result?.documentQuality === 'FAIL' ? result.documentQuality : 'REVIEW_REQUIRED',
    consistency: result?.consistency === 'MATCH' || result?.consistency === 'MISMATCH' ? result.consistency : 'REVIEW_REQUIRED',
    femaleEligibilitySignal: result?.femaleEligibilitySignal === 'LIKELY_FEMALE' || result?.femaleEligibilitySignal === 'NOT_CONFIRMED'
      ? result.femaleEligibilitySignal
      : 'NOT_CONFIRMED',
    reason: typeof result?.reason === 'string' ? result.reason.slice(0, 500) : 'Manual administrator review is required.',
  }
}

async function reviewAadhaarDocument({ buffer, mimetype, submittedName, submittedDateOfBirth, submittedGender }) {
  const endpoint = process.env.AADHAAR_AI_REVIEW_URL
  const requestId = createRequestId()

  if (!endpoint) {
    return {
      status: 'REVIEW_REQUIRED',
      provider: 'provider-neutral-hook',
      requestId,
      receivedAt: new Date(),
      extracted: { name: null, dateOfBirth: null },
      documentQuality: 'REVIEW_REQUIRED',
      consistency: 'REVIEW_REQUIRED',
      femaleEligibilitySignal: 'NOT_CONFIRMED',
      reason: 'No Aadhaar AI provider is configured. Administrator review is required.',
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.AADHAAR_AI_REVIEW_API_KEY ? { Authorization: `Bearer ${process.env.AADHAAR_AI_REVIEW_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        requestId,
        document: { contentBase64: buffer.toString('base64'), mimeType: mimetype },
        submitted: { name: submittedName, dateOfBirth: submittedDateOfBirth, gender: submittedGender },
        requestedChecks: ['extract_identity_fields', 'document_quality', 'document_consistency', 'female_eligibility_signal'],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Aadhaar AI provider returned HTTP ${response.status}`)
    const result = await response.json()
    return normalizeResult(result, requestId)
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = { reviewAadhaarDocument }
