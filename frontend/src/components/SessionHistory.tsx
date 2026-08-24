// displays past therapy sessions (from cloud or local tab storage).

import { useEffect, useState } from "react";
import { getSessions, isAuthenticated, type SessionRecord } from "../api/client";
import { Link } from "react-router-dom";

export default function SessionHistory() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const authed = isAuthenticated();

  useEffect(() => {
    getSessions()
      .then(setSessions)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "failed to load sessions")
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="history-page">
        <div className="glass-card">
          <p>Loading session history...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="history-page">
      <div className="glass-card">
        <div className="history-header">
          <h2>Session History</h2>
          {!authed && (
            <span className="guest-tag">
              Guest Mode (Tab Session) · <Link to="/login">Sign in to sync</Link>
            </span>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}

        {sessions.length === 0 ? (
          <p className="empty-text">
            No sessions recorded yet. Complete a session to track your ROM progress.
          </p>
        ) : (
          <div className="session-table-wrapper">
            <table className="session-table" id="session-history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Injured Side</th>
                  <th>Min</th>
                  <th>Max</th>
                  <th>ROM</th>
                  <th>Max Lean</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.date}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{s.time || "--"}</td>
                    <td style={{ textTransform: "capitalize" }}>{s.injuredSide}</td>
                    <td>{s.minAngle !== undefined ? `${s.minAngle}°` : "--"}</td>
                    <td>{s.maxAngle !== undefined ? `${s.maxAngle}°` : "--"}</td>
                    <td style={{ fontWeight: 600, color: "var(--accent)" }}>
                      {s.rom !== undefined ? `${s.rom}°` : "--"}
                    </td>
                    <td>{s.bodyLeanMax !== undefined ? `${s.bodyLeanMax}°` : "--"}</td>
                    <td>
                      <span className={s.isGuest ? "source-tag local" : "source-tag cloud"}>
                        {s.isGuest ? "Local" : "Cloud"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
