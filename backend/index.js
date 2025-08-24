// backend/index.js
// This version ensures the database tables are created and seeded with default users reliably.
// It contains NO table-dropping logic to ensure data persistence.

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
        // This block will now safely run and add users only if they are missing.
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

// --- ALL OTHER API ENDPOINTS remain the same ---
// ... (the rest of your API routes for login, emrs, doctors, etc.) ...

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
            res.json({ message: 'Login successful', user, profile });
        } else {
            res.status(401).json({ message: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// All other routes...

// 5. --- Start the Server ---
async function startServer() {
    await setupDatabase();
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

startServer();
