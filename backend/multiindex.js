// backend/index.js
// This version adds French to the multilingual support for PDF generation.

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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
    try {
        await pool.query('SELECT NOW()');
        console.log("Connected to PostgreSQL database successfully.");
        console.log("Verifying database schema...");

        // Create tables if they don't exist
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'doctor')), created_at TIMESTAMPTZ DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS doctor_profiles (id UUID PRIMARY KEY, user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE, full_name TEXT NOT NULL, photo_url TEXT, specialty TEXT, expertise_area TEXT, current_affiliation TEXT, linkedin_url TEXT, fee_office NUMERIC(10, 2), fee_home NUMERIC(10, 2), fee_video NUMERIC(10, 2), fee_phone NUMERIC(10, 2), fee_review NUMERIC(10, 2));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS emrs (id UUID PRIMARY KEY, patient_email TEXT NOT NULL, patient_password TEXT NOT NULL, patient_name TEXT, patient_dob DATE, symptoms TEXT, medical_history TEXT, current_medication TEXT, medical_documents JSONB, patient_notes TEXT, assigned_doctor_id UUID REFERENCES users(id), consultation_type JSONB, doctor_diagnosis TEXT, doctor_report TEXT, doctor_recommendations TEXT, doctor_private_notes TEXT, admin_notes TEXT, is_payment_confirmed BOOLEAN DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'submitted_by_patient', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);
        
        // Add column if it doesn't exist, non-breaking change
        await pool.query(`ALTER TABLE emrs ADD COLUMN IF NOT EXISTS doctor_diagnosis TEXT;`);

        console.log("Tables verified successfully.");
    } catch (err) {
        console.error('Database setup error', err);
        process.exit(1);
    }
}

// --- API Endpoints ---
// NOTE: All your other endpoints (login, doctors CRUD, EMR updates) go here.
// This example only shows the updated PDF endpoint for brevity.

function fetchImage(src) {
    return new Promise((resolve, reject) => {
        https.get(src, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

const pdfTranslations = {
    en: { title: 'Medical Consultation Report', patientName: 'Patient Name', physician: 'Consulting Physician', patientData: 'Patient Data', dob: 'Date of Birth', symptoms: 'Symptoms', medHistory: 'Medical History', medication: 'Current Medication', physicianReport: "Physician's Report", diagnosis: 'Diagnosis', reportFindings: 'Report & Findings', recommendations: 'Recommendations', generatedOn: 'Report generated on', signature: 'Physician Signature' },
    de: { title: 'Ärztlicher Untersuchungsbericht', patientName: 'Patientenname', physician: 'Behandelnder Arzt', patientData: 'Patientendaten', dob: 'Geburtsdatum', symptoms: 'Symptome', medHistory: 'Krankengeschichte', medication: 'Aktuelle Medikation', physicianReport: "Untersuchungsbericht", diagnosis: 'Diagnose', reportFindings: 'Bericht & Befunde', recommendations: 'Empfehlungen', generatedOn: 'Bericht erstellt am', signature: 'Unterschrift des Arztes' },
    ro: { title: 'Raport de Consultație Medicală', patientName: 'Nume Pacient', physician: 'Medic Consultant', patientData: 'Date Pacient', dob: 'Data Nașterii', symptoms: 'Simptome', medHistory: 'Istoric Medical', medication: 'Medicație Curentă', physicianReport: 'Raportul Medicului', diagnosis: 'Diagnostic', reportFindings: 'Raport & Rezultate', recommendations: 'Recomandări', generatedOn: 'Raport generat la', signature: 'Semnătura Medicului' },
    fr: { title: 'Rapport de Consultation Médicale', patientName: 'Nom du Patient', physician: 'Médecin Consultant', patientData: 'Données du Patient', dob: 'Date de Naissance', symptoms: 'Symptômes', medHistory: 'Antécédents Médicaux', medication: 'Médicaments Actuels', physicianReport: 'Rapport du Médecin', diagnosis: 'Diagnostic', reportFindings: 'Rapport & Constatations', recommendations: 'Recommandations', generatedOn: 'Rapport généré le', signature: 'Signature du Médecin' }
};

app.get('/api/emrs/:id/generate-pdf', async (req, res) => {
    try {
        const lang = req.query.lang && pdfTranslations[req.query.lang] ? req.query.lang : 'en';
        const t = pdfTranslations[lang];

        const emrResult = await pool.query(`SELECT e.*, dp.full_name as doctor_name FROM emrs e LEFT JOIN doctor_profiles dp ON e.assigned_doctor_id = dp.user_id WHERE e.id = $1`, [req.params.id]);
        const emr = emrResult.rows[0];
        if (!emr) return res.status(404).json({ message: 'EMR not found.' });
        
        const logoBuffer = await fetchImage('https://i.postimg.cc/Sx9NFnRf/wt-logonew-whitecanvas.png').catch(e => console.error("Logo fetch failed:", e));

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Report_${emr.id}.pdf"`);
        doc.pipe(res);

        if (logoBuffer) doc.image(logoBuffer, { fit: [80, 80], align: 'center' }).moveDown(2);
        doc.fontSize(20).text(t.title, { align: 'center' }).moveDown(2);
        doc.fontSize(14).text(t.patientData, { underline: true }).moveDown(1);
        doc.fontSize(11).text(`${t.patientName}: ${emr.patient_name || 'N/A'}`).text(`${t.dob}: ${emr.patient_dob ? new Date(emr.patient_dob).toLocaleDateString() : 'N/A'}`).moveDown(1.5);
        doc.fontSize(12).font('Helvetica-Bold').text(`${t.symptoms}:`).font('Helvetica').text(emr.symptoms || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text(`${t.medHistory}:`).font('Helvetica').text(emr.medical_history || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text(`${t.medication}:`).font('Helvetica').text(emr.current_medication || 'N/A').moveDown(1.5);
        doc.fontSize(14).text(t.physicianReport, { underline: true }).moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text(`${t.diagnosis}:`).font('Helvetica').text(emr.doctor_diagnosis || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text(`${t.reportFindings}:`).font('Helvetica').text(emr.doctor_report || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text(`${t.recommendations}:`).font('Helvetica').text(emr.doctor_recommendations || 'N/A').moveDown(4);
        doc.fontSize(10).text(`${t.generatedOn}: ${new Date().toLocaleString()}`, { align: 'left' }).moveDown(1);
        doc.text('_________________________', { align: 'right' });
        doc.text(t.signature, { align: 'right' });
        doc.end();
    } catch (error) { 
        console.error("PDF Generation Error:", error);
        res.status(500).json({ message: 'Server error generating PDF' }); 
    }
});

async function startServer() {
    await setupDatabase();
    // Ensure all your other endpoints are included here
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

startServer();
