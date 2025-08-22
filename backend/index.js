// backend/index.js
// This Node.js Express application serves as the backend for the medical consultation platform.
// It is now configured to use a persistent PostgreSQL database.

const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
app.use(cors()); // Enables Cross-Origin Resource Sharing
app.use(express.json()); // Parses incoming JSON payloads

// --- Database Setup ---
// Get the database connection URL from Railway's environment variables
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Connect to the database and create tables
async function setupDatabase() {
    try {
        await client.connect();
        console.log("Connected to PostgreSQL database successfully.");
        
        console.log("Setting up database tables...");
        
        // Users table for authentication
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL
            );
        `);
        
        // Patients table to store patient demographic and medical information
        await client.query(`
            CREATE TABLE IF NOT EXISTS patients (
                id TEXT PRIMARY KEY,
                fullName TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                dob TEXT,
                symptoms TEXT,
                medicalHistory TEXT,
                medication TEXT,
                documents TEXT,
                notes TEXT,
                timestamp TEXT NOT NULL
            );
        `);
        
        // Consultations table to store physician's consultation details
        await client.query(`
            CREATE TABLE IF NOT EXISTS consultations (
                consultationId TEXT PRIMARY KEY,
                patientId TEXT NOT NULL,
                physicianId TEXT NOT NULL,
                physicianName TEXT,
                physicianEmail TEXT,
                timestamp TEXT NOT NULL,
                status TEXT NOT NULL,
                consultationDescription TEXT,
                findings TEXT,
                recommendations TEXT,
                physicianNotes TEXT,
                FOREIGN KEY(patientId) REFERENCES patients(id)
            );
        `);
        
        // Seed initial admin user if not exists
        const adminCheck = await client.query(`SELECT id FROM users WHERE username = $1`, ['admin']);
        if (adminCheck.rows.length === 0) {
            const adminId = uuidv4();
            await client.query(`INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)`, [adminId, 'admin', 'Gr0711-#', 'administrator']);
            console.log('Initial administrator user created.');
        }

        // Seed a few dummy doctor and patient records for demonstration
        const doctorCheck = await client.query(`SELECT id FROM users WHERE username = $1`, ['dr.smith']);
        if (doctorCheck.rows.length === 0) {
            const doctorId = uuidv4();
            await client.query(`INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)`, [doctorId, 'dr.smith', 'password123', 'doctor']);
            console.log('Dummy doctor created.');
        }
        
        const patientCheck = await client.query(`SELECT id FROM patients WHERE email = $1`, ['johndoe@example.com']);
        if (patientCheck.rows.length === 0) {
            const patientId = uuidv4();
            await client.query(`INSERT INTO patients (id, fullName, email, dob, symptoms, medicalHistory, medication, documents, notes, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
                patientId,
                'John Doe',
                'johndoe@example.com',
                '1980-01-01',
                'Chest pain, shortness of breath',
                'Hypertension, high cholesterol',
                'Lisinopril',
                JSON.stringify([{ url: 'https://example.com/ecg.jpg', description: 'ECG' }]),
                'Patient is concerned about recent episodes.',
                new Date().toISOString()
            ]);
            
            const consultationId = uuidv4();
            const doctorId = (await client.query(`SELECT id FROM users WHERE username = 'dr.smith'`)).rows[0].id;
            await client.query(`INSERT INTO consultations (consultationId, patientId, physicianId, physicianName, physicianEmail, timestamp, status, consultationDescription, findings, recommendations, physicianNotes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
                consultationId,
                patientId,
                doctorId,
                'dr.smith',
                'dr.smith@example.com',
                new Date().toISOString(),
                'open',
                JSON.stringify({ type: 'online', onlineType: 'video', blinded: false }),
                'Patient presents with typical symptoms of angina.',
                'Prescribe nitrates, recommend lifestyle changes.',
                'Needs a follow-up in 2 weeks.'
            ]);
            console.log('Dummy patient and consultation records created.');
        }

    } catch (err) {
        console.error('Database connection or setup error', err);
        // Exit the process if the database setup fails. Railway will restart it.
        process.exit(1);
    }
}

// --- API Endpoints ---

// Login endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const result = await client.query(`SELECT * FROM users WHERE username = $1 AND password = $2`, [username, password]);
        const user = result.rows[0];
        
        if (user) {
            res.json({ message: 'Login successful', user: { id: user.id, username: user.username, role: user.role } });
        } else {
            res.status(401).json({ message: 'Invalid username or password' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// Create new user (Admin only)
app.post('/api/create-user', async (req, res) => {
    const { username, password, role } = req.body;
    
    try {
        const userId = uuidv4();
        await client.query(`INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)`, [userId, username, password, role]);
        res.status(201).json({ message: 'User created successfully', userId });
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ message: 'Failed to create user', error: error.message });
    }
});

// Submit patient record
app.post('/api/submit-patient-record', async (req, res) => {
    const patientData = req.body;
    
    try {
        const patientId = uuidv4();
        await client.query(`INSERT INTO patients (id, fullName, email, dob, symptoms, medicalHistory, medication, documents, notes, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
            patientId,
            patientData.fullName,
            patientData.email,
            patientData.dob,
            patientData.symptoms,
            patientData.medicalHistory,
            patientData.medication,
            JSON.stringify(patientData.documents),
            patientData.notes,
            new Date().toISOString()
        ]);
        res.status(201).json({ message: 'Patient record submitted successfully', patientId });
    } catch (error) {
        console.error('Error submitting patient record:', error);
        res.status(500).json({ message: 'Failed to submit patient record', error: error.message });
    }
});

// Save/Update consultation
app.post('/api/save-consultation', async (req, res) => {
    const { consultationId, patientId, physicianId, physicianName, physicianEmail, status, consultationDescription, findings, recommendations, physicianNotes } = req.body;
    
    try {
        if (consultationId) {
            // Update existing consultation
            await client.query(`UPDATE consultations SET status = $1, consultationDescription = $2, findings = $3, recommendations = $4, physicianNotes = $5 WHERE consultationId = $6`, [status, JSON.stringify(consultationDescription), findings, recommendations, physicianNotes, consultationId]);
            res.status(200).json({ message: 'Consultation updated successfully' });
        } else {
            // Create a new consultation
            const newConsultationId = uuidv4();
            await client.query(`INSERT INTO consultations (consultationId, patientId, physicianId, physicianName, physicianEmail, timestamp, status, consultationDescription, findings, recommendations, physicianNotes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
                newConsultationId,
                patientId,
                physicianId,
                physicianName,
                physicianEmail,
                new Date().toISOString(),
                status,
                JSON.stringify(consultationDescription),
                findings,
                recommendations,
                physicianNotes
            ]);
            res.status(201).json({ message: 'Consultation created successfully', consultationId: newConsultationId });
        }
    } catch (error) {
        console.error('Error saving consultation:', error);
        res.status(500).json({ message: 'Failed to save consultation', error: error.message });
    }
});

// Get a single consultation by ID
app.get('/api/consultation/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await client.query(`SELECT * FROM consultations WHERE consultationId = $1`, [id]);
        const consultation = result.rows[0];
        
        if (consultation) {
            res.json(consultation);
        } else {
            res.status(404).json({ message: 'Consultation not found' });
        }
    } catch (error) {
        console.error('Error fetching consultation:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get all consultations for a physician
app.get('/api/consultations/doctor/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await client.query(`SELECT * FROM consultations WHERE physicianId = $1`, [id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching consultations:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Generate PDF Report
app.get('/api/generate-pdf/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const consultationResult = await client.query(`SELECT * FROM consultations WHERE consultationId = $1`, [id]);
        const consultation = consultationResult.rows[0];
        if (!consultation) {
            return res.status(404).json({ message: 'Consultation not found.' });
        }

        const patientResult = await client.query(`SELECT * FROM patients WHERE id = $1`, [consultation.patientId]);
        const patient = patientResult.rows[0];
        if (!patient) {
            return res.status(404).json({ message: 'Patient record not found.' });
        }

        const doc = new PDFDocument();
        
        // Set the response headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Consultation_Report_${id}.pdf"`);
        
        doc.pipe(res);

        // Add content to the PDF
        doc.fontSize(16).text('Medical Consultation Report', { align: 'center' }).moveDown(0.5);
        doc.fontSize(12).text(`Report for: ${patient.fullName}`).moveDown(0.2);
        doc.text(`Consultation ID: ${consultation.consultationId}`).moveDown(0.2);
        doc.text(`Physician: ${consultation.physicianName}`).moveDown(0.2);
        doc.text(`Timestamp: ${new Date(consultation.timestamp).toLocaleString()}`).moveDown(1);
        
        // Consultation Description
        doc.fontSize(14).text('1. Consultation Description').moveDown(0.5);
        const desc = JSON.parse(consultation.consultationDescription);
        doc.fontSize(10).text(`Type: ${desc.type}`).moveDown(0.2);
        if (desc.onlineType) {
            doc.text(`Online Type: ${desc.onlineType}`).moveDown(0.2);
        }
        doc.text(`Blinded: ${desc.blinded ? 'Yes' : 'No'}`).moveDown(1);

        // Findings
        doc.fontSize(14).text('2. Findings').moveDown(0.5);
        doc.fontSize(10).text(consultation.findings || 'N/A').moveDown(1);

        // Recommendations
        doc.fontSize(14).text('3. Recommendations').moveDown(0.5);
        doc.fontSize(10).text(consultation.recommendations || 'N/A').moveDown(1);

        // Physician's Notes
        doc.fontSize(14).text('4. Physician\'s Notes').moveDown(0.5);
        doc.fontSize(10).text(consultation.physicianNotes || 'N/A').moveDown(1);
        
        doc.end();
    } catch (error) {
        console.error('PDF generation error:', error);
        res.status(500).json({ message: 'Server error generating PDF.' });
    }
});

// Start the server only after the database setup is complete
async function startServer() {
    await setupDatabase();
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

startServer();
