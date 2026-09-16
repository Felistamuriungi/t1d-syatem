const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { evaluateRisk } = require('./cdssEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'default_fallback_secret';

// JWT Middleware to Verify User Token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// 1. Health Check
app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.json({ status: 'Server Operational', dbConnected: true, timestamp: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'Database Connection Error', error: err.message });
  }
});

// 2. User Registration
app.post('/api/auth/register', async (req, res) => {
  const { name, phoneNumber, password, roleId, facilityId } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const queryText = `
      INSERT INTO users (name, phone_number, password_hash, role_id, facility_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING user_id, name, phone_number, role_id;
    `;
    const result = await db.query(queryText, [name, phoneNumber, passwordHash, roleId, facilityId || null]);
    res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to register user', details: err.message });
  }
});

// 3. User Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { phoneNumber, password } = req.body;

  try {
    const userQuery = `SELECT * FROM users WHERE phone_number = $1`;
    const result = await db.query(userQuery, [phoneNumber]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid phone number or password.' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid phone number or password.' });
    }

    const token = jwt.sign(
      { userId: user.user_id, roleId: user.role_id, facilityId: user.facility_id },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        userId: user.user_id,
        name: user.name,
        roleId: user.role_id,
        facilityId: user.facility_id
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

// 4. Complete Triage Submission (UPDATED)
app.post('/api/triage', async (req, res) => {
  const { fullName, age, gender, contact, chpId, facilityId, polyuria, polydipsia, weightLoss, rbsValue } = req.body;

  try {
    const cdssResult = evaluateRisk(rbsValue, polyuria, polydipsia, weightLoss);

    // Insert Patient
    const patientQuery = `INSERT INTO patients (full_name, age, gender, contact) VALUES ($1, $2, $3, $4) RETURNING patient_id;`;
    const patientResult = await db.query(patientQuery, [fullName, age, gender, contact]);
    const patientId = patientResult.rows[0].patient_id;

    // Safely parse CHP ID
    const validChpId = (chpId && !isNaN(parseInt(chpId))) ? parseInt(chpId) : null;

    // Insert Triage Log
    const triageQuery = `
      INSERT INTO triage_logs (patient_id, chp_id, polyuria, polydipsia, weight_loss, rbs_value, risk_level)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING triage_id;
    `;
    const triageValues = [patientId, validChpId, Boolean(polyuria), Boolean(polydipsia), Boolean(weightLoss), rbsValue, cdssResult.riskLevel];
    const triageResult = await db.query(triageQuery, triageValues);
    const triageId = triageResult.rows[0].triage_id;

    // Generate Referral Ticket if High Risk
    let referralTicket = null;
    if (cdssResult.requiresReferral) {
      const referralQuery = `INSERT INTO referral_tickets (triage_id, facility_id, status) VALUES ($1, $2, 'Pending') RETURNING ticket_id, status, issued_at;`;
      const referralResult = await db.query(referralQuery, [triageId, facilityId || null]);
      referralTicket = referralResult.rows[0];

      io.emit('new_referral_alert', {
        ticketId: referralTicket.ticket_id,
        patientName: fullName,
        age,
        riskLevel: cdssResult.riskLevel,
        issuedAt: referralTicket.issued_at
      });
    }

    res.status(201).json({ message: 'Triage evaluation submitted successfully', patientId, triageId, cdssEvaluation: cdssResult, referralTicket });
  } catch (err) {
    console.error('Triage Submission Error:', err.message);
    res.status(500).json({ error: 'Failed to process triage submission', details: err.message });
  }
});

// 5. Fetch Pending Referrals
app.get('/api/referrals/pending', async (req, res) => {
  try {
    const queryText = `
      SELECT 
        rt.ticket_id, rt.status, rt.issued_at,
        p.full_name AS patient_name, p.age, p.gender,
        tl.rbs_value, tl.risk_level
      FROM referral_tickets rt
      JOIN triage_logs tl ON rt.triage_id = tl.triage_id
      JOIN patients p ON tl.patient_id = p.patient_id
      WHERE rt.status = 'Pending'
      ORDER BY rt.issued_at DESC;
    `;
    const result = await db.query(queryText);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve referral tickets', details: err.message });
  }
});

// 6. Acknowledge Referral Ticket (HRIO Action)
app.put('/api/referrals/:id/acknowledge', authenticateToken, async (req, res) => {
  const ticketId = req.params.id;
  const hrioUserId = req.user.userId;

  try {
    const queryText = `
      UPDATE referral_tickets 
      SET status = 'Acknowledged', processed_by_hrio = $1
      WHERE ticket_id = $2 RETURNING *;
    `;
    const result = await db.query(queryText, [hrioUserId, ticketId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Referral ticket not found' });
    }

    io.emit('referral_status_updated', { ticketId, status: 'Acknowledged' });
    res.json({ message: 'Ticket acknowledged by HRIO successfully', ticket: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to acknowledge referral', details: err.message });
  }
});

// 7. Complete Referral Ticket (HCP Action)
app.put('/api/referrals/:id/complete', authenticateToken, async (req, res) => {
  const ticketId = req.params.id;
  const hcpUserId = req.user.userId;

  try {
    const queryText = `
      UPDATE referral_tickets 
      SET status = 'Completed', attended_by_hcp = $1
      WHERE ticket_id = $2 RETURNING *;
    `;
    const result = await db.query(queryText, [hcpUserId, ticketId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Referral ticket not found' });
    }

    io.emit('referral_status_updated', { ticketId, status: 'Completed' });
    res.json({ message: 'Clinical referral marked as completed by HCP', ticket: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete referral ticket', details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});