// post-session summary card.
// displays date, military time + timezone, injured side, max angle, min angle, rom, and trunk lean.

import { useState } from "react";
import { saveSession, isAuthenticated } from "../api/client";
import { Link } from "react-router-dom";

interface SessionSummaryProps {
  injuredSide: "left" | "right";
  minAngle: number;
  maxAngle: number;
  rom: number;
  bodyLeanMax: number;
  onNewSession: () => void;
}

// format military time with local timezone code (e.g. "19:30 EDT")
function getFormattedTime(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const tzAbbr =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value || "";
  return `${hours}:${minutes} ${tzAbbr}`.trim();
}

export default function SessionSummary({
  injuredSide,
  minAngle,
  maxAngle,
  rom,
  bodyLeanMax,
  onNewSession,
}: SessionSummaryProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authed = isAuthenticated();

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveSession({
        date: new Date().toISOString().split("T")[0],
        time: getFormattedTime(),
        injuredSide,
        minAngle: Math.round(minAngle),
        maxAngle: Math.round(maxAngle),
        rom: Math.round(rom),
        bodyLeanMax: Math.min(90, Math.max(0, Math.round(bodyLeanMax))),
      });
      setSaved(true);
      setSaveNote(
        authed
          ? "Saved directly to your account history!"
          : "Saved to this session! Sign in or register to permanently store in your history."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="session-summary">
      <div className="glass-card summary-card">
        <h2>Session Complete</h2>

        <div className="summary-grid">
          <div className="summary-stat">
            <span className="stat-label">Injured Side</span>
            <span className="stat-value">{injuredSide.toUpperCase()}</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Range of Motion (ROM)</span>
            <span className="stat-value highlight">{Math.round(rom)}°</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Min Angle (Flexion)</span>
            <span className="stat-value">{Math.round(minAngle)}°</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Max Angle (Extension)</span>
            <span className="stat-value">{Math.round(maxAngle)}°</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Recorded At</span>
            <span className="stat-value" style={{ fontSize: "1.1rem" }}>{getFormattedTime()}</span>
          </div>
        </div>

        <div className="summary-actions">
          {!saved ? (
            <button
              id="save-session-btn"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Session"}
            </button>
          ) : (
            <span className="saved-badge">Saved ✓</span>
          )}
          <button
            id="new-session-btn"
            className="btn btn-secondary"
            onClick={onNewSession}
          >
            New Session
          </button>
        </div>

        {saveNote && (
          <p style={{ marginTop: "0.85rem", fontSize: "0.88rem", color: "var(--accent)" }}>
            {saveNote}
          </p>
        )}

        {saved && !authed && (
          <div className="auth-sync-prompt" style={{ marginTop: "1rem", padding: "0.75rem", background: "rgba(255,255,255,0.04)", borderRadius: "8px", border: "1px solid var(--border-glass)" }}>
            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
              Want to keep this in your permanent account history?
            </p>
            <Link to="/login" className="btn btn-secondary" style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}>
              Sign In / Create Account
            </Link>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
