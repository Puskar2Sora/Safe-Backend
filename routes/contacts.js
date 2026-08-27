const crypto = require('crypto')
const express = require('express')
const fs = require('fs')
const path = require('path')

const router = express.Router()
const contactsFile = path.join(__dirname, '..', 'data', 'contacts.json')

function readContacts() {
  return JSON.parse(fs.readFileSync(contactsFile, 'utf8'))
}

function saveContacts(contacts) {
  fs.writeFileSync(contactsFile, `${JSON.stringify(contacts, null, 2)}\n`)
}

router.post('/', (req, res) => {
  const { userId, name, phone, relationship } = req.body

  if (![userId, name, phone, relationship].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'User ID, name, phone, and relationship are required' })
  }

  const contacts = readContacts()
  const contact = {
    id: crypto.randomUUID(),
    userId: userId.trim(),
    name: name.trim(),
    phone: phone.trim(),
    relationship: relationship.trim(),
  }

  contacts.push(contact)
  saveContacts(contacts)

  return res.status(201).json({ success: true, contact })
})

router.get('/:userId', (req, res) => {
  const contacts = readContacts().filter((contact) => contact.userId === req.params.userId)
  return res.json({ success: true, contacts })
})

router.delete('/:id', (req, res) => {
  const contacts = readContacts()
  const remainingContacts = contacts.filter((contact) => contact.id !== req.params.id)

  if (remainingContacts.length === contacts.length) {
    return res.status(404).json({ success: false, message: 'Contact not found' })
  }

  saveContacts(remainingContacts)
  return res.json({ success: true, message: 'Contact deleted' })
})

module.exports = router