const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// --- Database Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
  try {
    await pool.query('SELECT NOW()');
    console.log("Connected to PostgreSQL database successfully.");

    await pool.query(`ALTER TABLE emrs ADD COLUMN IF NOT EXISTS doctor_diagnosis TEXT;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','doctor')),
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
        fee_office NUMERIC(10,2),
        fee_home NUMERIC(10,2),
        fee_video NUMERIC(10,2),
        fee_phone NUMERIC(10,2),
        fee_review NUMERIC(10,2)
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
    console.error("Database setup error", err);
    process.exit(1);
  }
}

// --- Helper: fetch image ---
function fetchImage(src) {
  return new Promise((resolve, reject) => {
    https.get(src, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', (err) => reject(err));
  });
}

// --- Routes (login, doctors, emrs, etc.) ---
// ... keep all your existing routes unchanged ...

// --- PDF Generation Route ---
app.get('/api/emrs/:id/generate-pdf', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, dp.full_name as doctor_name
      FROM emrs e
      LEFT JOIN doctor_profiles dp ON e.assigned_doctor_id = dp.user_id
      WHERE e.id = $1
    `, [req.params.id]);

    const emr = result.rows[0];
    if (!emr) return res.status(404).json({ message: 'EMR not found.' });

    const safeArray = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : []; }
        catch { return []; }
      }
      return [];
    };

    let logoBuffer = null;
    try {
      logoBuffer = await fetchImage('https://i.postimg.cc/Sx9NFnRf/wt-logonew-whitecanvas.png');
    } catch (e) { console.error("Logo fetch failed:", e); }

    const doc = new PDFDocument({ margin: 36 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Report_${emr.id}.pdf"`);
    doc.pipe(res);

    if (logoBuffer) doc.image(logoBuffer, { fit: [60, 60], align: 'center' }).moveDown(0.5);
    doc.fontSize(18).text('Medical Consultation Report', { align: 'center' }).moveDown(0.75);

    // Patient info
    doc.fontSize(14).text('Patient Data', { underline: true }).moveDown(0.5);
    doc.fontSize(13).font('Helvetica-Bold')
       .text(`Name: ${emr.patient_name || 'N/A'}`)
       .text(`Date of Birth: ${emr.patient_dob ? new Date(emr.patient_dob).toLocaleDateString() : 'N/A'}`)
       .moveDown(1);

    doc.fontSize(12).font('Helvetica');
    doc.font('Helvetica-Bold').text('Symptoms:').font('Helvetica').text(emr.symptoms || 'N/A').moveDown(0.5);
    doc.font('Helvetica-Bold').text('Medical History:').font('Helvetica').text(emr.medical_history || 'N/A').moveDown(0.5);
    doc.font('Helvetica-Bold').text('Current Medication:').font('Helvetica').text(emr.current_medication || 'N/A').moveDown(0.75);

    const docs = safeArray(emr.medical_documents);
    if (docs.length) {
      doc.font('Helvetica-Bold').text('Medical Documents:').font('Helvetica').moveDown(0.25);
      docs.forEach(d => {
        doc.text(`- ${d.name || 'N/A'}: ${d.url || 'N/A'} (Password: ${d.password || 'N/A'})`).moveDown(0.1);
      });
      doc.moveDown(0.75);
    } else {
      doc.font('Helvetica-Bold').text('Medical Documents:').font('Helvetica').text('N/A').moveDown(0.75);
    }

    // Physician report
    doc.fontSize(14).text("Physician's Report", { underline: true }).moveDown(0.5);
    doc.font('Helvetica-Bold').text('Diagnosis:').font('Helvetica').text(emr.doctor_diagnosis || 'N/A').moveDown(0.5);
    doc.font('Helvetica-Bold').text('Report & Findings:').font('Helvetica').text(emr.doctor_report || 'N/A').moveDown(0.5);
    doc.font('Helvetica-Bold').text('Recommendations:').font('Helvetica').text(emr.doctor_recommendations || 'N/A').moveDown(0.5);

    const types = safeArray(emr.consultation_type);
    doc.font('Helvetica-Bold').text('Consultation Type(s):').font('Helvetica').text(types.length ? types.join(', ') : 'N/A').moveDown(1.25);

    // Footer
    doc.fontSize(10).text(`Report generated on: ${new Date().toLocaleString()}`, { align: 'left' }).moveDown(0.5);
    doc.text('_________________________', { align: 'right' });
    doc.text(emr.doctor_name || 'Physician', { align: 'right' });

    doc.end();
  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({ message: 'Server error generating PDF' });
  }
});

// --- Start ---
async function startServer() {
  await setupDatabase();
  app.listen(PORT, () => console.log(`Server running on ${PORT}`));
}
startServer();
