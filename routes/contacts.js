const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../config/db')
const { requireUserId } = require('../middleware/auth')

const router = express.Router()
const contacts = () => getDb().collection('contacts')

router.post('/', async (req, res) => {
  const { name, phone, relationship } = req.body
  if (![name, phone, relationship].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Name, phone, and relationship are required' })
  }
  const contact = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    name: name.trim(),
    phone: phone.trim(),
    relationship: relationship.trim(),
    createdAt: new Date(),
  }
  await contacts().insertOne(contact)
  const { _id, ...responseContact } = contact
  return res.status(201).json({ success: true, contact: responseContact })
})

router.get('/:userId', requireUserId, async (req, res) => {
  const results = await contacts().find({ userId: req.user.id }, { projection: { _id: 0 } }).toArray()
  return res.json({ success: true, contacts: results })
})

router.delete('/:id', async (req, res) => {
  const result = await contacts().deleteOne({ id: req.params.id, userId: req.user.id })
  if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Contact not found' })
  return res.json({ success: true, message: 'Contact deleted' })
})

module.exports = router
