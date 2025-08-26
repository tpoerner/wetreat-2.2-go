// backend/index.js
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const https = require('https');

// ✅ NEW: i18n deps
const path = require('path');
const cookieParser = require('cookie-parser');
const i18next = require('i18next');
const i18nextMiddleware = require('i18next-http-middleware');
const BackendFs = require('i18next-fs-backend');

// 1. Initialize Express App
const app = express();
const PORT = process.env.PORT || 3001;

// 2. Configure CORS
const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
const corsOptions = { origin: allowedOrigin };
app.use(cors(corsOptions));

// 3. Use Middleware
app.use(express.json());

// ✅ NEW: i18n initialization (CommonJS)
const LOCALES_DIR = process.env.LOCALES_DIR || path.join(__dirname, 'locales');
i18next
  .use(BackendFs)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['de','en','fr','ro'],
    preload: ['de','en','fr','ro'],
    backend: { loadPath: path.join(LOCALES_DIR, '{{lng}}/common.json') },
    detection: {
      order: ['querystring','cookie','header'],
      lookupQuerystring: 'lng',
      lookupCookie: 'i18next',
      caches: false
    },
    interpolation: { escapeValue: false }
  });

app.use(cookieParser());
app.use(i18nextMiddleware.handle(i18next));

// (optional) serve locales for quick testing
app.use('/locales', express.static(LOCALES_DIR));

// Helper: pick language per request with overrides
function pickRequestLng(req, fallback = 'en') {
  const bodyLng = req.body && req.body.lng;
  const headerLng = req.headers['x-wetreat-lang'];
  const queryLng = req.query && req.query.lng;
  const detected = req.language; // from middleware
  const cand = bodyLng || headerLng || queryLng || detected || fallback;
  const supported = (i18next.options && i18next.options.supportedLngs) || ['de','en','fr','ro'];
  return supported.includes(cand) ? cand : fallback;
}

// --- Database Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
  try {
    await pool.query('SELECT NOW()');
    console.log("Connected to PostgreSQL database successfully.");
    console.log("Verifying database schema...");

    await pool.query(`ALTER TABLE emrs ADD COLUMN IF NOT EXISTS doctor_diagnosis TEXT;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'doctor')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS doctor_profiles (
        id UUID PRIMARY KEY,
        user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        photo_url TEXT,
        specialty TEXT,
        expertise_area TEXT,
        current_affiliation TEXT,
        linkedin_url TEXT,
        fee_office NUMERIC(10, 2),
        fee_home NUMERIC(10, 2),
        fee_video NUMERIC(10, 2),
        fee_phone NUMERIC(10, 2),
        fee_review NUMERIC(10, 2)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS emrs (
        id UUID PRIMARY KEY,
        patient_email TEXT NOT NULL,
        patient_password TEXT NOT NULL,
        patient_name TEXT,
        patient_dob DATE,
        symptoms TEXT,
        medical_history TEXT,
        current_medication TEXT,
        medical_documents JSONB,
        patient_notes TEXT,
        assigned_doctor_id UUID REFERENCES users(id),
        consultation_type JSONB,
        doctor_diagnosis TEXT,
        doctor_report TEXT,
        doctor_recommendations TEXT,
        doctor_private_notes TEXT,
        admin_notes TEXT,
        is_payment_confirmed BOOLEAN DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'submitted_by_patient',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("Tables verified successfully.");
  } catch (err) {
    console.error('Database connection or setup error', err);
    process.exit(1);
  }
}

// 4. Health
app.get('/health', (req, res) => {
  const lng = pickRequestLng(req);
  res.set('Content-Language', lng);
  res.json({ ok: true, message: i18next.t('server.health', { lng }), now: new Date().toISOString() });
});

// --- API Endpoints (unchanged) ---
app.get('/api/doctors', async (req, res) => {
  try {
    const result = await pool.query('SELECT dp.*, u.id AS user_id FROM doctor_profiles dp INNER JOIN users u ON dp.user_id = u.id');
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching doctors:", error);
    res.status(500).json({ message: 'Failed to fetch doctors.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT id, email, role FROM users WHERE email = $1 AND password = $2', [email, password]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      res.status(200).json({ message: 'Login successful', user });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

app.post('/api/emr/submit', async (req, res) => {
  const { email, password, name, dob, symptoms, medicalHistory, medication, medicalDocuments, notes } = req.body;
  try {
    const newEmrId = uuidv4();
    await pool.query(
      `INSERT INTO emrs (id, patient_email, patient_password, patient_name, patient_dob, symptoms, medical_history, current_medication, medical_documents, patient_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newEmrId, email, password, name, dob, symptoms, medicalHistory, medication, medicalDocuments, notes]
    );
    res.status(201).json({ message: 'Consultation request submitted successfully.' });
  } catch (error) {
    console.error("Error submitting EMR:", error);
    res.status(500).json({ message: 'Failed to submit consultation request.' });
  }
});

app.get('/api/emrs', async (req, res) => {
  const { userId, userRole } = req.query;
  try {
    let result;
    if (userRole === 'admin') {
      result = await pool.query('SELECT * FROM emrs ORDER BY created_at DESC');
    } else if (userRole === 'doctor') {
      result = await pool.query('SELECT * FROM emrs WHERE assigned_doctor_id = $1 ORDER BY created_at DESC', [userId]);
    } else {
      return res.status(403).json({ message: 'Invalid role' });
    }
    const rows = result.rows.map(({ patient_password, ...rest }) => rest);
    res.status(200).json(rows);
  } catch (error) {
    console.error("Error fetching EMRs:", error);
    res.status(500).json({ message: 'Failed to fetch EMRs.' });
  }
});

app.post('/api/users/doctor', async (req, res) => {
  const { email, password, profile } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = uuidv4();
    await client.query('INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, $4)', [userId, email, password, 'doctor']);
    const profileId = uuidv4();
    await client.query(`
      INSERT INTO doctor_profiles (id, user_id, full_name, photo_url, specialty, expertise_area, current_affiliation, linkedin_url, fee_office, fee_home, fee_video, fee_phone, fee_review)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [profileId, userId, profile.fullName, profile.photoUrl, profile.specialty, profile.expertiseArea, profile.currentAffiliation, profile.linkedinUrl, profile.feeOffice, profile.feeHome, profile.feeVideo, profile.feePhone, profile.feeReview]
    );
    await client.query('COMMIT');
    res.status(201).json({ message: 'Doctor created successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error creating doctor:", error);
    res.status(500).json({ message: 'Failed to create doctor.' });
  } finally {
    client.release();
  }
});

app.put('/api/doctor-profiles/:userId', async (req, res) => {
  const { userId } = req.params;
  const { fullName, photoUrl, specialty, expertiseArea, currentAffiliation, linkedinUrl, feeOffice, feeHome, feeVideo, feePhone, feeReview } = req.body;
  try {
    await pool.query(`
      UPDATE doctor_profiles
      SET full_name = $1, photo_url = $2, specialty = $3, expertise_area = $4, current_affiliation = $5, linkedin_url = $6,
          fee_office = $7, fee_home = $8, fee_video = $9, fee_phone = $10, fee_review = $11
      WHERE user_id = $12`,
      [fullName, photoUrl, specialty, expertiseArea, currentAffiliation, linkedinUrl, feeOffice, feeHome, feeVideo, feePhone, feeReview, userId]
    );
    res.status(200).json({ message: 'Doctor profile updated successfully.' });
  } catch (error) {
    console.error("Error updating doctor profile:", error);
    res.status(500).json({ message: 'Failed to update doctor profile.' });
  }
});

app.delete('/api/users/doctor/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    await pool.query('DELETE FROM users WHERE id = $1 AND role = $2', [userId, 'doctor']);
    res.status(200).json({ message: 'Doctor deleted successfully.' });
  } catch (error) {
    console.error("Error deleting doctor:", error);
    res.status(500).json({ message: 'Failed to delete doctor.' });
  }
});

// The PUT route handles updates for both roles
app.put('/api/emrs/:id', async (req, res) => {
  const { id } = req.params;
  const { role, updates } = req.body;

  if (!updates) {
    return res.status(400).json({ message: 'No updates provided.' });
  }

  try {
    const setClauses = [];
    const values = [];
    let i = 1;

    if (role === 'admin') {
      if ('assignedDoctorId' in updates) { setClauses.push(`assigned_doctor_id = $${i++}`); values.push(updates.assignedDoctorId); }
      if ('status' in updates) { setClauses.push(`status = $${i++}`); values.push(updates.status); }
    } else if (role === 'doctor') {
      if ('doctorDiagnosis' in updates) { setClauses.push(`doctor_diagnosis = $${i++}`); values.push(updates.doctorDiagnosis); }
      if ('doctorReport' in updates) { setClauses.push(`doctor_report = $${i++}`); values.push(updates.doctorReport); }
      if ('doctorRecommendations' in updates) { setClauses.push(`doctor_recommendations = $${i++}`); values.push(updates.doctorRecommendations); }
      if ('doctorPrivateNotes' in updates) { setClauses.push(`doctor_private_notes = $${i++}`); values.push(updates.doctorPrivateNotes); }
      if ('consultationType' in updates) { setClauses.push(`consultation_type = $${i++}`); values.push(JSON.stringify(updates.consultationType)); }
      if ('status' in updates) { setClauses.push(`status = $${i++}`); values.push(updates.status); }
    } else {
      return res.status(403).json({ message: 'Invalid role' });
    }

    if (setClauses.length === 0) return res.status(200).json({ message: 'No updates to perform.' });

    const query = `UPDATE emrs SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${i}`;
    values.push(id);

    await pool.query(query, values);
    res.status(200).json({ message: 'EMR updated successfully' });
  } catch (error) {
    console.error("Error updating EMR:", error);
    res.status(500).json({ message: 'Failed to update EMR' });
  }
});

// Helper to fetch image
function fetchImage(src) {
  return new Promise((resolve, reject) => {
    https.get(src, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', (err) => reject(err));
  });
}

// ✅ PDF route now localized
app.get('/api/emrs/:id/generate-pdf', async (req, res) => {
  try {
    const lng = pickRequestLng(req);                // <-- language decision
    res.set('Content-Language', lng);

    const emrResult = await pool.query(`
      SELECT e.*, dp.full_name as doctor_name
      FROM emrs e
      LEFT JOIN doctor_profiles dp ON e.assigned_doctor_id = dp.user_id
      WHERE e.id = $1`, [req.params.id]);
    const emr = emrResult.rows[0];
    if (!emr) return res.status(404).json({ message: i18next.t('errors.not_found', { lng }) });

    // Safe parse helpers
    const safeArray = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') { try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; } }
      return [];
    };

    // Fetch logo (non-fatal)
    let logoBuffer = null;
    try {
      logoBuffer = await fetchImage('https://i.postimg.cc/Sx9NFnRf/wt-logonew-whitecanvas.png');
    } catch (imageError) {
      console.error("Failed to fetch logo image:", imageError);
    }

    // Trans helper
    const t = (k, opt) => i18next.t(k, { lng, ...opt });

    // PDF
    const doc = new PDFDocument({ margin: 36 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Report_${emr.id}_${lng}.pdf"`);
    doc.pipe(res);

    if (logoBuffer) doc.image(logoBuffer, { fit: [60, 60], align: 'center' }).moveDown(0.5);
    doc.fontSize(18).text(t('pdf.header'), { align: 'center' }).moveDown(0.75);

    // Patient
    doc.fontSize(14).text(t('pdf.section.patient'), { underline: true }).moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold')
      .text(`${t('pdf.labels.name')}: ${emr.patient_name || 'N/A'}`)
      .text(`${t('pdf.labels.dob')}: ${emr.patient_dob ? new Date(emr.patient_dob).toLocaleDateString() : 'N/A'}`)
      .moveDown(1);

    // Medical info
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.symptoms')}:`).font('Helvetica').text(emr.symptoms || 'N/A').moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.history')}:`).font('Helvetica').text(emr.medical_history || 'N/A').moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.medication')}:`).font('Helvetica').text(emr.current_medication || 'N/A').moveDown(0.75);

    // Documents
    const mdocs = safeArray(emr.medical_documents);
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.documents')}:`).font('Helvetica').moveDown(mdocs.length ? 0.25 : 0.1);
    if (mdocs.length) {
      mdocs.forEach(d => {
        doc.text(`- ${d.name || 'N/A'}: ${d.url || 'N/A'} (${t('pdf.labels.doc_password')}: ${d.password || 'N/A'})`).moveDown(0.1);
      });
    } else {
      doc.text('N/A');
    }
    doc.moveDown(0.75);

    // Physician report
    doc.fontSize(14).text(t('pdf.section.report'), { underline: true }).moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.diagnosis')}:`).font('Helvetica').text(emr.doctor_diagnosis || 'N/A').moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.findings')}:`).font('Helvetica').text(emr.doctor_report || 'N/A').moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.recommendations')}:`).font('Helvetica').text(emr.doctor_recommendations || 'N/A').moveDown(0.5);

    const types = safeArray(emr.consultation_type);
    doc.fontSize(12).font('Helvetica-Bold').text(`${t('pdf.labels.types')}:`)
       .font('Helvetica').text(types.length ? types.join(', ') : 'N/A').moveDown(1.25);

    // Footer
    doc.fontSize(10).text(`${t('pdf.labels.generated_on')}: ${new Date().toLocaleString()}`, { align: 'left' }).moveDown(0.5);

    // Signature line & name
    const doctorNameRaw = emr.doctor_name || 'Physician';
    doc.text('_________________________', { align: 'right' });
    doc.text(doctorNameRaw, { align: 'right' });

    doc.end();
  } catch (error) {
    console.error("PDF Generation Error:", error);
    res.status(500).json({ message: 'Server error generating PDF' });
  }
});

// 5. Start Server
async function startServer() {
  await setupDatabase();
  app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}
startServer();
