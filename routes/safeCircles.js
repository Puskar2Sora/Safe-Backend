const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const dataDirectory = path.join(__dirname, '..', 'data');
const circlesFile = path.join(dataDirectory, 'safeCircles.json');
const membersFile = path.join(dataDirectory, 'safeCircleMembers.json');
const requestsFile = path.join(dataDirectory, 'safeCircleRequests.json');
const usersFile = path.join(dataDirectory, 'users.json');
const earthRadius = 6371000;

// Helper utilities for JSON read/write safety
function read(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function save(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function distanceBetween(aLat, aLon, bLat, bLon) {
  const lat = ((bLat - aLat) * Math.PI) / 180;
  const lon = ((bLon - aLon) * Math.PI) / 180;
  const value =
    Math.sin(lat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(lon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function expireCircles() {
  const now = Date.now();
  const circles = read(circlesFile);
  let changed = false;
  circles.forEach((circle) => {
    if (circle.status === 'ACTIVE' && new Date(circle.expiresAt).getTime() <= now) {
      circle.status = 'EXPIRED';
      changed = true;
    }
  });
  if (changed) save(circlesFile, circles);
  return circles;
}

function ownerCircle(circleId, userId) {
  return expireCircles().find(
    (circle) => circle.id === circleId && circle.creatorId === userId
  );
}

function publicCircle(circle, members, requests, distance, userId) {
  const activeMembers = members.filter(
    (member) => member.circleId === circle.id && member.status === 'ACTIVE'
  );
  const isMember = activeMembers.some((member) => member.userId === userId);
  const isPending = requests.some(
    (req) => req.circleId === circle.id && req.userId === userId && req.status === 'PENDING'
  );

  return {
    id: circle.id,
    name: circle.name,
    status: circle.status,
    maxMembers: circle.maxMembers,
    memberCount: activeMembers.length,
    distanceMeters: Math.round(distance),
    userStatus: isMember ? 'MEMBER' : isPending ? 'PENDING' : 'NONE',
  };
}

// 1. Create a Safe Circle
router.post('/', (req, res) => {
  const { creatorId, name, maxMembers = 5, expiresInMinutes = 60 } = req.body;
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);

  if (!creatorId || !name?.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({
      success: false,
      message: 'Creator, name, and current location are required',
    });
  }

  if (maxMembers < 2 || maxMembers > 20) {
    return res.status(400).json({
      success: false,
      message: 'Maximum members must be between 2 and 20',
    });
  }

  const now = new Date();
  const circle = {
    id: crypto.randomUUID(),
    creatorId,
    name: name.trim(),
    status: 'ACTIVE',
    maxMembers: Number(maxMembers),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Number(expiresInMinutes) * 60000).toISOString(),
    latitude,
    longitude,
  };

  const circles = read(circlesFile);
  circles.push(circle);
  save(circlesFile, circles);

  const members = read(membersFile);
  members.push({
    id: crypto.randomUUID(),
    circleId: circle.id,
    userId: creatorId,
    status: 'ACTIVE',
    joinedAt: now.toISOString(),
    leftAt: null,
  });
  save(membersFile, members);

  return res.status(201).json({ success: true, circle });
});

// 2. Discover Nearby Circles
router.get('/nearby', (req, res) => {
  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);
  const radius = Number(req.query.radius || 5000);
  const userId = req.query.userId || '';

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ success: false, message: 'Current location is required' });
  }

  const members = read(membersFile);
  const requests = read(requestsFile);

  const circles = expireCircles()
    .filter((circle) => circle.status === 'ACTIVE')
    .map((circle) => {
      const creator = read(usersFile).find((user) => user.id === circle.creatorId);
      if (!creator || !Number.isFinite(circle.latitude) || !Number.isFinite(circle.longitude)) {
        return null;
      }
      return publicCircle(
        circle,
        members,
        requests,
        distanceBetween(latitude, longitude, circle.latitude, circle.longitude),
        userId
      );
    })
    .filter(Boolean)
    .filter((circle) => circle.distanceMeters <= radius);

  return res.json({ success: true, circles });
});

// 3. Get Specific Active Circle Details
router.get('/:id', (req, res) => {
  const userId = req.query.userId;
  const circle = expireCircles().find((candidate) => candidate.id === req.params.id);
  const member = read(membersFile).find(
    (candidate) => candidate.circleId === req.params.id && candidate.userId === userId && candidate.status === 'ACTIVE'
  );

  if (!circle || !member) {
    return res.status(403).json({ success: false, message: 'You are not an active member of this circle' });
  }

  return res.json({
    success: true,
    circle: {
      ...circle,
      members: read(membersFile)
        .filter((candidate) => candidate.circleId === circle.id && candidate.status === 'ACTIVE')
        .map((candidate) => ({ userId: candidate.userId, joinedAt: candidate.joinedAt })),
    },
  });
});

// 4. View Pending Join Requests (Circle Owner Only)
router.get('/:id/requests', (req, res) => {
  const circle = ownerCircle(req.params.id, req.query.creatorId);
  if (!circle) {
    return res.status(403).json({ success: false, message: 'Only the circle creator can view requests' });
  }
  return res.json({
    success: true,
    requests: read(requestsFile).filter(
      (request) => request.circleId === circle.id && request.status === 'PENDING'
    ),
  });
});

// 5. Send Join Request
router.post('/:id/request', (req, res) => {
  const { userId } = req.body;
  const circle = expireCircles().find(
    (candidate) => candidate.id === req.params.id && candidate.status === 'ACTIVE'
  );
  const members = read(membersFile);
  const requests = read(requestsFile);

  if (!circle) {
    return res.status(400).json({ success: false, message: 'Circle is expired or inactive' });
  }
  if (members.some((member) => member.circleId === circle.id && member.userId === userId && member.status === 'ACTIVE')) {
    return res.status(409).json({ success: false, message: 'You are already a member' });
  }
  if (members.filter((member) => member.circleId === circle.id && member.status === 'ACTIVE').length >= circle.maxMembers) {
    return res.status(409).json({ success: false, message: 'This circle is full' });
  }
  if (requests.some((request) => request.circleId === circle.id && request.userId === userId && request.status === 'PENDING')) {
    return res.status(409).json({ success: false, message: 'Join request already sent' });
  }

  const request = {
    id: crypto.randomUUID(),
    circleId: circle.id,
    userId,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  };

  requests.push(request);
  save(requestsFile, requests);
  return res.status(201).json({ success: true, message: 'Join request sent', request });
});

// 6. Accept / Reject Join Request
router.patch('/:id/requests/:requestId', (req, res) => {
  const { creatorId, decision } = req.body;
  const circle = ownerCircle(req.params.id, creatorId);
  const requests = read(requestsFile);
  const request = requests.find(
    (candidate) => candidate.id === req.params.requestId && candidate.circleId === req.params.id && candidate.status === 'PENDING'
  );

  if (!circle) {
    return res.status(403).json({ success: false, message: 'Only the circle creator can decide requests' });
  }
  if (!request || !['ACCEPTED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ success: false, message: 'Invalid join request' });
  }

  request.status = decision;
  if (decision === 'ACCEPTED') {
    const members = read(membersFile);
    if (members.filter((member) => member.circleId === circle.id && member.status === 'ACTIVE').length >= circle.maxMembers) {
      return res.status(409).json({ success: false, message: 'This circle is full' });
    }
    members.push({
      id: crypto.randomUUID(),
      circleId: circle.id,
      userId: request.userId,
      status: 'ACTIVE',
      joinedAt: new Date().toISOString(),
      leftAt: null,
    });
    save(membersFile, members);
  }

  save(requestsFile, requests);
  return res.json({ success: true, request });
});

// 7. Leave Circle
router.post('/:id/leave', (req, res) => {
  const { userId } = req.body;
  const members = read(membersFile);
  const member = members.find(
    (candidate) => candidate.circleId === req.params.id && candidate.userId === userId && candidate.status === 'ACTIVE'
  );

  if (!member) {
    return res.status(403).json({ success: false, message: 'You are not an active member' });
  }

  member.status = 'LEFT';
  member.leftAt = new Date().toISOString();
  save(membersFile, members);
  return res.json({ success: true });
});

// 8. End Circle (Creator Only)
router.patch('/:id/end', (req, res) => {
  const circles = expireCircles();
  const circle = circles.find(
    (candidate) => candidate.id === req.params.id && candidate.creatorId === req.body.creatorId && candidate.status === 'ACTIVE'
  );

  if (!circle) {
    return res.status(403).json({ success: false, message: 'Only the circle creator can end it' });
  }

  circle.status = 'ENDED';
  save(circlesFile, circles);
  return res.json({ success: true, circle });
});

module.exports = router;