// backend/index.js
// This version adds a 'diagnosis' field and includes all patient data in the doctor's view and final PDF.

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const https = require('https');

// 1. Initialize Express App
const app = express();
const PORT = process.env.PORT || 3001;

// 2. Configure CORS
const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
const corsOptions = {
  origin: allowedOrigin
};
app.use(cors(corsOptions));

// 3. Use Middleware
app.use(express.json());

// --- Database Setup ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function setupDatabase() {
    try {
        await pool.query('SELECT NOW()');
        console.log("Connected to PostgreSQL database successfully.");
        
        console.log("Verifying database schema...");

        // NOTE: To apply the new `doctor_diagnosis` column, you might need to temporarily
        // uncomment the DROP TABLE commands for one deployment, then comment them out again.
        // await pool.query(`ALTER TABLE emrs ADD COLUMN IF NOT EXISTS doctor_diagnosis TEXT;`);


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
                doctor_diagnosis TEXT, -- NEW FIELD
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

// 4. --- API Endpoints ---

// ... (other endpoints like login, create doctor, etc. remain the same) ...

// Update an EMR
app.put('/api/emrs/:id', async (req, res) => {
    const { id } = req.params;
    const { role, updates } = req.body;
    try {
        if (role === 'admin') {
            await pool.query(`UPDATE emrs SET assigned_doctor_id = $1, is_payment_confirmed = $2, status = $3, updated_at = NOW() WHERE id = $4`,
            [updates.assignedDoctorId, updates.isPaymentConfirmed, updates.status, id]);
        } else if (role === 'doctor') {
            // UPDATED to include all new fields from the doctor's form
            await pool.query(`
                UPDATE emrs SET 
                    symptoms = $1, medical_history = $2, current_medication = $3, medical_documents = $4, 
                    doctor_diagnosis = $5, doctor_report = $6, doctor_recommendations = $7, doctor_private_notes = $8, 
                    consultation_type = $9, status = $10, updated_at = NOW() 
                WHERE id = $11`,
            [
                updates.symptoms, updates.medicalHistory, updates.currentMedication, JSON.stringify(updates.medicalDocuments),
                updates.doctorDiagnosis, updates.doctorReport, updates.doctorRecommendations, updates.doctorPrivateNotes, 
                JSON.stringify(updates.consultationType), 'report_complete', id
            ]);
        } else { return res.status(403).json({ message: 'Invalid role' }); }
        res.status(200).json({ message: 'EMR updated successfully' });
    } catch (error) { 
        console.error("Error updating EMR:", error);
        res.status(500).json({ message: 'Failed to update EMR' }); 
    }
});


// Helper function to fetch an image from a URL
function fetchImage(src) {
    return new Promise((resolve, reject) => {
        https.get(src, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', (err) => reject(err));
    });
}

// Generate PDF
app.get('/api/emrs/:id/generate-pdf', async (req, res) => {
    try {
        const emrResult = await pool.query(`SELECT e.*, dp.full_name as doctor_name FROM emrs e LEFT JOIN doctor_profiles dp ON e.assigned_doctor_id = dp.user_id WHERE e.id = $1`, [req.params.id]);
        const emr = emrResult.rows[0];
        if (!emr) return res.status(404).json({ message: 'EMR not found.' });
        if (!emr.is_payment_confirmed) return res.status(403).json({ message: 'Payment not confirmed.' });
        
        const logoBuffer = await fetchImage('https://i.postimg.cc/Sx9NFnRf/wt-logonew-whitecanvas.png');

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Report_${emr.id}.pdf"`);
        doc.pipe(res);

        // --- PDF Content ---
        doc.image(logoBuffer, { fit: [80, 80], align: 'center' }).moveDown(2);
        doc.fontSize(20).text('Medical Consultation Report', { align: 'center' }).moveDown(2);

        doc.fontSize(14).text('Patient Data', { underline: true }).moveDown(1);
        doc.fontSize(11)
           .text(`Name: ${emr.patient_name || 'N/A'}`)
           .text(`Date of Birth: ${emr.patient_dob ? new Date(emr.patient_dob).toLocaleDateString() : 'N/A'}`)
           .moveDown(1.5);

        doc.fontSize(12).font('Helvetica-Bold').text('Symptoms:').font('Helvetica').text(emr.symptoms || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Medical History:').font('Helvetica').text(emr.medical_history || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Current Medication:').font('Helvetica').text(emr.current_medication || 'N/A').moveDown(1.5);

        doc.fontSize(14).text("Physician's Report", { underline: true }).moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Diagnosis:').font('Helvetica').text(emr.doctor_diagnosis || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Report & Findings:').font('Helvetica').text(emr.doctor_report || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Recommendations:').font('Helvetica').text(emr.doctor_recommendations || 'N/A').moveDown(4);

        doc.fontSize(10).text(`Report generated on: ${new Date().toLocaleString()}`, { align: 'left' });
        doc.moveDown(1);
        
        doc.text('_________________________', { align: 'right' });
        doc.text(`Dr. ${emr.doctor_name || 'Physician'} Signature`, { align: 'right' });

        doc.end();
    } catch (error) { 
        console.error("PDF Generation Error:", error);
        res.status(500).json({ message: 'Server error generating PDF' }); 
    }
});


// 5. --- Start the Server ---
async function startServer() {
    await setupDatabase();
    // All other endpoints need to be defined before this
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

// Make sure all other required endpoints (login, get doctors, etc.) are pasted here from the previous version
// before calling startServer().

startServer();
