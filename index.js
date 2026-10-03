const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./db'); // Adjust path if your DB module is located elsewhere

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Authentication Middleware with DEV Token Fallback
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  // Bypass for local dev token
  if (token === 'DEV_TOKEN') {
    req.user = { userId: 1, roleId: 3, name: 'Dev User' };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Socket.io Real-Time Connection
io.on('connection', (socket) => {
  console.log('⚡ Client connected to Socket.io:', socket.id);
  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

// --- 1. AUTHENTICATION ROUTE (DEV BYPASS) ---
app.post('/api/auth/login', async (req, res) => {
  const { phone } = req.body;

  // Automatically assign role depending on phone number entered
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
          p.full_name, 
          p.age, 
          p.gender, 
          COALESCE(p.contact, '') AS contact,
          tl.rbs_value, 
          tl.risk_level
       FROM referral_tickets rt
       LEFT JOIN triage_logs tl ON rt.triage_id = tl.triage_id
       LEFT JOIN patients p ON tl.patient_id = p.patient_id
       WHERE rt.status = 'Pending'
       ORDER BY rt.issued_at DESC`
    );
    res.json(result.rows || []);
  } catch (err) {
    console.error('❌ HRIO FETCH ERROR:', err);
    res.status(500).json({ error: `Database fetch failed: ${err.message}` });
  }
};

app.get('/api/hrio/pending', authenticateToken, handlePendingReferrals);
app.get('/api/referrals/pending', authenticateToken, handlePendingReferrals);

// --- 3. ACKNOWLEDGE TICKET (HRIO -> HCP) ---
app.put('/api/hrio/acknowledge/:id', authenticateToken, async (req, res) => {
  const ticketId = req.params.id;
  try {
    const result = await db.query(
      `UPDATE referral_tickets 
       SET status = 'Acknowledged' 
       WHERE ticket_id = $1 
       RETURNING *`,
      [ticketId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Referral ticket not found' });
    }

    const updatedTicket = result.rows[0];

    // Emit socket event to notify HCP workspace in real time
    io.emit('patient_referred_to_hcp', updatedTicket);

    res.json({
      message: 'Ticket successfully acknowledged and forwarded to HCP',
      ticket: updatedTicket
    });
  } catch (err) {
    console.error('❌ ACKNOWLEDGE ERROR:', err);
    res.status(500).json({ error: `Failed to acknowledge ticket: ${err.message}` });
  }
});

// --- 4. GET /api/hcp/cases (HCP Case Queue) ---
const handleHCPCases = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
          rt.ticket_id, 
          rt.triage_id, 
          rt.facility_id, 
          rt.status, 
          rt.issued_at,
          p.full_name, 
          p.age, 
          p.gender, 
          COALESCE(p.contact, '') AS contact,
          tl.rbs_value, 
          tl.risk_level
       FROM referral_tickets rt
       LEFT JOIN triage_logs tl ON rt.triage_id = tl.triage_id
       LEFT JOIN patients p ON tl.patient_id = p.patient_id
       WHERE rt.status = 'Acknowledged' OR rt.status = 'Referred to HCP'
       ORDER BY rt.issued_at DESC`
    );
    res.json(result.rows || []);
  } catch (err) {
    console.error('❌ HCP FETCH ERROR:', err);
    res.status(500).json({ error: `Database fetch failed: ${err.message}` });
  }
};

app.get('/api/hcp/cases', authenticateToken, handleHCPCases);
app.get('/api/hcp/queue', authenticateToken, handleHCPCases);

// Start Server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// --- 5. CHP TRIAGE SUBMISSION ROUTE ---
app.post('/api/chp/triage', authenticateToken, async (req, res) => {
  const { fullName, age, gender, contact, rbsValue, symptoms } = req.body;

  try {
    // 1. Insert patient or retrieve existing
    let patientRes = await db.query(
      `SELECT patient_id FROM patients WHERE contact = $1`,
      [contact]
    );

    let patientId;
    if (patientRes.rows.length === 0) {
      const newPatient = await db.query(
        `INSERT INTO patients (full_name, age, gender, contact)
         VALUES ($1, $2, $3, $4)
         RETURNING patient_id`,
        [fullName, age, gender, contact]
      );
      patientId = newPatient.rows[0].patient_id;
    } else {
      patientId = patientRes.rows[0].patient_id;
    }

    // 2. Determine risk level based on RBS
    let riskLevel = 'Low';
    if (rbsValue >= 11.1) {
      riskLevel = 'High';
    } else if (rbsValue >= 7.0) {
      riskLevel = 'Moderate';
    }

    // 3. Log triage data
    const triageRes = await db.query(
      `INSERT INTO triage_logs (patient_id, rbs_value, risk_level, symptoms, chp_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING triage_id`,
      [patientId, rbsValue, riskLevel, JSON.stringify(symptoms || []), req.user.userId]
    );

    const triageId = triageRes.rows[0].triage_id;

    // 4. Create referral ticket if high risk
    if (riskLevel === 'High') {
      const ticketRes = await db.query(
        `INSERT INTO referral_tickets (triage_id, status)
         VALUES ($1, 'Pending')
         RETURNING *`,
        [triageId]
      );

      // Emit socket notification for HRIO
      io.emit('new_referral', ticketRes.rows[0]);
    }

    res.status(201).json({
      message: 'Triage logged successfully',
      triageId,
      riskLevel
    });
  } catch (err) {
    console.error('❌ TRIAGE ERROR:', err);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});