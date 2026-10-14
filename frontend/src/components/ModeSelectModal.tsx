interface ModeSelectModalProps {
  onSelectAuto: () => void;
  onSelectManual: () => void;
  onOpenShortcuts: () => void;
}

export default function ModeSelectModal({
  onSelectAuto,
  onSelectManual,
  onOpenShortcuts,
}: ModeSelectModalProps) {
  return (
    <div className="modal-backdrop">
      <div
        className="glass-card mode-select-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="mode-select-title"
      >
        <div className="mode-select-header">
          <h2 id="mode-select-title" className="mode-select-title">
            Welcome to Pocket Physio
          </h2>
          <p className="mode-select-subtitle">
            Select your camera setup to begin knee kinematics tracking.
          </p>
        </div>

        <div className="mode-select-cards">
          {/* Auto Calibration - Frontal */}
          <div
            className="mode-card"
            onClick={onSelectAuto}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectAuto();
              }
            }}
          >
            <div className="mode-card-body">
              <div className="mode-card-header">
                <h3 className="mode-card-title">Auto Calibration</h3>
                <span className="mode-badge">Frontal</span>
              </div>
              <p className="mode-card-desc">
                Face the camera front-on. Move both legs through your full range of motion simultaneously.
              </p>
            </div>
            <button
              id="auto-calib-btn"
              type="button"
              className="btn btn-primary mode-card-btn"
              onClick={(e) => {
                e.stopPropagation();
                onSelectAuto();
              }}
            >
              Start Auto [A]
            </button>
          </div>

          {/* Manual Calibration - Side-on */}
          <div
            className="mode-card"
            onClick={onSelectManual}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectManual();
              }
            }}
          >
            <div className="mode-card-body">
              <div className="mode-card-header">
                <h3 className="mode-card-title">Manual Calibration</h3>
                <span className="mode-badge">Side-on</span>
              </div>
              <p className="mode-card-desc">
                Position camera to your side. Step through guided angle captures for extension and flexion on each leg.
              </p>
            </div>
            <button
              id="manual-calib-btn"
              type="button"
              className="btn btn-secondary mode-card-btn"
              onClick={(e) => {
                e.stopPropagation();
                onSelectManual();
              }}
            >
              Start Manual [M]
            </button>
          </div>
        </div>

        <div className="mode-select-footer">
          <span className="mode-select-hint">
            Press <kbd className="kbd-badge">A</kbd> for Auto or <kbd className="kbd-badge">M</kbd> for Manual
          </span>
          <button
            id="shortcuts-btn"
            type="button"
            className="btn-link mode-shortcuts-btn"
            onClick={onOpenShortcuts}
          >
            Shortcuts [?]
          </button>
        </div>
      </div>
    </div>
  );
}
