require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Initialize Africa's Talking SMS Gateway
const AfricasTalking = require('africastalking')({
  apiKey: process.env.AT_API_KEY || 'YOUR_SANDBOX_API_KEY',
  username: process.env.AT_USERNAME || 'sandbox'
});
const sms = AfricasTalking.SMS;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-Memory Hybrid Fallback Queues & Visit Trajectory History
let memoryReferrals = [];
let memoryVisitHistory = {}; // Structure: { ticketId/patientId: [ { visit: 'Visit 1', rbs: 15.5 }, ... ] }
let memoryTicketCounter = 100;

// Authentication Middleware with DEV Token Fallback
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // DEV Mode Pass-Through if header is missing during local dev
    req.user = { userId: 1, roleId: 3, name: 'Dev User' };
    return next();
  }

  if (token === 'DEV_TOKEN') {
    req.user = { userId: 1, roleId: 3, name: 'Dev User' };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      req.user = { userId: 1, roleId: 3, name: 'Dev User' };
      return next();
    }
    req.user = user;
    next();
  });
}

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('⚡ Client connected to Socket.io:', socket.id);
  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

// --- 1. AUTHENTICATION ROUTE ---
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;

  try {
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required' });
    }

    let roleId = 2; // Default HRIO
    if (phone.startsWith('073') || phone.startsWith('070')) {
      roleId = 3; // HCP
    } else if (phone.startsWith('071')) {
      roleId = 1; // CHP
    }

    const token = jwt.sign(
      { userId: 1, roleId, phone },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: {
        userId: 1,
        roleId,
        fullName: 'Test User'
      }
    });
  } catch (err) {
    console.error('❌ LOGIN ERROR:', err);
    res.status(500).json({ error: `Authentication error: ${err.message}` });
  }
});

// --- 2. GET PENDING REFERRALS (HRIO Workspace) ---
const handlePendingReferrals = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         rt.ticket_id, 
         rt.triage_id, 
         rt.facility_id, 
         rt.status, 
         rt.issued_at,
         p.patient_id,
         p.birth_certificate_no AS birth_cert_no,
         p.full_name, 
         p.age, 
         p.gender, 
         COALESCE(p.contact, '') AS contact,
         tl.rbs_value, 
         tl.risk_level
       FROM referral_tickets rt
       LEFT JOIN triage_logs tl ON rt.triage_id = tl.triage_id
       LEFT JOIN patients p ON tl.patient_id = p.patient_id
       WHERE LOWER(rt.status) = 'pending'
       ORDER BY rt.issued_at DESC`
    );

    const dbRows = result.rows || [];
    const memPending = memoryReferrals.filter(r => String(r.status).toLowerCase() === 'pending');
    const combined = [...dbRows, ...memPending];
    const uniqueList = Array.from(new Map(combined.map(item => [item.ticket_id, item])).values());

    res.json(uniqueList);
  } catch (err) {
    console.warn('⚠️ Database fetch failed for HRIO, serving memory fallback:', err.message);
    const memPending = memoryReferrals.filter(r => String(r.status).toLowerCase() === 'pending');
    res.json(memPending);
  }
};

app.get('/api/hrio/pending', authenticateToken, handlePendingReferrals);
app.get('/api/referrals/pending', authenticateToken, handlePendingReferrals);
app.get('/api/hrio/referrals', authenticateToken, handlePendingReferrals);

// --- 3. ACKNOWLEDGE TICKET (HRIO -> Forward to HCP Workspace) ---
const handleAcknowledge = async (req, res) => {
  const ticketId = req.params.id;
  let updatedTicket = null;

  try {
    const result = await db.query(
      `UPDATE referral_tickets 
       SET status = 'Acknowledged' 
       WHERE ticket_id = $1 
       RETURNING *`,
      [ticketId]
    );

    if (result.rows.length > 0) {
      updatedTicket = result.rows[0];
    }
  } catch (err) {
    console.warn('⚠️ DB update failed for acknowledge, processing memory queue fallback:', err.message);
  }

  // Update status in Memory Queue Fallback as well
  const memMatch = memoryReferrals.find(r => String(r.ticket_id) === String(ticketId));
  if (memMatch) {
    memMatch.status = 'Acknowledged';
    if (!updatedTicket) updatedTicket = memMatch;
  }

  if (!updatedTicket) {
    updatedTicket = { ticket_id: ticketId, status: 'Acknowledged' };
  }

  // Broadcast real-time Socket events to push directly to HCP Workspace
  io.emit('patient_referred_to_hcp', updatedTicket);
  io.emit('referral_acknowledged', updatedTicket);

  res.json({
    message: 'Ticket successfully acknowledged and forwarded to HCP workspace',
    ticket: updatedTicket
  });
};

app.put('/api/hrio/acknowledge/:id', authenticateToken, handleAcknowledge);
app.post('/api/hrio/acknowledge/:id', authenticateToken, handleAcknowledge);
app.patch('/api/hrio/referrals/:id/acknowledge', authenticateToken, handleAcknowledge);

// --- 4. GET HCP CLINICAL CASES QUEUE ---
const handleHCPCases = async (req, res) => {
  let dbRows = [];
  try {
    const result = await db.query(
      `SELECT 
         rt.ticket_id, 
         rt.triage_id, 
         rt.facility_id, 
         rt.status, 
         rt.issued_at AS referred_date,
         p.patient_id,
         p.birth_certificate_no AS birth_cert_no,
         p.full_name, 
         p.age, 
         p.gender, 
         COALESCE(p.contact, '') AS contact,
         tl.rbs_value, 
         tl.risk_level
       FROM referral_tickets rt
       LEFT JOIN triage_logs tl ON rt.triage_id = tl.triage_id
       LEFT JOIN patients p ON tl.patient_id = p.patient_id
       WHERE LOWER(rt.status) IN ('acknowledged', 'referred to hcp')
       ORDER BY rt.issued_at DESC`
    );
    dbRows = result.rows || [];
  } catch (err) {
    console.warn('⚠️ DB fetch error for HCP cases, building memory fallback:', err.message);
  }

  const memAck = memoryReferrals
    .filter(r => String(r.status).toLowerCase() === 'acknowledged' || String(r.status).toLowerCase() === 'referred to hcp')
    .map(t => ({
      ticket_id: t.ticket_id,
      patient_id: t.patient_id || t.ticket_id,
      birth_cert_no: t.birth_cert_no,
      full_name: t.full_name,
      age: t.age,
      gender: t.gender,
      contact: t.contact,
      rbs_value: t.rbs_value,
      risk_level: t.risk_level || 'High',
      status: 'Acknowledged',
      referred_date: t.issued_at ? new Date(t.issued_at).toLocaleString() : new Date().toLocaleString()
    }));

  const combined = [...dbRows, ...memAck];
  const uniqueHcpQueue = Array.from(new Map(combined.map(item => [item.ticket_id, item])).values());

  res.json(uniqueHcpQueue);
};

app.get('/api/hcp/cases', authenticateToken, handleHCPCases);
app.get('/api/hcp/queue', authenticateToken, handleHCPCases);

// --- 5. CHP TRIAGE SUBMISSION ---
app.post('/api/chp/triage', authenticateToken, async (req, res) => {
  const { birthCertNo, fullName, age, gender, contact, rbsValue, symptoms } = req.body;

  // STRICT SERVER-SIDE INPUT VALIDATION
  const birthCertRegex = /^[A-Za-z0-9\-]{5,20}$/;
  const nameRegex = /^[A-Za-z\s]{2,50}$/;
  const phoneRegex = /^(?:254|\+254|0)?(7|1)\d{8}$/;

  if (!birthCertNo || !birthCertRegex.test(birthCertNo.trim())) {
    return res.status(400).json({ error: 'Validation Error: Invalid Birth Certificate / ID format.' });
  }

  if (!fullName || !nameRegex.test(fullName.trim())) {
    return res.status(400).json({ error: 'Validation Error: Full Name must contain letters and spaces only.' });
  }

  if (!contact || !phoneRegex.test(contact.trim())) {
    return res.status(400).json({ error: 'Validation Error: Invalid Kenyan phone number format.' });
  }

  const parsedAge = parseInt(age, 10);
  if (isNaN(parsedAge) || parsedAge < 0 || parsedAge > 25) {
    return res.status(400).json({ error: 'Validation Error: Age must be between 0 and 25 years.' });
  }

  const parsedRbs = parseFloat(rbsValue);
  if (isNaN(parsedRbs) || parsedRbs < 1.0 || parsedRbs > 35.0) {
    return res.status(400).json({ error: 'Validation Error: RBS value must be between 1.0 and 35.0 mmol/L.' });
  }

  let riskLevel = 'Low';
  if (parsedRbs >= 11.1) {
    riskLevel = 'High';
  } else if (parsedRbs >= 7.0) {
    riskLevel = 'Moderate';
  }

  try {
    // 1. Patient Deduplication
    let patientRes = await db.query(
      `SELECT patient_id FROM patients WHERE birth_certificate_no = $1 OR contact = $2`,
      [birthCertNo.trim(), contact.trim()]
    );

    let patientId;
    if (patientRes.rows.length === 0) {
      const newPatient = await db.query(
        `INSERT INTO patients (birth_certificate_no, full_name, age, gender, contact)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING patient_id`,
        [birthCertNo.trim(), fullName.trim(), parsedAge, gender, contact.trim()]
      );
      patientId = newPatient.rows[0].patient_id;
    } else {
      patientId = patientRes.rows[0].patient_id;
    }

    // 2. Persist Triage Entry
    const triageRes = await db.query(
      `INSERT INTO triage_logs (patient_id, rbs_value, risk_level, symptoms, chp_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING triage_id`,
      [patientId, parsedRbs, riskLevel, JSON.stringify(symptoms || []), req.user.userId || 1]
    );
    const triageId = triageRes.rows[0].triage_id;

    // 3. High-Risk Workflow
    if (riskLevel === 'High') {
      const ticketRes = await db.query(
        `INSERT INTO referral_tickets (triage_id, status)
         VALUES ($1, 'Pending')
         RETURNING *`,
        [triageId]
      );
      const ticket = ticketRes.rows[0];

      // Track baseline visit trajectory
      memoryVisitHistory[ticket.ticket_id] = [
        { visit: 'Visit 1 (CHP Triage)', rbs: parsedRbs, date: new Date().toLocaleDateString() }
      ];

      // WebSockets Broadcast
      io.emit('new_referral', ticket);
      io.emit('high_risk_alert', {
        ticketId: ticket.ticket_id,
        fullName: fullName.trim(),
        rbsValue: parsedRbs
      });

      // SMS Dispatch
      let formattedPhone = contact.trim();
      if (formattedPhone.startsWith('0')) formattedPhone = '+254' + formattedPhone.substring(1);
      else if (!formattedPhone.startsWith('+')) formattedPhone = '+254' + formattedPhone;

      const smsMessage = `ALERT: Dear ${fullName.trim()} (ID: ${birthCertNo.trim()}), your T1D screening with the CHP indicates high blood sugar (${parsedRbs} mmol/L). An urgent clinical appointment has been scheduled at the county hospital. Please present to the lab/pediatric clinic immediately.`;

      try {
        await sms.send({ to: [formattedPhone], message: smsMessage });
        console.log(`📲 SMS sent to ${formattedPhone}`);
      } catch (smsErr) {
        console.error('❌ SMS error:', smsErr.message);
      }
    }

    res.status(201).json({ message: 'Triage logged successfully', triageId, riskLevel });

  } catch (err) {
    console.warn('⚠️ DB Error during triage, using fallback storage:', err.message);

    memoryTicketCounter++;
    const tId = memoryTicketCounter;
    const fallbackRecord = {
      ticket_id: tId,
      patient_id: tId,
      birth_cert_no: birthCertNo.trim(),
      full_name: fullName.trim(),
      age: parsedAge,
      gender,
      contact: contact.trim(),
      rbs_value: parsedRbs,
      risk_level: riskLevel,
      status: riskLevel === 'High' ? 'Pending' : 'Standard',
      issued_at: new Date().toISOString()
    };

    if (riskLevel === 'High') {
      memoryReferrals.unshift(fallbackRecord);
      memoryVisitHistory[tId] = [
        { visit: 'Visit 1 (CHP Triage)', rbs: parsedRbs, date: new Date().toLocaleDateString() }
      ];
      io.emit('new_referral', fallbackRecord);
    }

    res.status(201).json({ message: 'Triage logged (Memory Fallback)', riskLevel });
  }
});

// --- 6. SCHEDULE FOLLOW-UP VISITS & RECORD VISITS (HCP Workspace) ---
const handleScheduleFollowup = async (req, res) => {
  const { patientId, ticketId, nextReviewDate, scheduledDate, targetRbs, targetGlycemic, newRbs, clinicalNotes } = req.body;
  const hcpId = req.user.userId || 1;
  const activeId = String(ticketId || patientId || '').replace('#', '');
  const rbsVal = newRbs ? parseFloat(newRbs) : parseFloat(targetRbs || targetGlycemic || 7.0);
  const dateVal = scheduledDate || nextReviewDate || new Date().toISOString().split('T')[0];

  try {
    if (patientId) {
      await db.query(
        `INSERT INTO follow_up_appointments (patient_id, hcp_id, scheduled_date, target_rbs, clinical_notes) 
         VALUES ($1, $2, $3, $4, $5)`,
        [patientId, hcpId, dateVal, rbsVal, clinicalNotes || '']
      );
    }
  } catch (err) {
    console.warn('⚠️ DB insert error for followup:', err.message);
  }

  // Record into Trajectory History for Chart rendering
  if (activeId) {
    if (!memoryVisitHistory[activeId]) {
      memoryVisitHistory[activeId] = [
        { visit: 'Visit 1 (CHP Triage)', rbs: 13.0, date: 'Baseline' }
      ];
    }

    const visitNum = memoryVisitHistory[activeId].length + 1;
    const label = newRbs ? `Visit ${visitNum} (Tested)` : `Visit ${visitNum} (Target)`;
    
    memoryVisitHistory[activeId].push({
      visit: label,
      rbs: rbsVal,
      date: dateVal,
      notes: clinicalNotes || ''
    });
  }

  res.json({
    message: 'Follow-up review scheduled successfully',
    history: memoryVisitHistory[activeId] || []
  });
};

app.post('/api/hcp/schedule-followup', authenticateToken, handleScheduleFollowup);
app.post('/api/hcp/progress-visit', authenticateToken, handleScheduleFollowup);

// --- 7. PATIENT APPOINTMENT & VISITS HISTORY ---
const handlePatientHistory = async (req, res) => {
  const rawId = req.params.patientId || req.params.ticketId;
  const activeId = String(rawId).replace('#', '');

  let historyRows = [];
  try {
    // Fixed: Standardized to u.username or fallback to prevent 'column u.full_name does not exist' error
    const history = await db.query(
      `SELECT f.*, COALESCE(u.username, 'Attending HCP') as doctor_name 
       FROM follow_up_appointments f
       LEFT JOIN users u ON f.hcp_id = u.user_id
       WHERE f.patient_id = $1 
       ORDER BY f.scheduled_date DESC`,
      [activeId]
    );
    historyRows = history.rows || [];
  } catch (err) {
    // If the follow_up_appointments table or user join fails, fallback gracefully without spamming terminal
    try {
      const fallbackHistory = await db.query(
        `SELECT * FROM follow_up_appointments WHERE patient_id = $1 ORDER BY scheduled_date DESC`,
        [activeId]
      );
      historyRows = fallbackHistory.rows || [];
    } catch (innerErr) {
      // Quiet fallback to memory array
    }
  }

  // Merge with trajectory history if available
  const trajectoryHistory = memoryVisitHistory[activeId] || [];
  if (historyRows.length === 0 && trajectoryHistory.length > 0) {
    return res.json(trajectoryHistory);
  }

  res.json(historyRows);
};

app.get('/api/hcp/patient-history/:patientId', authenticateToken, handlePatientHistory);
app.get('/api/hcp/patient-history/:ticketId', authenticateToken, handlePatientHistory);

// Start Server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});