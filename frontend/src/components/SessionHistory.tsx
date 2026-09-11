// displays past therapy sessions (from cloud or local tab storage).
// organized into 3 vertically stacked expandable dropdowns: Baseline (ROM), Movement Watching, and Movement Training.

import { useEffect, useState } from "react";
import { getSessions, isAuthenticated, type SessionRecord } from "../api/client";
import { Link } from "react-router-dom";
import ActivityHeatmap from "./ActivityHeatmap";
import SessionHistoryChart from "./SessionHistoryChart";
import WatchingHistoryChart from "./WatchingHistoryChart";
import TrainingHistoryChart from "./TrainingHistoryChart";

export default function SessionHistory() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState({
    baseline: true,
    watching: true,
    training: true,
  });

  const authed = isAuthenticated();

  useEffect(() => {
    getSessions()
      .then(setSessions)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "failed to load sessions")
      )
      .finally(() => setLoading(false));
  }, []);

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const setAllSections = (open: boolean) => {
    setOpenSections({
      baseline: open,
      watching: open,
      training: open,
    });
  };

  if (loading) {
    return (
      <div className="history-page">
        <div className="glass-card">
          <p>Loading session history...</p>
        </div>
      </div>
    );
  }

  // Filter or count records
  const watchingSessions = sessions.filter(
    (s) => (s.bodyLeanMax !== undefined && s.bodyLeanMax > 0) || (s.maxLoad !== undefined && s.maxLoad > 0)
  );
  const trainingSessions = sessions.filter(
    (s) => (s.flexReps !== undefined && s.flexReps > 0) || (s.extReps !== undefined && s.extReps > 0)
  );

  return (
    <div className="history-page">
      <div className="glass-card history-main-card">
        <div className="history-header">
          <div>
            <h2>Session History</h2>
            <p className="history-subtitle">
              Review your Baseline (ROM), Movement Watching, and Movement Training records
            </p>
          </div>
          <div className="history-header-actions">
            {!authed ? (
              <span className="guest-tag">
                Guest Mode (Tab Session) · <Link to="/login">Sign in to sync</Link>
              </span>
            ) : (
              <div className="accordion-toggle-all">
                <button
                  className="btn-text-link"
                  onClick={() => setAllSections(true)}
                >
                  Expand All
                </button>
                <span>·</span>
                <button
                  className="btn-text-link"
                  onClick={() => setAllSections(false)}
                >
                  Collapse All
                </button>
              </div>
            )}
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        {authed && <ActivityHeatmap sessions={sessions} />}

        {sessions.length === 0 ? (
          <p className="empty-text">
            No sessions recorded yet. Complete a session to track your physical therapy progress.
          </p>
        ) : (
          <div className="history-accordion-stack">
            {/* Dropdown 1: Baseline ROM History */}
            <div className={`accordion-card ${openSections.baseline ? "is-open" : "is-collapsed"}`}>
              <button
                type="button"
                className="accordion-header-btn"
                onClick={() => toggleSection("baseline")}
                aria-expanded={openSections.baseline}
                id="accordion-btn-baseline"
              >
                <div className="accordion-header-title">
                  <h3>Baseline (ROM) History</h3>
                  <span className="accordion-desc">
                    Flexion, Extension, and Range of Motion measurements
                  </span>
                </div>
                <div className="accordion-header-meta">
                  <span className="count-badge">{sessions.length} recorded</span>
                  <span className={`accordion-chevron ${openSections.baseline ? "expanded" : ""}`}>
                    ▼
                  </span>
                </div>
              </button>

              {openSections.baseline && (
                <div className="accordion-body">
                  <SessionHistoryChart sessions={sessions} />
                  <div className="session-table-wrapper">
                    <table className="session-table" id="baseline-history-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Time</th>
                          <th>Injured Side</th>
                          <th>Min Angle</th>
                          <th>Max Angle</th>
                          <th>ROM</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.map((s) => (
                          <tr key={`base_${s.id}`}>
                            <td>{s.date}</td>
                            <td style={{ whiteSpace: "nowrap" }}>{s.time || "--"}</td>
                            <td style={{ textTransform: "capitalize" }}>{s.injuredSide}</td>
                            <td>{s.minAngle !== undefined ? `${s.minAngle}°` : "--"}</td>
                            <td>{s.maxAngle !== undefined ? `${s.maxAngle}°` : "--"}</td>
                            <td style={{ fontWeight: 600, color: "var(--accent)" }}>
                              {s.rom !== undefined ? `${s.rom}°` : "--"}
                            </td>
                            <td>{s.isGuest ? "Local" : "Cloud"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Dropdown 2: Movement Watching History */}
            <div className={`accordion-card ${openSections.watching ? "is-open" : "is-collapsed"}`}>
              <button
                type="button"
                className="accordion-header-btn"
                onClick={() => toggleSection("watching")}
                aria-expanded={openSections.watching}
                id="accordion-btn-watching"
              >
                <div className="accordion-header-title">
                  <h3>Movement Watching History</h3>
                  <span className="accordion-desc">
                    Trunk lean posture compensation and maximum load distribution
                  </span>
                </div>
                <div className="accordion-header-meta">
                  <span className="count-badge">{watchingSessions.length} recorded</span>
                  <span className={`accordion-chevron ${openSections.watching ? "expanded" : ""}`}>
                    ▼
                  </span>
                </div>
              </button>

              {openSections.watching && (
                <div className="accordion-body">
                  {watchingSessions.length === 0 ? (
                    <p className="empty-text">
                      No movement watching sessions recorded yet. Enable Watching during your session to track trunk lean and load.
                    </p>
                  ) : (
                    <>
                      <WatchingHistoryChart sessions={watchingSessions} />
                      <div className="session-table-wrapper">
                        <table className="session-table" id="watching-history-table">
                          <thead>
                            <tr>
                              <th>Date</th>
                              <th>Time</th>
                              <th>Injured Side</th>
                              <th>Max Trunk Lean</th>
                              <th>Max Load</th>
                              <th>Source</th>
                            </tr>
                          </thead>
                          <tbody>
                            {watchingSessions.map((s) => (
                              <tr key={`watch_${s.id}`}>
                                <td>{s.date}</td>
                                <td style={{ whiteSpace: "nowrap" }}>{s.time || "--"}</td>
                                <td style={{ textTransform: "capitalize" }}>{s.injuredSide}</td>
                                <td style={{ color: "#AC3834", fontWeight: 600 }}>
                                  {s.bodyLeanMax !== undefined ? `${s.bodyLeanMax}°` : "0°"}
                                </td>
                                <td style={{ color: "#4292C6", fontWeight: 600 }}>
                                  {s.maxLoad !== undefined ? `${s.maxLoad}%` : "0%"}
                                </td>
                                <td>{s.isGuest ? "Local" : "Cloud"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Dropdown 3: Movement Training / Tracking History */}
            <div className={`accordion-card ${openSections.training ? "is-open" : "is-collapsed"}`}>
              <button
                type="button"
                className="accordion-header-btn"
                onClick={() => toggleSection("training")}
                aria-expanded={openSections.training}
                id="accordion-btn-training"
              >
                <div className="accordion-header-title">
                  <h3>Movement Training / Tracking History</h3>
                  <span className="accordion-desc">
                    Flexion and Extension repetition counts and exercise volume
                  </span>
                </div>
                <div className="accordion-header-meta">
                  <span className="count-badge">{trainingSessions.length} recorded</span>
                  <span className={`accordion-chevron ${openSections.training ? "expanded" : ""}`}>
                    ▼
                  </span>
                </div>
              </button>

              {openSections.training && (
                <div className="accordion-body">
                  {trainingSessions.length === 0 ? (
                    <p className="empty-text">
                      No movement training sessions recorded yet. Complete reps during training to track your volume.
                    </p>
                  ) : (
                    <>
                      <TrainingHistoryChart sessions={trainingSessions} />
                      <div className="session-table-wrapper">
                        <table className="session-table" id="training-history-table">
                          <thead>
                            <tr>
                              <th>Date</th>
                              <th>Time</th>
                              <th>Injured Side</th>
                              <th>Flexion Reps</th>
                              <th>Extension Reps</th>
                              <th>Total Reps</th>
                              <th>Source</th>
                            </tr>
                          </thead>
                          <tbody>
                            {trainingSessions.map((s) => (
                              <tr key={`train_${s.id}`}>
                                <td>{s.date}</td>
                                <td style={{ whiteSpace: "nowrap" }}>{s.time || "--"}</td>
                                <td style={{ textTransform: "capitalize" }}>{s.injuredSide}</td>
                                <td style={{ color: "#AC3834", fontWeight: 600 }}>
                                  {s.flexReps !== undefined ? s.flexReps : 0}
                                </td>
                                <td style={{ color: "#4292C6", fontWeight: 600 }}>
                                  {s.extReps !== undefined ? s.extReps : 0}
                                </td>
                                <td style={{ fontWeight: 600, color: "#a78bfa" }}>
                                  {(s.flexReps ?? 0) + (s.extReps ?? 0)}
                                </td>
                                <td>{s.isGuest ? "Local" : "Cloud"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
