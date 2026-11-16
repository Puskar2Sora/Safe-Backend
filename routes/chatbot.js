// backend/routes/chatbot.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { answerWithAccount } = require('../services/chatbotService');

// Adjust this import to match the exact filename inside your backend/config/ folder (e.g., './db' or './database')
const dbConfig = require('../config/db'); 

// Optional: Require auth middleware if your route uses JWT verification to set req.user
let authMiddleware = (req, res, next) => next();
try {
  const auth = require('../middleware/auth');
  authMiddleware = typeof auth === 'function' ? auth : (auth.protect || auth.authenticate || authMiddleware);
} catch (e) {
  // Fallback if auth middleware has a different export signature
}

/**
 * Helper to resolve the active MongoDB database instance regardless of how config/db exports it
 */
async function getDatabase() {
  if (typeof dbConfig.getDb === 'function') return await dbConfig.getDb();
  if (typeof dbConfig.connectDB === 'function') return await dbConfig.connectDB();
  if (typeof dbConfig === 'function') return await dbConfig();
  return dbConfig.db || dbConfig;
}

/**
 * POST /api/chatbot/query
 * Fetches complete MongoDB records for the currently logged-in user and queries Ollama
 */
router.post('/query', authMiddleware, async (req, res) => {
  try {
    const { question, userContext = {}, history = [] } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Extract userId from auth token (req.user) or frontend userContext payload
    const rawUserId =
      req.user?.id ||
      req.user?._id ||
      userContext?.user?._id ||
      userContext?.user?.id ||
      userContext?._id ||
      userContext?.id;

    let fullAccountContext = { ...userContext };

    if (rawUserId) {
      const db = await getDatabase();
      const idStr = String(rawUserId);
      const idFilter = ObjectId.isValid(idStr)
        ? { $in: [idStr, new ObjectId(idStr)] }
        : idStr;

      // Query all platform collections in parallel for the current user
      const [userDoc, journeys, safeCircles, contacts, emergencies, incidents] = await Promise.all([
        db.collection('users')
          .findOne({ _id: ObjectId.isValid(idStr) ? new ObjectId(idStr) : idStr }, { projection: { password: 0, passwordHash: 0 } })
          .catch(() => null),
        db.collection('journeys')
          .find({ $or: [{ userId: idFilter }, { user: idFilter }] })
          .sort({ createdAt: -1 })
          .limit(15)
          .toArray()
          .catch(() => []),
        db.collection('safeCircles')
          .find({ $or: [{ ownerId: idFilter }, { userId: idFilter }, { members: idFilter }, { 'members.userId': idFilter }] })
          .toArray()
          .catch(() => []),
        db.collection('contacts')
          .find({ $or: [{ userId: idFilter }, { user: idFilter }] })
          .toArray()
          .catch(() => []),
        db.collection('emergencies')
          .find({ $or: [{ userId: idFilter }, { user: idFilter }] })
          .sort({ createdAt: -1 })
          .limit(10)
          .toArray()
          .catch(() => []),
        db.collection('incidents')
          .find({ $or: [{ userId: idFilter }, { user: idFilter }, { reportedBy: idFilter }] })
          .sort({ createdAt: -1 })
          .limit(10)
          .toArray()
          .catch(() => []),
      ]);

      fullAccountContext = {
        ...fullAccountContext,
        profile: userDoc || fullAccountContext.user || {},
        journeys,
        safeCircles,
        trustedContacts: contacts,
        emergencies,
        incidents,
      };
    }

    const result = await answerWithAccount(question, fullAccountContext, history);
    return res.json(result);

  } catch (error) {
    console.error('❌ Chatbot Route MongoDB Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to process account-aware query' });
  }
});

module.exports = router;