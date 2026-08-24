// root layout with nav, optional auth gate, and routes.
// all session and history features are available to guest and authenticated users.

import { useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { isAuthenticated, logout } from "./api/client";
import CalibrationFlow from "./components/CalibrationFlow";
import SessionHistory from "./components/SessionHistory";
import AuthForm from "./components/AuthForm";

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated());

  return (
    <BrowserRouter>
      <div className="app-shell">
        <nav className="top-nav">
          <div className="nav-brand">pocket physio</div>
          <div className="nav-links">
            <NavLink to="/" end>session</NavLink>
            <NavLink to="/history">history</NavLink>
            {authed ? (
              <button
                id="logout-btn"
                className="btn-link nav-auth"
                onClick={() => {
                  logout();
                  setAuthed(false);
                }}
              >
                sign out
              </button>
            ) : (
              <NavLink to="/login" className="nav-auth">sign in</NavLink>
            )}
          </div>
        </nav>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<CalibrationFlow />} />
            <Route path="/history" element={<SessionHistory />} />
            <Route
              path="/login"
              element={
                authed
                  ? <Navigate to="/" />
                  : <AuthForm onAuth={() => setAuthed(true)} />
              }
            />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
