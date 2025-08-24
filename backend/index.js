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

        // Ensure the doctor_diagnosis column exists
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

// 4. --- API Endpoints ---
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
            `INSERT INTO emrs (id, patient_email, patient_password, patient_name, patient_dob, symptoms, medical_history, current_medication, medical_documents, patient_notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        res.status(200).json(result.rows);
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
            INSERT INTO doctor_profiles (id, user_id, full_name, photo_url, specialty, expertise_area, current_affiliation, linkedin_url, fee_office, fee_home, fee_video, fee_phone, fee_review) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
            UPDATE doctor_profiles SET full_name = $1, photo_url = $2, specialty = $3, expertise_area = $4, current_affiliation = $5, linkedin_url = $6, fee_office = $7, fee_home = $8, fee_video = $9, fee_phone = $10, fee_review = $11 WHERE user_id = $12`,
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

// Update an EMR
app.put('/api/emrs/:id', async (req, res) => {
    const { id } = req.params;
    const { role, updates } = req.body;
    try {
        if (role === 'admin') {
            await pool.query(`UPDATE emrs SET assigned_doctor_id = $1, is_payment_confirmed = $2, status = $3, updated_at = NOW() WHERE id = $4`,
            [updates.assignedDoctorId, updates.isPaymentConfirmed, updates.status, id]);
        } else if (role === 'doctor') {
            await pool.query(`
                UPDATE emrs SET
                    symptoms = $1, medical_history = $2, current_medication = $3, medical_documents = $4,
                    doctor_diagnosis = $5, doctor_report = $6, doctor_recommendations = $7, doctor_private_notes = $8,
                    consultation_type = $9, status = $10, updated_at = NOW()
                WHERE id = $11`,
            [
                updates.symptoms, updates.medicalHistory, updates.currentMedication, JSON.stringify(updates.medicalDocuments),
                updates.doctorDiagnosis, updates.doctorReport, updates.doctorRecommendations, updates.doctorPrivateNotes,
                JSON.stringify(updates.consultationType), updates.status, id
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
        
        let logoBuffer = null;
        try {
            logoBuffer = await fetchImage('https://i.postimg.cc/Sx9NFnRf/wt-logonew-whitecanvas.png');
        } catch (imageError) {
            console.error("Failed to fetch logo image:", imageError);
            // Continue execution without the logo
        }

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Report_${emr.id}.pdf"`);
        doc.pipe(res);

        // --- PDF Content ---
        if (logoBuffer) {
            doc.image(logoBuffer, { fit: [80, 80], align: 'center' }).moveDown(2);
        }
        doc.fontSize(20).text('Medical Consultation Report', { align: 'center' }).moveDown(2);

        doc.fontSize(14).text('Patient Data', { underline: true }).moveDown(1);
        doc.fontSize(11)
            .text(`Name: ${emr.patient_name || 'N/A'}`)
            .text(`Date of Birth: ${emr.patient_dob ? new Date(emr.patient_dob).toLocaleDateString() : 'N/A'}`)
            .moveDown(1.5);

        doc.fontSize(12).font('Helvetica-Bold').text('Symptoms:').font('Helvetica').text(emr.symptoms || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Medical History:').font('Helvetica').text(emr.medical_history || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Current Medication:').font('Helvetica').text(emr.current_medication || 'N/A').moveDown(1);

        if (emr.medical_documents && emr.medical_documents.length > 0) {
            doc.fontSize(12).font('Helvetica-Bold').text('Medical Documents:').font('Helvetica').moveDown(0.5);
            emr.medical_documents.forEach(docItem => {
                doc.text(`- ${docItem.name || 'N/A'}: ${docItem.url || 'N/A'} (Password: ${docItem.password || 'N/A'})`).moveDown(0.2);
            });
            doc.moveDown(1.5);
        } else {
            doc.fontSize(12).font('Helvetica-Bold').text('Medical Documents:').font('Helvetica').text('N/A').moveDown(1.5);
        }

        doc.fontSize(14).text("Physician's Report", { underline: true }).moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Diagnosis:').font('Helvetica').text(emr.doctor_diagnosis || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Report & Findings:').font('Helvetica').text(emr.doctor_report || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Recommendations:').font('Helvetica').text(emr.doctor_recommendations || 'N/A').moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Consultation Type(s):').font('Helvetica').text(emr.consultation_type ? JSON.parse(emr.consultation_type).join(', ') : 'N/A').moveDown(4);


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
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

startServer();
