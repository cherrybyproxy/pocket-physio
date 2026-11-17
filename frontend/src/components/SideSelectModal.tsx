import { useEffect } from "react";

interface SideSelectModalProps {
  onSelectSide: (side: "left" | "right" | "both") => void;
  onBack: () => void;
}

export default function SideSelectModal({
  onSelectSide,
  onBack,
}: SideSelectModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        onSelectSide("left");
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        onSelectSide("right");
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        onSelectSide("both");
      } else if (e.key === "q" || e.key === "Q") {
        e.preventDefault();
        onBack();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSelectSide, onBack]);

  return (
    <div className="modal-backdrop">
      <div
        className="glass-card mode-select-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="side-select-title"
      >
        <div className="mode-select-header">
          <h2 id="side-select-title" className="mode-select-title">
            Select Leg to Calibrate
          </h2>
          <p className="mode-select-subtitle">
            Choose the target leg or calibrate both legs to compare Range of Motion.
          </p>
        </div>

        <div className="mode-select-cards" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {/* Left Leg */}
          <div
            className="mode-card"
            onClick={() => onSelectSide("left")}
            role="button"
            tabIndex={0}
            style={{ borderColor: "rgba(172, 56, 52, 0.4)" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectSide("left");
              }
            }}
          >
            <div className="mode-card-body">
              <div className="mode-card-header">
                <h3 className="mode-card-title">Left Leg</h3>
              </div>
              <p className="mode-card-desc">
                Position the camera to view the left side.
              </p>
            </div>
            <button
              id="select-left-leg-btn"
              type="button"
              className="btn btn-primary mode-card-btn"
              style={{
                backgroundColor: "#AC3834",
                borderColor: "#AC3834",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectSide("left");
              }}
            >
              Left Leg [L]
            </button>
          </div>

          {/* Right Leg */}
          <div
            className="mode-card"
            onClick={() => onSelectSide("right")}
            role="button"
            tabIndex={0}
            style={{ borderColor: "rgba(66, 146, 198, 0.4)" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectSide("right");
              }
            }}
          >
            <div className="mode-card-body">
              <div className="mode-card-header">
                <h3 className="mode-card-title">Right Leg</h3>
              </div>
              <p className="mode-card-desc">
                Position the camera to view the right side.
              </p>
            </div>
            <button
              id="select-right-leg-btn"
              type="button"
              className="btn btn-primary mode-card-btn"
              style={{
                backgroundColor: "#4292C6",
                borderColor: "#4292C6",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectSide("right");
              }}
            >
              Right Leg [R]
            </button>
          </div>
        </div>

        {/* Both Legs option */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.85rem 1.15rem",
            background: "var(--bg-secondary)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <div style={{ textAlign: "left" }}>
            <h3 className="mode-card-title">Both Legs</h3>
            <p style={{ margin: "0.3rem 0 0 0", fontSize: "0.84rem", color: "var(--text-secondary)" }}>
              Step through left and right leg calibration.
            </p>
          </div>
          <button
            id="select-both-legs-btn"
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: "0.88rem", padding: "0.55rem 1rem" }}
            onClick={() => onSelectSide("both")}
          >
            Both Legs [B]
          </button>
        </div>

        <div className="mode-select-footer">
          <span className="mode-select-hint">
            Press <kbd className="kbd-badge">L</kbd> for Left, <kbd className="kbd-badge">R</kbd> for Right, or <kbd className="kbd-badge">B</kbd> for Both
          </span>
          <button
            id="back-to-mode-btn"
            type="button"
            className="btn-link mode-shortcuts-btn"
            onClick={onBack}
          >
            ← Back [Q]
          </button>
        </div>
      </div>
    </div>
  );
}
