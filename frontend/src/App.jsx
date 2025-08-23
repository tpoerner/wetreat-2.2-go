// --- FILE: src/App.jsx (All components are in this one file) ---
import React, { useState } from 'react';
import axios from 'axios';
import './App.css';

// --- API Configuration and Calls ---
const API_BASE_URL = import.meta.env.VITE_API_URL;

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const loginUser = (email, password) => {
  return apiClient.post('/api/auth/login', { email, password });
};

const submitEMR = (emrData) => {
  return apiClient.post('/api/emr/submit', emrData);
};


// --- Component: WelcomePage ---
const WelcomePage = ({ setView }) => {
  return (
    <div className="welcome-container">
      <div className="logo-placeholder">
        WeTreat Logo
      </div>
      <h1>Welcome to WeTreat</h1>
      <p>Your trusted online medical consultation platform.</p>
      <div className="role-selection">
        <h2>Please select your role to continue:</h2>
        <button onClick={() => setView('patient')}>I am a Patient</button>
        <button onClick={() => setView('login')}>I am a Doctor or Admin</button>
      </div>
    </div>
  );
};


// --- Component: LoginPage ---
const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }
    try {
      const response = await loginUser(email, password);
      console.log('Login successful:', response.data);
      setMessage(`Login successful! Welcome, ${response.data.user.role}.`);
    } catch (err) {
      setError('Login failed. Please check your credentials.');
      console.error(err);
    }
  };

  return (
    <div className="form-container">
      <h2>Doctor & Admin Portal</h2>
      <form onSubmit={handleLogin}>
        <div className="form-group">
          <label htmlFor="email">Email</label>
          <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@wetreat.com" />
        </div>
        <div className="form-group">
          <label htmlFor="password">Password</label>
          <input type="password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="adminpass" />
        </div>
        <button type="submit">Login</button>
        {error && <p className="error-message">{error}</p>}
        {message && <p className="success-message">{message}</p>}
      </form>
    </div>
  );
};


// --- Component: PatientSubmissionForm ---
const PatientSubmissionForm = () => {
  const [formData, setFormData] = useState({
    email: '', password: '', name: '', dob: '', symptoms: '', medicalHistory: '', medication: '', notes: ''
  });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prevState => ({ ...prevState, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    if (!formData.email || !formData.password || !formData.name) {
      setError('Email, password, and full name are required.');
      return;
    }
    try {
      const response = await submitEMR(formData);
      setMessage(response.data.message);
      setFormData({ email: '', password: '', name: '', dob: '', symptoms: '', medicalHistory: '', medication: '', notes: '' });
    } catch (err) {
      setError('Submission failed. Please try again.');
      console.error(err);
    }
  };

  return (
    <div className="form-container">
      <h2>New Consultation Request</h2>
      <p>Fill out the form below to submit your medical information.</p>
      <form onSubmit={handleSubmit}>
        <h3>Account Information</h3>
        <div className="form-group"><label>Email Address</label><input type="email" name="email" value={formData.email} onChange={handleChange} required /></div>
        <div className="form-group"><label>Choose a Password</label><input type="password" name="password" value={formData.password} onChange={handleChange} required /></div>
        <h3>Personal & Medical Details</h3>
        <div className="form-group"><label>Full Name</label><input type="text" name="name" value={formData.name} onChange={handleChange} required /></div>
        <div className="form-group"><label>Date of Birth</label><input type="date" name="dob" value={formData.dob} onChange={handleChange} /></div>
        <div className="form-group"><label>Symptoms</label><textarea name="symptoms" value={formData.symptoms} onChange={handleChange}></textarea></div>
        <div className="form-group"><label>Medical History</label><textarea name="medicalHistory" value={formData.medicalHistory} onChange={handleChange}></textarea></div>
        <div className="form-group"><label>Current Medication</label><textarea name="medication" value={formData.medication} onChange={handleChange}></textarea></div>
        <div className="form-group"><label>Optional Notes</label><textarea name="notes" value={formData.notes} onChange={handleChange}></textarea></div>
        <button type="submit">Submit for Review</button>
        {error && <p className="error-message">{error}</p>}
        {message && <p className="success-message">{message}</p>}
      </form>
    </div>
  );
};


// --- Main App Component ---
function App() {
  const [view, setView] = useState('welcome'); // 'welcome', 'login', 'patient'

  const renderView = () => {
    switch (view) {
      case 'login':
        return <LoginPage />;
      case 'patient':
        return <PatientSubmissionForm />;
      case 'welcome':
      default:
        return <WelcomePage setView={setView} />;
    }
  };

  return (
    <div className="app-container">
      <header>
        {view !== 'welcome' && (
          <button className="back-button" onClick={() => setView('welcome')}>
            &larr; Back
          </button>
        )}
      </header>
      <main>
        {renderView()}
      </main>
      <footer>
        <p>&copy; 2024 WeTreat. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default App;
