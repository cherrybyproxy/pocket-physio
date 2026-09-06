import { useEffect } from "react";

interface ShortcutsModalProps {
  onClose: () => void;
}

interface ShortcutItem {
  command: string;
  action: string;
  stageSpecific: "Yes" | "No";
}

const SHORTCUTS: ShortcutItem[] = [
  { command: "?", action: "Open / close shortcuts manual", stageSpecific: "No" },
  { command: "M", action: "Manual calibration", stageSpecific: "Yes" },
  { command: "A", action: "Auto calibration", stageSpecific: "Yes" },
  { command: "Space / Click", action: "Lock angle / range & advance", stageSpecific: "No" },
  { command: "W", action: "Movement Watcher", stageSpecific: "Yes" },
  { command: "T", action: "Movement Trainer", stageSpecific: "Yes" },
  { command: "F", action: "Freestyle mode", stageSpecific: "Yes" },
  { command: "P", action: "Planned routine configuration", stageSpecific: "Yes" },
  { command: "S", action: "Summary (End session)", stageSpecific: "Yes" },
  { command: "Q", action: "Cancel / Recalibrate", stageSpecific: "No" },
  { command: "Esc", action: "Close modal / dialog", stageSpecific: "No" },
];

export default function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="glass-card shortcuts-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-modal-header">
          <h3>Keyboard Shortcuts Manual</h3>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="shortcuts-table-container">
          <div className="shortcuts-grid-header">
            <div className="col-cmd">Command</div>
            <div className="col-action">Action</div>
            <div className="col-stage">Stage Specific</div>
          </div>

          <div className="shortcuts-body-wrapper">
            {SHORTCUTS.map((item) => (
              <div key={item.command} className="shortcuts-grid-row">
                <div className="col-cmd">
                  <kbd className="kbd-badge">{item.command}</kbd>
                </div>
                <div className="col-action">{item.action}</div>
                <div className="col-stage">{item.stageSpecific}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="shortcuts-modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
