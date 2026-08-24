// state machine that mirrors the calibration and tracking flow from main.py.
// manages mode selection, auto/manual calibration, and live tracking.
// supports keyboard shortcuts ('a', 'm', 'q', Space, Enter), canvas clicks, and on-screen controls.

import { useState, useRef, useCallback, useEffect } from "react";
import { PoseEngine, type PoseState } from "../engine/poseEngine";
import { KinematicsTracker } from "../engine/kinematicsTracker";
import CameraView from "./CameraView";
import SessionSummary from "./SessionSummary";
import { drawHudText } from "../engine/drawUtils";

type CalibState =
  | "loading"
  | "mode_select"
  | "auto_calibrate_countdown"
  | "auto_calibrate"
  | "manual_min_l"
  | "manual_max_l"
  | "manual_min_r"
  | "manual_max_r"
  | "tracking"
  | "session_end";

const CALIB_DELAY = 5; // seconds

export default function CalibrationFlow() {
  const [state, setState] = useState<CalibState>("loading");
  const [engineReady, setEngineReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const engineRef = useRef(new PoseEngine());
  const trackerRef = useRef(new KinematicsTracker("left"));
  const latestPoseRef = useRef<PoseState | null>(null);

  // calibration accumulators
  const minL = useRef<number | null>(null);
  const maxL = useRef<number | null>(null);
  const minR = useRef<number | null>(null);
  const maxR = useRef<number | null>(null);
  const countdownStart = useRef<number>(0);

  // session tracking for summary
  const sessionMaxLean = useRef(0);

  // start auto calibration flow
  const startAutoCalib = useCallback(() => {
    countdownStart.current = performance.now();
    minL.current = maxL.current = minR.current = maxR.current = null;
    engineRef.current.resetFilters();
    engineRef.current.alpha = 0.6; // faster response during calibration
    setState("auto_calibrate_countdown");
  }, []);

  // start manual calibration flow
  const startManualCalib = useCallback(() => {
    minL.current = maxL.current = minR.current = maxR.current = null;
    engineRef.current.resetFilters();
    setState("manual_min_l");
  }, []);

  // reliable countdown timer effect
  useEffect(() => {
    if (state !== "auto_calibrate_countdown") return;

    const interval = setInterval(() => {
      const elapsed = (performance.now() - countdownStart.current) / 1000;
      if (elapsed >= CALIB_DELAY) {
        setState("auto_calibrate");
      }
    }, 100);

    return () => clearInterval(interval);
  }, [state]);

  // initialize the mediapipe engine on mount
  useEffect(() => {
    let mounted = true;
    engineRef.current
      .init()
      .then(() => {
        if (mounted) {
          setEngineReady(true);
          setState("mode_select");
        }
      })
      .catch((err) => {
        if (mounted) {
          setErrorMessage(
            err instanceof Error
              ? err.message
              : "Failed to initialize MediaPipe pose tracker"
          );
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // advance / lock step handler (shared by click, on-screen button, and keyboard)
  const handleLockOrAdvance = useCallback(() => {
    const pose = latestPoseRef.current;
    const engine = engineRef.current;
    const tracker = trackerRef.current;

    if (state === "mode_select") {
      startAutoCalib();
    } else if (state === "auto_calibrate") {
      // determine bounds, falling back gracefully to sensible defaults if unobserved
      const lMin = minL.current ?? (pose?.leftKneeAngle ? pose.leftKneeAngle - 10 : 80);
      const lMax = maxL.current ?? (pose?.leftKneeAngle ? pose.leftKneeAngle + 10 : 160);
      const rMin = minR.current ?? (pose?.rightKneeAngle ? pose.rightKneeAngle - 10 : 80);
      const rMax = maxR.current ?? (pose?.rightKneeAngle ? pose.rightKneeAngle + 10 : 160);

      const romL = lMax - lMin;
      const romR = rMax - rMin;
      engine.injuredSide = romL < romR ? "left" : "right";
      engine.alpha = 0.25;
      engine.resetFilters();

      const injMin = engine.injuredSide === "left" ? lMin : rMin;
      const injMax = engine.injuredSide === "left" ? lMax : rMax;
      tracker.injuredSide = engine.injuredSide;
      tracker.updateLimits(injMin, injMax);
      sessionMaxLean.current = 0;
      setState("tracking");
    } else if (state === "manual_min_l") {
      minL.current = pose ? pose.leftKneeAngle : 90;
      setState("manual_max_l");
    } else if (state === "manual_max_l") {
      maxL.current = pose ? pose.leftKneeAngle : 160;
      setState("manual_min_r");
    } else if (state === "manual_min_r") {
      minR.current = pose ? pose.rightKneeAngle : 90;
      setState("manual_max_r");
    } else if (state === "manual_max_r") {
      maxR.current = pose ? pose.rightKneeAngle : 160;
      const romL = (maxL.current ?? 160) - (minL.current ?? 90);
      const romR = (maxR.current ?? 160) - (minR.current ?? 90);
      engine.injuredSide = romL < romR ? "left" : "right";
      engine.resetFilters();

      const injMin = engine.injuredSide === "left" ? minL.current : minR.current;
      const injMax = engine.injuredSide === "left" ? maxL.current : maxR.current;
      tracker.injuredSide = engine.injuredSide;
      tracker.updateLimits(injMin, injMax);
      sessionMaxLean.current = 0;
      setState("tracking");
    } else if (state === "tracking") {
      setState("session_end");
    }
  }, [state, startAutoCalib]);

  // keyboard handler for mode selection & step locking
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // ignore typing in form inputs
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      if (state === "mode_select") {
        if (e.key === "a" || e.key === "A") {
          startAutoCalib();
        } else if (e.key === "m" || e.key === "M") {
          startManualCalib();
        }
      } else if (
        state === "auto_calibrate" ||
        state.startsWith("manual_")
      ) {
        if (e.key === " " || e.key === "Enter" || e.key === "c" || e.key === "C") {
          e.preventDefault();
          handleLockOrAdvance();
        }
      } else if (state === "tracking" && (e.key === "q" || e.key === "Q")) {
        setState("session_end");
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state, startAutoCalib, startManualCalib, handleLockOrAdvance]);

  // per-frame callback: update calibration accumulators during auto-calibrate
  const onFrame = useCallback(
    (pose: PoseState | null) => {
      latestPoseRef.current = pose;

      // advance countdown -> auto_calibrate
      if (state === "auto_calibrate_countdown") {
        if (performance.now() - countdownStart.current >= CALIB_DELAY * 1000) {
          setState("auto_calibrate");
        }
        return;
      }

      if (state === "auto_calibrate" && pose) {
        if (pose.leftVisible) {
          const l = pose.leftKneeAngle;
          if (l > 10) {
            minL.current = minL.current === null ? l : Math.min(minL.current, l);
            maxL.current = maxL.current === null ? l : Math.max(maxL.current, l);
          }
        }
        if (pose.rightVisible) {
          const r = pose.rightKneeAngle;
          if (r > 10) {
            minR.current = minR.current === null ? r : Math.min(minR.current, r);
            maxR.current = maxR.current === null ? r : Math.max(maxR.current, r);
          }
        }
      }

      // track max lean during session
      if (state === "tracking" && pose) {
        sessionMaxLean.current = Math.max(sessionMaxLean.current, pose.bodyLean);
      }
    },
    [state]
  );

  // hud renderer — draws text on the canvas overlay based on current state.
  const renderHud = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      pose: PoseState | null,
      _width: number,
      height: number
    ) => {
      const anglesValid = pose !== null;
      const fontSize = Math.max(16, Math.round(height * 0.028));
      const lineGap = Math.round(fontSize * 1.6);
      let y = Math.round(height * 0.06);

      if (state === "mode_select") {
        drawHudText(
          ctx,
          "Press 'A' for Auto (Frontal) or 'M' for Manual (Side-on)",
          24,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        drawHudText(
          ctx,
          "Or use the control buttons below",
          24,
          y,
          "rgba(255,255,255,0.7)",
          Math.round(fontSize * 0.85)
        );
      } else if (state === "auto_calibrate_countdown") {
        const elapsed = (performance.now() - countdownStart.current) / 1000;
        const remaining = Math.max(0, Math.ceil(CALIB_DELAY - elapsed));
        drawHudText(
          ctx,
          `Face camera frontal. Calibration begins in ${remaining}s`,
          24,
          y,
          "#ffaa00",
          fontSize
        );
      } else if (state === "auto_calibrate") {
        drawHudText(
          ctx,
          "Face frontal. Move both legs through ROM. Click or press Space to lock.",
          24,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        if (anglesValid) {
          const cl =
            pose.leftVisible && pose.leftKneeAngle > 10
              ? Math.round(pose.leftKneeAngle)
              : "--";
          const cr =
            pose.rightVisible && pose.rightKneeAngle > 10
              ? Math.round(pose.rightKneeAngle)
              : "--";
          const lStr =
            minL.current !== null
              ? `curr: ${cl}° | max: ${Math.round(maxL.current!)}° | min: ${Math.round(minL.current)}° | rom: ${Math.round(maxL.current! - minL.current)}°`
              : `curr: ${cl}° | waiting...`;
          const rStr =
            minR.current !== null
              ? `curr: ${cr}° | max: ${Math.round(maxR.current!)}° | min: ${Math.round(minR.current)}° | rom: ${Math.round(maxR.current! - minR.current)}°`
              : `curr: ${cr}° | waiting...`;
          drawHudText(ctx, `Left:  ${lStr}`, 24, y, "#67e8f9", fontSize);
          y += lineGap;
          drawHudText(ctx, `Right: ${rStr}`, 24, y, "#67e8f9", fontSize);
        } else {
          drawHudText(
            ctx,
            "Low confidence. Ensure full body is visible.",
            24,
            y,
            "#ff6600",
            Math.round(fontSize * 0.9)
          );
        }
      } else if (state === "manual_min_l") {
        drawHudText(
          ctx,
          "Face LEFT side toward camera. Bend left knee. Click to lock.",
          24,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        if (anglesValid) {
          drawHudText(
            ctx,
            `Left knee: ${Math.round(pose.leftKneeAngle)}°`,
            24,
            y,
            "#67e8f9",
            fontSize
          );
        }
      } else if (state === "manual_max_l") {
        drawHudText(
          ctx,
          "Face LEFT side toward camera. Straighten left leg. Click to lock.",
          24,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        if (anglesValid) {
          drawHudText(
            ctx,
            `Left knee: ${Math.round(pose.leftKneeAngle)}°`,
            24,
            y,
            "#67e8f9",
            fontSize
          );
        }
      } else if (state === "manual_min_r") {
        drawHudText(
          ctx,
          "Face RIGHT side toward camera. Bend right knee. Click to lock.",
          24,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        if (anglesValid) {
          drawHudText(
            ctx,
            `Right knee: ${Math.round(pose.rightKneeAngle)}°`,
            24,
            y,
            "#67e8f9",
            fontSize
          );
        }
      } else if (state === "manual_max_r") {
        drawHudText(
          ctx,
          "Face RIGHT side toward camera. Straighten right leg. Click to lock.",
          24,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        if (anglesValid) {
          drawHudText(
            ctx,
            `Right knee: ${Math.round(pose.rightKneeAngle)}°`,
            24,
            y,
            "#67e8f9",
            fontSize
          );
        }
      } else if (state === "tracking") {
        const tracker = trackerRef.current;
        drawHudText(
          ctx,
          `Tracking ${tracker.injuredSide.toUpperCase()} leg...`,
          24,
          y,
          "#44ff44",
          fontSize
        );
        y += lineGap;

        const injVisible = anglesValid
          ? tracker.injuredSide === "left"
            ? pose.leftVisible
            : pose.rightVisible
          : false;

        if (anglesValid && injVisible) {
          const fb = tracker.evaluate(pose);
          drawHudText(
            ctx,
            `curr: ${Math.round(fb.currentAngle)}° | max: ${Math.round(fb.maxAngle)}° | min: ${Math.round(fb.minAngle)}° | ROM: ${Math.round(fb.rom)}°`,
            24,
            y,
            fb.angleColor,
            fontSize
          );
          y += lineGap;
          drawHudText(
            ctx,
            `load: ${fb.injuredLoad}% injured | ${fb.healthyLoad}% healthy`,
            24,
            y,
            "#ffdd44",
            fontSize
          );
          y += lineGap;
          drawHudText(ctx, fb.leanText, 24, y, fb.leanColor, fontSize);
        } else if (anglesValid && !injVisible) {
          drawHudText(
            ctx,
            "Injured leg out of frame. Ensure ankle & hip are visible.",
            24,
            y,
            "#ff6600",
            fontSize
          );
        } else {
          drawHudText(
            ctx,
            "Low confidence. Ensure full body is visible.",
            24,
            y,
            "#ff6600",
            fontSize
          );
        }

        drawHudText(
          ctx,
          "Press 'Q' or click 'End Session' to finish",
          24,
          height - 24,
          "rgba(255,255,255,0.6)",
          Math.round(fontSize * 0.8)
        );
      }
    },
    [state]
  );

  if (errorMessage) {
    return (
      <div className="camera-error glass-card">
        <h3>Model Error</h3>
        <p className="error-text">{errorMessage}</p>
        <button
          className="btn btn-primary"
          style={{ marginTop: "1rem" }}
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (state === "loading" || !engineReady) {
    return (
      <div className="loading-screen glass-card">
        <div className="spinner" />
        <p>Loading MediaPipe Pose WASM engine...</p>
        <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
          Runs locally on your device with WebAssembly
        </span>
      </div>
    );
  }

  if (state === "session_end") {
    const tracker = trackerRef.current;
    const injMin = tracker.injuredSide === "left" ? (minL.current ?? 90) : (minR.current ?? 90);
    const injMax = tracker.injuredSide === "left" ? (maxL.current ?? 160) : (maxR.current ?? 160);
    const injRom = Math.max(0, injMax - injMin);

    return (
      <SessionSummary
        injuredSide={tracker.injuredSide}
        minAngle={Math.round(injMin)}
        maxAngle={Math.round(injMax)}
        rom={Math.round(injRom)}
        bodyLeanMax={Math.round(sessionMaxLean.current)}
        onNewSession={() => {
          minL.current = maxL.current = minR.current = maxR.current = null;
          engineRef.current.resetFilters();
          sessionMaxLean.current = 0;
          setState("mode_select");
        }}
      />
    );
  }

  const isFrontal = state.startsWith("auto_calibrate") || state === "mode_select";

  return (
    <div className="session-view-wrapper">
      <CameraView
        engine={engineRef.current}
        isFrontal={isFrontal}
        onFrame={onFrame}
        renderHud={renderHud}
        onCanvasClick={handleLockOrAdvance}
      />

      {/* on-screen action bar for reliable peripheral & touch control */}
      <div className="session-controls glass-card">
        {state === "mode_select" && (
          <div className="control-button-group">
            <button
              id="auto-calib-btn"
              className="btn btn-primary"
              onClick={startAutoCalib}
            >
              Auto Calibration (Frontal) [A]
            </button>
            <button
              id="manual-calib-btn"
              className="btn btn-secondary"
              onClick={startManualCalib}
            >
              Manual Calibration (Side-on) [M]
            </button>
          </div>
        )}

        {state === "auto_calibrate_countdown" && (
          <div className="control-info">
            <span>Get in position facing the camera...</span>
          </div>
        )}

        {state === "auto_calibrate" && (
          <div className="control-button-group">
            <button
              id="lock-calib-btn"
              className="btn btn-primary"
              onClick={handleLockOrAdvance}
            >
              Lock Range & Start Tracking [Space / Click]
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setState("mode_select")}
            >
              Reset Mode
            </button>
          </div>
        )}

        {state.startsWith("manual_") && (
          <div className="control-button-group">
            <button
              id="manual-next-btn"
              className="btn btn-primary"
              onClick={handleLockOrAdvance}
            >
              Lock Angle & Next Step [Space / Click]
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setState("mode_select")}
            >
              Cancel
            </button>
          </div>
        )}

        {state === "tracking" && (
          <div className="control-button-group">
            <button
              id="end-session-btn"
              className="btn btn-primary"
              onClick={() => setState("session_end")}
            >
              End Session [Q]
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                engineRef.current.resetFilters();
                setState("mode_select");
              }}
            >
              Recalibrate
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
