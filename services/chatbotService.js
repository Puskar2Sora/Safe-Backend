const documents = require('../data/chatbotDocuments.json')

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'for', 'how', 'i', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'or', 'the', 'to', 'what', 'where', 'with', 'you',
])

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .match(/[a-z0-9]+/g)?.filter((token) => !stopWords.has(token)) || []
}

function buildVector(tokens) {
  const vector = new Map()
  for (const token of tokens) vector.set(token, (vector.get(token) || 0) + 1)
  return vector
}

function cosineSimilarity(left, right) {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (const value of left.values()) leftMagnitude += value * value
  for (const value of right.values()) rightMagnitude += value * value
  for (const [token, value] of left) dot += value * (right.get(token) || 0)
  return leftMagnitude && rightMagnitude ? dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)) : 0
}

const indexedDocuments = documents.map((document) => {
  const content = `${document.title} ${document.category} ${document.content} ${document.keywords.join(' ')}`
  return { ...document, vector: buildVector(tokenize(content)) }
})

function searchDocuments(query, limit = 3) {
  const queryVector = buildVector(tokenize(query))
  return indexedDocuments
    .map((document) => ({ document, score: cosineSimilarity(queryVector, document.vector) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ document, score }) => ({
      id: document.id,
      title: document.title,
      category: document.category,
      content: document.content,
      score: Number(score.toFixed(3)),
    }))
}

function answerQuestion(question) {
  const sources = searchDocuments(question)
  if (!sources.length) {
    return {
      answer: 'I could not find that in the safety help guide. Try asking about journeys, SOS, trusted contacts, Safe Circle, incident reports, or account privacy.',
      sources: [],
    }
  }

  return {
    answer: sources.map((source) => source.content).join(' '),
    sources: sources.map(({ id, title, category, score }) => ({ id, title, category, score })),
  }
}

function listDocuments() {
  return indexedDocuments.map(({ id, title, category, content, keywords }) => ({ id, title, category, content, keywords }))
}

async function buildAccountContext(userId) {
  const { getDb } = require('../config/db')
  const db = getDb()
  const [user, contacts, journeys, incidents, emergencies, circles, sharedJourneyShares] = await Promise.all([
    db.collection('users').findOne({ id: userId }, { projection: { _id: 0, password: 0, passwordHash: 0 } }),
    db.collection('contacts').find({ userId }, { projection: { _id: 0 } }).toArray(),
    db.collection('journeys').find({ userId }, { projection: { _id: 0 } }).sort({ startTime: -1 }).limit(20).toArray(),
    db.collection('incidents').find({ userId }, { projection: { _id: 0 } }).sort({ date: -1 }).limit(20).toArray(),
    db.collection('emergencies').find({ userId }, { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(20).toArray(),
    db.collection('safeCircleMembers').find({ userId, status: 'ACTIVE' }, { projection: { _id: 0 } }).toArray(),
    db.collection('journeyShares').find({
      trustedContactUserId: userId,
      status: 'ACTIVE',
      $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date().toISOString() } }],
    }, { projection: { _id: 0, journeyId: 1, permissions: 1, ownerUserId: 1, expiresAt: 1 } }).toArray(),
  ])

  const sharedJourneyIds = sharedJourneyShares.map((share) => share.journeyId)
  const sharedJourneys = sharedJourneyIds.length
    ? await db.collection('journeys').find({ id: { $in: sharedJourneyIds } }, { projection: { _id: 0, userId: 0 } }).toArray()
    : []
  const circleIds = circles.map((circle) => circle.circleId)
  const circleDetails = circleIds.length
    ? await db.collection('safeCircles').find({ id: { $in: circleIds } }, { projection: { _id: 0, creatorId: 0 } }).toArray()
    : []

  return { user, contacts, journeys, sharedJourneys, sharedJourneyShares, incidents, emergencies, circles: circleDetails }
}

function detectAction(question) {
  const normalized = question.toLowerCase()
  if (/\b(send|trigger|activate)\b.*\b(sos|emergency|alert)\b/.test(normalized)) {
    return { type: 'ACTIVATE_SOS', label: 'Activate SOS', requiresConfirmation: true }
  }
  if (/\b(start|begin|create)\b.*\b(journey|trip)\b/.test(normalized)) {
    return { type: 'START_JOURNEY', label: 'Start a journey', requiresConfirmation: true }
  }
  return null
}

async function answerWithAccount(question, userId) {
  const sources = searchDocuments(question)
  const accountContext = await buildAccountContext(userId)
  const proposedAction = detectAction(question)
  const ollamaUrl = `${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/chat`
  const prompt = [
    'You are the private safety assistant for the Women’s Safety Platform.',
    'Answer only from the supplied help sources and authenticated account context.',
    'Never invent account facts. Say when information is unavailable. Never reveal data for another account.',
    'Be concise, supportive, and clear. For emergencies, advise contacting local emergency services.',
    `Help sources:\n${JSON.stringify(sources)}`,
    `Authenticated account context:\n${JSON.stringify(accountContext)}`,
    `User question: ${question}`,
  ].join('\n\n')

  try {
    const response = await fetch(ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
        stream: false,
        messages: [
          { role: 'system', content: 'You are a privacy-preserving website assistant.' },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0.2 },
      }),
    })
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`)
    const result = await response.json()
    if (typeof result.message?.content !== 'string' || !result.message.content.trim()) throw new Error('Ollama returned an empty answer')
    return { answer: result.message.content.trim(), sources: sources.map(({ id, title, category, score }) => ({ id, title, category, score })), proposedAction }
  } catch (error) {
    const fallback = answerQuestion(question)
    return {
      ...fallback,
      warning: 'The local model is unavailable, so this answer uses the built-in help guide. Start Ollama and pull the configured model for account-aware answers.',
      proposedAction,
    }
  }
}

module.exports = { answerQuestion, answerWithAccount, listDocuments, searchDocuments }
