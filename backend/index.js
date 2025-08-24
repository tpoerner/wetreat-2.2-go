// backend/index.js
// This is the complete, stable backend for the WeTreat medical consultation platform.

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');

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

        // Create tables only if they don't already exist
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

        // --- Seed Initial Users ---
        const adminCheck = await pool.query(`SELECT id FROM users WHERE email = $1`, ['admin@wetreat.com']);
        if (adminCheck.rows.length === 0) {
            const adminId = uuidv4();
            await pool.query(`INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, $4)`, [adminId, 'admin@wetreat.com', 'adminpass', 'admin']);
            console.log('Initial administrator user created.');
        }

        const doctorCheck = await pool.query(`SELECT id FROM users WHERE email = $1`, ['dr.smith@wetreat.com']);
        if (doctorCheck.rows.length === 0) {
            const doctorId = uuidv4();
            await pool.query(`INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, $4)`, [doctorId, 'dr.smith@wetreat.com', 'doctorpass', 'doctor']);
            
            const profileId = uuidv4();
            await pool.query(`
                INSERT INTO doctor_profiles (id, user_id, full_name, specialty) 
                VALUES ($1, $2, $3, $4)`,
                [profileId, doctorId, 'Dr. John Smith', 'Cardiology']
            );
            console.log('Dummy doctor and profile created.');
        }
        console.log("Initial user seeding complete.");

    } catch (err) {
        console.error('Database connection or setup error', err);
        process.exit(1);
    }
}

// 4. --- API Endpoints ---

// Patient EMR Submission
app.post('/api/emr/submit', async (req, res) => {
    const { email, password, name, dob, symptoms, medicalHistory, medication, medicalDocuments, notes } = req.body;
    try {
        const emrId = uuidv4();
        await pool.query(`
            INSERT INTO emrs (id, patient_email, patient_password, patient_name, patient_dob, symptoms, medical_history, current_medication, medical_documents, patient_notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [emrId, email, password, name, dob, symptoms, medicalHistory, medication, JSON.stringify(medicalDocuments), notes]);
        res.status(201).json({ message: 'EMR submitted successfully.', emrId });
    } catch (error) { res.status(500).json({ message: 'Failed to submit EMR' }); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE email = $1 AND password = $2`, [email, password]);
        const user = result.rows[0];
        if (user) {
            let profile = null;
            if (user.role === 'doctor') {
                const profileResult = await pool.query(`SELECT * FROM doctor_profiles WHERE user_id = $1`, [user.id]);
                profile = profileResult.rows[0];
            }
            res.json({ message: 'Login successful', user, profile });
        } else { res.status(401).json({ message: 'Invalid credentials' }); }
    } catch (error) { res.status(500).json({ message: 'Server error' }); }
});

// Create Doctor (Admin)
app.post('/api/users/doctor', async (req, res) => {
    const { email, password, profile } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query(`INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, 'doctor') RETURNING id`, [uuidv4(), email, password]);
        const userId = userResult.rows[0].id;
        await client.query(`
            INSERT INTO doctor_profiles (id, user_id, full_name, photo_url, specialty, expertise_area, current_affiliation, linkedin_url, fee_office, fee_home, fee_video, fee_phone, fee_review)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [uuidv4(), userId, profile.fullName, profile.photoUrl, profile.specialty, profile.expertiseArea, profile.currentAffiliation, profile.linkedinUrl, profile.feeOffice, profile.feeHome, profile.feeVideo, profile.feePhone, profile.feeReview]
        );
        await client.query('COMMIT');
        res.status(201).json({ message: 'Doctor created successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Failed to create doctor' });
    } finally { client.release(); }
});

// Get all Doctors
app.get('/api/doctors', async (req, res) => {
    try {
        const result = await pool.query(`SELECT u.email, dp.* FROM doctor_profiles dp JOIN users u ON dp.user_id = u.id ORDER BY dp.full_name`);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Server error' }); }
});

// Get EMRs
app.get('/api/emrs', async (req, res) => {
    const { userId, userRole } = req.query; 
    try {
        let result;
        if (userRole === 'admin') result = await pool.query('SELECT * FROM emrs ORDER BY created_at DESC');
        else if (userRole === 'doctor') result = await pool.query('SELECT * FROM emrs WHERE assigned_doctor_id = $1 ORDER BY created_at DESC', [userId]);
        else return res.status(403).json({ message: 'Forbidden' });
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Server error' }); }
});

// Update Doctor Profile (Admin)
app.put('/api/doctor-profiles/:userId', async (req, res) => {
    const { userId } = req.params;
    const profile = req.body;
    try {
        await pool.query(`
            UPDATE doctor_profiles SET full_name = $1, photo_url = $2, specialty = $3, expertise_area = $4, current_affiliation = $5, linkedin_url = $6, fee_office = $7, fee_home = $8, fee_video = $9, fee_phone = $10, fee_review = $11
            WHERE user_id = $12`,
            [profile.fullName, profile.photoUrl, profile.specialty, profile.expertiseArea, profile.currentAffiliation, profile.linkedinUrl, profile.feeOffice, profile.feeHome, profile.feeVideo, profile.feePhone, profile.feeReview, userId]
        );
        res.status(200).json({ message: 'Doctor profile updated' });
    } catch (error) { res.status(500).json({ message: 'Failed to update profile' }); }
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
            await pool.query(`UPDATE emrs SET doctor_report = $1, doctor_recommendations = $2, doctor_private_notes = $3, consultation_type = $4, status = $5, updated_at = NOW() WHERE id = $6`,
            [updates.doctorReport, updates.doctorRecommendations, updates.doctorPrivateNotes, JSON.stringify(updates.consultationType), updates.status, id]);
        } else { return res.status(403).json({ message: 'Invalid role' }); }
        res.status(200).json({ message: 'EMR updated successfully' });
    } catch (error) { res.status(500).json({ message: 'Failed to update EMR' }); }
});

// Delete Doctor (Admin)
app.delete('/api/users/doctor/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        await pool.query(`DELETE FROM users WHERE id = $1 AND role = 'doctor'`, [userId]);
        res.status(200).json({ message: 'Doctor deleted successfully' });
    } catch (error) { res.status(500).json({ message: 'Failed to delete doctor' }); }
});

// Generate PDF
app.get('/api/emrs/:id/generate-pdf', async (req, res) => {
    try {
        const emrResult = await pool.query(`SELECT e.*, dp.full_name as doctor_name FROM emrs e LEFT JOIN doctor_profiles dp ON e.assigned_doctor_id = dp.user_id WHERE e.id = $1`, [req.params.id]);
        const emr = emrResult.rows[0];
        if (!emr) return res.status(404).json({ message: 'EMR not found.' });
        if (!emr.is_payment_confirmed) return res.status(403).json({ message: 'Payment not confirmed.' });
        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Report_${emr.id}.pdf"`);
        doc.pipe(res);
        doc.fontSize(18).text('Medical Consultation Report', { align: 'center' }).moveDown(1);
        doc.fontSize(12).text(`Patient Name: ${emr.patient_name}`);
        doc.text(`Consulting Physician: ${emr.doctor_name || 'N/A'}`).moveDown(1.5);
        doc.fontSize(14).text("Physician's Report", { underline: true }).moveDown(0.5);
        doc.fontSize(11).text(emr.doctor_report || 'Pending report...').moveDown(1);
        doc.fontSize(12).text('Recommendations').moveDown(0.2);
        doc.fontSize(11).text(emr.doctor_recommendations || 'Pending recommendations...').moveDown(2);
        doc.end();
    } catch (error) { res.status(500).json({ message: 'Server error' }); }
});

// 5. --- Start the Server ---
async function startServer() {
    await setupDatabase();
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

startServer();
