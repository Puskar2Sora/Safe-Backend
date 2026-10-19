const express = require('express')
const { answerWithAccount, listDocuments } = require('../services/chatbotService')

const router = express.Router()

router.get('/documents', (req, res) => {
  return res.json({ success: true, documents: listDocuments() })
})

router.post('/query', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
  if (!question) return res.status(400).json({ success: false, message: 'A question is required' })
  if (question.length > 500) return res.status(400).json({ success: false, message: 'Question must be 500 characters or fewer' })

  try {
    return res.json({ success: true, question, ...(await answerWithAccount(question, req.user.id)) })
  } catch (error) {
    return res.status(502).json({ success: false, message: error instanceof Error ? error.message : 'Unable to answer the question' })
  }
})

module.exports = router
