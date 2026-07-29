import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { auth } from './lib/api.js';
import SubmitComplaint from './pages/SubmitComplaint.jsx';
import TrackComplaint from './pages/TrackComplaint.jsx';
import Login from './pages/Login.jsx';
import MyComplaints from './pages/MyComplaints.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ComplaintDetail from './pages/ComplaintDetail.jsx';

/** Blocks a route unless the user is logged in with one of the allowed roles. */
function Protected({ user, roles, children }) {
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const [user, setUser] = useState(auth.user());
  const nav = useNavigate();
  const isStaff = user && (user.role === 'officer' || user.role === 'admin');

  function logout() {
    auth.clear();
    setUser(null);
    nav('/');
  }

  return (
    <>
      <header className="app-header">
        <div className="header-inner">
          <Link to="/" className="brand">
            <div className="brand-emblem" />
            <div className="brand-text">
              <strong>Jan Samadhan</strong>
              <span>Government Grievance Portal</span>
            </div>
          </Link>

          <nav className="nav">
            <NavLink to="/">File Complaint</NavLink>
            <NavLink to="/track">Track</NavLink>
            {user?.role === 'citizen' && <NavLink to="/my-complaints">My Complaints</NavLink>}
            {isStaff && <NavLink to="/dashboard">Dashboard</NavLink>}
            {user ? (
              <>
                <span className="pill" style={{ marginLeft: 8 }}>
                  {user.name} · {user.role}
                  {user.department ? ` (${user.department})` : ''}
                </span>
                <button className="btn-secondary btn-sm" onClick={logout}>Sign out</button>
              </>
            ) : (
              <NavLink to="/login">Sign in</NavLink>
            )}
          </nav>
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<SubmitComplaint />} />
          <Route path="/track" element={<TrackComplaint />} />
          <Route path="/login" element={<Login onAuth={setUser} />} />
          <Route
            path="/my-complaints"
            element={<Protected user={user}><MyComplaints /></Protected>}
          />
          <Route
            path="/dashboard"
            element={
              <Protected user={user} roles={['officer', 'admin']}>
                <Dashboard user={user} />
              </Protected>
            }
          />
          <Route
            path="/complaint/:id"
            element={<Protected user={user}><ComplaintDetail user={user} /></Protected>}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="footer">
        Jan Samadhan · Complaints are auto-classified and routed by an AI service.
        Automatic decisions can be corrected by department staff.
      </footer>
    </>
  );
}
