// backend/index.js
// This Node.js Express application serves as the backend for the medical consultation platform.
// This version corrects the code order to ensure the server starts after all routes are defined.

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');

// 1. Initialize Express App
const app = express();
const PORT = process.env.PORT || 3001;

// 2. Configure CORS
// The URL of your live Netlify frontend should be set as an environment variable in Railway.
const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
const corsOptions = {
  origin: allowedOrigin
};
app.use(cors(corsOptions));

// 3. Use Middleware
app.use(express.json()); // Parses incoming JSON payloads

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
        
        console.log("Setting up database tables based on MVP schema...");

        // --- DEVELOPMENT ONLY: Drop existing tables to ensure a clean slate ---
        console.log("Dropping existing tables for a clean setup...");
        await pool.query(`DROP TABLE IF EXISTS emrs CASCADE;`);
        await pool.query(`DROP TABLE IF EXISTS doctor_profiles CASCADE;`);
        await pool.query(`DROP TABLE IF EXISTS users CASCADE;`);
        console.log("Existing tables dropped.");
        // --- End of Development Only Section ---

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
                specialty TEXT,
                years_experience INT,
                expertise_area TEXT,
                current_workplace TEXT,
                linkedin_url TEXT,
                consultation_fee NUMERIC(10, 2)
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
                document_links JSONB,
                patient_notes TEXT,
                assigned_doctor_id UUID REFERENCES users(id),
                doctor_report TEXT,
                doctor_recommendations TEXT,
                doctor_private_notes TEXT,
                admin_notes TEXT,
                is_payment_confirmed BOOLEAN DEFAULT FALSE,
                patient_feedback TEXT,
                status TEXT NOT NULL DEFAULT 'submitted_by_patient',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        console.log("Tables created successfully.");

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
                INSERT INTO doctor_profiles (id, user_id, full_name, specialty, years_experience, consultation_fee) 
                VALUES ($1, $2, $3, $4, $5, $6)`,
                [profileId, doctorId, 'Dr. John Smith', 'Cardiology', 15, 250.00]
            );
            console.log('Dummy doctor and profile created.');
        }

    } catch (err) {
        console.error('Database connection or setup error', err);
        process.exit(1);
    }
}

// 4. --- Define API Endpoints ---

// Patient "registers" by submitting their EMR
app.post('/api/emr/submit', async (req, res) => {
    const { email, password, name, dob, symptoms, medicalHistory, medication, documents, notes } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ message: 'Email, password, and name are required.' });
    }
    try {
        const emrId = uuidv4();
        await pool.query(`
            INSERT INTO emrs (id, patient_email, patient_password, patient_name, patient_dob, symptoms, medical_history, current_medication, document_links, patient_notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [emrId, email, password, name, dob, symptoms, medicalHistory, medication, JSON.stringify(documents), notes]);
        res.status(201).json({ message: 'EMR submitted successfully. An admin will contact you shortly.', emrId });
    } catch (error) {
        console.error('Error submitting EMR:', error);
        res.status(500).json({ message: 'Failed to submit EMR', error: error.message });
    }
});

// Login for Admins and Doctors
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
            res.json({ message: 'Login successful', user: { id: user.id, email: user.email, role: user.role }, profile });
        } else {
            res.status(401).json({ message: 'Invalid email or password' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// Create new user (Admin Only)
app.post('/api/users', async (req, res) => {
    const { email, password, role, profile } = req.body;
    try {
        const userId = uuidv4();
        await pool.query(`INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, $4)`, [userId, email, password, role]);
        if (role === 'doctor' && profile) {
            const profileId = uuidv4();
            await pool.query(`
                INSERT INTO doctor_profiles (id, user_id, full_name, specialty, years_experience, expertise_area, current_workplace, linkedin_url, consultation_fee)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [profileId, userId, profile.fullName, profile.specialty, profile.yearsExperience, profile.expertiseArea, profile.currentWorkplace, profile.linkedinUrl, profile.consultationFee]
            );
        }
        res.status(201).json({ message: 'User created successfully', userId });
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ message: 'Failed to create user', error: error.message });
    }
});

// Get EMRs
app.get('/api/emrs', async (req, res) => {
    const { userId, userRole } = req.query; 
    try {
        let result;
        if (userRole === 'admin') {
            result = await pool.query('SELECT * FROM emrs ORDER BY created_at DESC');
        } else if (userRole === 'doctor') {
            result = await pool.query('SELECT * FROM emrs WHERE assigned_doctor_id = $1 ORDER BY created_at DESC', [userId]);
        } else {
            return res.status(403).json({ message: 'Forbidden' });
        }
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching EMRs:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update an EMR
app.put('/api/emrs/:id', async (req, res) => {
    const { id } = req.params;
    const { role, updates } = req.body;
    try {
        let query;
        let queryParams;
        if (role === 'admin') {
            query = `UPDATE emrs SET assigned_doctor_id = $1, is_payment_confirmed = $2, admin_notes = $3, status = $4, updated_at = NOW() WHERE id = $5`;
            queryParams = [updates.assignedDoctorId, updates.isPaymentConfirmed, updates.adminNotes, updates.status, id];
        } else if (role === 'doctor') {
            query = `UPDATE emrs SET doctor_report = $1, doctor_recommendations = $2, doctor_private_notes = $3, status = $4, updated_at = NOW() WHERE id = $5`;
            queryParams = [updates.doctorReport, updates.doctorRecommendations, updates.doctorPrivateNotes, updates.status, id];
        } else {
            return res.status(403).json({ message: 'Invalid role for update.' });
        }
        await pool.query(query, queryParams);
        res.status(200).json({ message: 'EMR updated successfully' });
    } catch (error) {
        console.error('Error updating EMR:', error);
        res.status(500).json({ message: 'Failed to update EMR', error: error.message });
    }
});

// Generate PDF
app.get('/api/emrs/:id/generate-pdf', async (req, res) => {
    const { id } = req.params;
    try {
        const emrResult = await pool.query(`
            SELECT e.*, dp.full_name as doctor_name 
            FROM emrs e
            LEFT JOIN doctor_profiles dp ON e.assigned_doctor_id = dp.user_id
            WHERE e.id = $1
        `, [id]);
        const emr = emrResult.rows[0];
        if (!emr) {
            return res.status(404).json({ message: 'EMR not found.' });
        }
        if (!emr.is_payment_confirmed) {
            return res.status(403).json({ message: 'Payment not confirmed. PDF cannot be generated.' });
        }
        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Consultation_Report_${emr.id}.pdf"`);
        doc.pipe(res);
        doc.fontSize(18).text('Medical Consultation Report', { align: 'center' }).moveDown(1);
        doc.fontSize(12).text(`Patient Name: ${emr.patient_name}`);
        doc.text(`Date of Birth: ${new Date(emr.patient_dob).toLocaleDateString()}`);
        doc.text(`Consultation Date: ${new Date(emr.created_at).toLocaleDateString()}`);
        doc.text(`Consulting Physician: ${emr.doctor_name || 'N/A'}`).moveDown(1.5);
        doc.fontSize(14).text('Patient-Provided Information', { underline: true }).moveDown(0.5);
        doc.fontSize(11).text('Symptoms:', { continued: true }).font('Helvetica-Bold').text(emr.symptoms || 'N/A').font('Helvetica');
        doc.moveDown(0.5);
        doc.text('Medical History:', { continued: true }).font('Helvetica-Bold').text(emr.medical_history || 'N/A').font('Helvetica');
        doc.moveDown(1.5);
        doc.fontSize(14).text("Physician's Report", { underline: true }).moveDown(0.5);
        doc.fontSize(12).text('Consultation Report & Findings').moveDown(0.2);
        doc.fontSize(11).text(emr.doctor_report || 'Pending report...').moveDown(1);
        doc.fontSize(12).text('Recommendations').moveDown(0.2);
        doc.fontSize(11).text(emr.doctor_recommendations || 'Pending recommendations...').moveDown(2);
        doc.fontSize(10).text('--- End of Report ---', { align: 'center' });
        doc.end();
    } catch (error) {
        console.error('PDF generation error:', error);
        res.status(500).json({ message: 'Server error generating PDF.' });
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
