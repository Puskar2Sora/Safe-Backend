const crypto = require('crypto')
const express = require('express')
const fs = require('fs')
const path = require('path')

const router = express.Router()
const usersFile = path.join(__dirname, '..', 'data', 'users.json')

function readUsers() {
  return JSON.parse(fs.readFileSync(usersFile, 'utf8'))
}

function saveUsers(users) {
  fs.writeFileSync(usersFile, `${JSON.stringify(users, null, 2)}\n`)
}

router.post('/register', (req, res) => {
  const { name, email, password, phone } = req.body

  if (![name, email, password, phone].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Name, email, password, and phone are required' })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const users = readUsers()

  if (users.some((user) => user.email === normalizedEmail)) {
    return res.status(409).json({ success: false, message: 'An account with this email already exists' })
  }

  const user = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: normalizedEmail,
    password: password.trim(),
    phone: phone.trim(),
  }

  users.push(user)
  saveUsers(users)

  return res.status(201).json({
    success: true,
    message: 'Registration successful',
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
  })
})

router.post('/login', (req, res) => {
  const { email, password } = req.body

  if (![email, password].every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Email and password are required' })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const user = readUsers().find((candidate) => candidate.email === normalizedEmail && candidate.password === password)

  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' })
  }

  return res.json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email },
  })
})

module.exports = router