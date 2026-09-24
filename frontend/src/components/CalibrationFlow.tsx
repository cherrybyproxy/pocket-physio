// state machine that mirrors the calibration and tracking flow from main.py.
// manages mode selection, auto/manual calibration, and live tracking.
// supports keyboard shortcuts ('a', 'm', 'q', Space, Enter), canvas clicks, and on-screen controls.

import { useState, useRef, useCallback, useEffect } from "react";
import { PoseEngine, type PoseState } from "../engine/poseEngine";
import { KinematicsTracker } from "../engine/kinematicsTracker";
import CameraView from "./CameraView";
import SessionSummary from "./SessionSummary";
import ShortcutsModal from "./ShortcutsModal";
import { drawHudText, drawTargetArcGauge } from "../engine/drawUtils";

type TrackingMode = "watcher" | "trainer";
type TrainerSubMode = "freestyle" | "planned";

type CalibState =
  | "loading"
  | "mode_select"
  | "auto_calibrate_countdown"
  | "auto_calibrate"
  | "manual_min_l"
  | "manual_max_l"
  | "manual_min_r"
  | "manual_max_r"
  | "tracking_mode_select"
  | "tracking"
  | "session_end";

const CALIB_DELAY = 5; // seconds

type PlannedPattern = "sequential" | "alternating";

export default function CalibrationFlow() {
  const [state, setState] = useState<CalibState>("loading");
  const [trackingMode, setTrackingMode] = useState<TrackingMode>("watcher");
  const [trainerSubMode, setTrainerSubMode] = useState<TrainerSubMode>("freestyle");
  const [plannedTargetReps, setPlannedTargetReps] = useState<number>(5);
  const [plannedPattern, setPlannedPattern] = useState<PlannedPattern>("sequential");

  // planned routine modal pop-up state
  const [showPlannedModal, setShowPlannedModal] = useState<boolean>(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false);
  const [showRecalibrateModal, setShowRecalibrateModal] = useState<boolean>(false);
  const [recalibrateCountdown, setRecalibrateCountdown] = useState<number>(5);
  const [isTrainingCompleteModal, setIsTrainingCompleteModal] = useState<boolean>(false);
  const [plannedRepInput, setPlannedRepInput] = useState<string>("5");
  const [plannedDurationInput, setPlannedDurationInput] = useState<string>("1.0");
  const [plannedInputError, setPlannedInputError] = useState<string | null>(null);

  const [engineReady, setEngineReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const engineRef = useRef(new PoseEngine());
  const trackerRef = useRef(new KinematicsTracker("left"));
  const latestPoseRef = useRef<PoseState | null>(null);
  const completionTriggeredRef = useRef<boolean>(false);

  // 5-second auto-closing countdown for recalibration confirmation modal
  useEffect(() => {
    if (!showRecalibrateModal) return;

    setRecalibrateCountdown(5);
    const interval = setInterval(() => {
      setRecalibrateCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setShowRecalibrateModal(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [showRecalibrateModal]);

  const handleSavePlannedConfig = useCallback(() => {
    const parsedReps = parseInt(plannedRepInput.trim(), 10);
    const parsedDuration = parseFloat(plannedDurationInput.trim());

    if (isNaN(parsedReps) || !Number.isInteger(parsedReps) || parsedReps < 1 || parsedReps > 99) {
      setPlannedInputError("Target reps must be a whole number between 1 and 99.");
      return;
    }

    if (isNaN(parsedDuration) || parsedDuration < 0.1 || parsedDuration > 30.0) {
      setPlannedInputError("Hold duration must be a number between 0.1 and 30 seconds.");
      return;
    }

    const roundedDuration = Math.round(parsedDuration * 10) / 10;
    setPlannedTargetReps(parsedReps);
    trackerRef.current.setTargetHoldDuration(roundedDuration);
    trackerRef.current.resetPlannedStats();
    completionTriggeredRef.current = false;
    setPlannedInputError(null);
    setShowPlannedModal(false);
    setIsTrainingCompleteModal(false);
    setTrainerSubMode("planned");
  }, [plannedRepInput, plannedDurationInput]);

  // calibration accumulators
  const minL = useRef<number | null>(null);
  const maxL = useRef<number | null>(null);
  const minR = useRef<number | null>(null);
  const maxR = useRef<number | null>(null);
  const countdownStart = useRef<number>(0);

  // session tracking for summary
  const sessionMaxLean = useRef(0);
  const sessionMaxLoad = useRef(0);
  const hasWatchingDataRef = useRef(false);
  const hasTrainingDataRef = useRef(false);
  const previousStateRef = useRef<CalibState>("tracking");

  // reset all session and calibration state back to mode selection screen
  const resetSession = useCallback(() => {
    setShowRecalibrateModal(false);
    minL.current = maxL.current = minR.current = maxR.current = null;
    engineRef.current.resetFilters();
    sessionMaxLean.current = 0;
    sessionMaxLoad.current = 0;
    hasWatchingDataRef.current = false;
    hasTrainingDataRef.current = false;
    setShowPlannedModal(false);
    setPlannedInputError(null);
    trackerRef.current.updateLimits(null, null);
    trackerRef.current.resetRepStats();
    setState("mode_select");
  }, []);

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
      if (
        minL.current === null ||
        maxL.current === null ||
        minR.current === null ||
        maxR.current === null
      ) {
        return;
      }
      const lMin = minL.current;
      const lMax = maxL.current;
      const rMin = minR.current;
      const rMax = maxR.current;

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
      setState("tracking_mode_select");
    } else if (state === "manual_min_l") {
      if (!pose || !pose.leftVisible || isNaN(pose.leftKneeAngle)) return;
      minL.current = pose.leftKneeAngle;
      setState("manual_max_l");
    } else if (state === "manual_max_l") {
      if (!pose || !pose.leftVisible || isNaN(pose.leftKneeAngle)) return;
      maxL.current = pose.leftKneeAngle;
      setState("manual_min_r");
    } else if (state === "manual_min_r") {
      if (!pose || !pose.rightVisible || isNaN(pose.rightKneeAngle)) return;
      minR.current = pose.rightKneeAngle;
      setState("manual_max_r");
    } else if (state === "manual_max_r") {
      if (!pose || !pose.rightVisible || isNaN(pose.rightKneeAngle)) return;
      maxR.current = pose.rightKneeAngle;

      if (
        minL.current === null ||
        maxL.current === null ||
        minR.current === null ||
        maxR.current === null
      ) {
        return;
      }

      const romL = maxL.current - minL.current;
      const romR = maxR.current - minR.current;
      engine.injuredSide = romL < romR ? "left" : "right";
      engine.resetFilters();

      const injMin = engine.injuredSide === "left" ? minL.current : minR.current;
      const injMax = engine.injuredSide === "left" ? maxL.current : maxR.current;
      tracker.injuredSide = engine.injuredSide;
      tracker.updateLimits(injMin, injMax);
      sessionMaxLean.current = 0;
      setState("tracking_mode_select");
    } else if (state === "tracking_mode_select") {
      setState("tracking");
    } else if (state === "tracking") {
      return;
    }
  }, [state, startAutoCalib]);

  // keyboard handler for mode selection & step locking
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (showPlannedModal) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // handle shortcuts inside recalibration confirmation modal
      if (showRecalibrateModal) {
        if (e.key === "q" || e.key === "Q" || e.key === "y" || e.key === "Y" || e.key === "Enter") {
          e.preventDefault();
          setShowRecalibrateModal(false);
          resetSession();
        } else if (e.key === "Escape" || e.key === "n" || e.key === "N") {
          e.preventDefault();
          setShowRecalibrateModal(false);
        }
        return;
      }

      // ignore typing in form inputs
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      if (state === "mode_select") {
        if (e.key === "q" || e.key === "Q") {
          resetSession();
          return;
        }
        if (e.key === "a" || e.key === "A") {
          startAutoCalib();
        } else if (e.key === "m" || e.key === "M") {
          startManualCalib();
        }
      } else if (state === "tracking_mode_select") {
        if (e.key === "q" || e.key === "Q") {
          resetSession();
          return;
        }
        if (e.key === "w" || e.key === "W") {
          setTrackingMode("watcher");
          setState("tracking");
        } else if (e.key === "t" || e.key === "T") {
          setTrackingMode("trainer");
          setState("tracking");
        } else if (e.key === "s" || e.key === "S") {
          previousStateRef.current = "tracking_mode_select";
          setState("session_end");
        } else if (e.key === " " || e.key === "Enter" || e.key === "c" || e.key === "C") {
          e.preventDefault();
          handleLockOrAdvance();
        }
      } else if (
        state === "auto_calibrate_countdown" ||
        state === "auto_calibrate"
      ) {
        if (e.key === "q" || e.key === "Q") {
          resetSession();
          return;
        }
        if (e.key === "m" || e.key === "M") {
          startManualCalib();
          return;
        }
        if (e.key === " " || e.key === "Enter" || e.key === "c" || e.key === "C") {
          e.preventDefault();
          handleLockOrAdvance();
        }
      } else if (state.startsWith("manual_")) {
        if (e.key === "q" || e.key === "Q") {
          resetSession();
          return;
        }
        if (e.key === "a" || e.key === "A") {
          startAutoCalib();
          return;
        }
        if (e.key === " " || e.key === "Enter" || e.key === "c" || e.key === "C") {
          e.preventDefault();
          handleLockOrAdvance();
        }
      } else if (state === "tracking") {
        if (e.key === "q" || e.key === "Q") {
          setShowRecalibrateModal(true);
          return;
        }
        if (e.key === "w" || e.key === "W") {
          setTrackingMode("watcher");
        } else if (e.key === "t" || e.key === "T") {
          setTrackingMode("trainer");
        } else if (e.key === "f" || e.key === "F") {
          setTrainerSubMode("freestyle");
        } else if (e.key === "p" || e.key === "P") {
          setTrackingMode("trainer");
          setShowPlannedModal(true);
        } else if (e.key === "s" || e.key === "S") {
          previousStateRef.current = "tracking";
          setState("session_end");
        }
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state, showPlannedModal, showRecalibrateModal, startAutoCalib, startManualCalib, handleLockOrAdvance, resetSession]);

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
        if (pose.leftVisible && !isNaN(pose.leftKneeAngle)) {
          const l = pose.leftKneeAngle;
          minL.current = minL.current === null ? l : Math.min(minL.current, l);
          maxL.current = maxL.current === null ? l : Math.max(maxL.current, l);
        }
        if (pose.rightVisible && !isNaN(pose.rightKneeAngle)) {
          const r = pose.rightKneeAngle;
          minR.current = minR.current === null ? r : Math.min(minR.current, r);
          maxR.current = maxR.current === null ? r : Math.max(maxR.current, r);
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
      const fontSize = Math.max(24, Math.round(height * 0.042));
      const lineGap = Math.round(fontSize * 1.35);
      let y = 20;

      const leftX = 24;
      const rightX = Math.round(_width / 2 + 24);

      if (state === "mode_select") {
        drawHudText(
          ctx,
          "Select Auto (Frontal) or Manual (Side-on)",
          leftX,
          y,
          "#ffffff",
          fontSize
        );
      } else if (state === "auto_calibrate_countdown") {
        const elapsed = (performance.now() - countdownStart.current) / 1000;
        const remaining = Math.max(0, Math.ceil(CALIB_DELAY - elapsed));
        drawHudText(
          ctx,
          `Face camera frontal. Calibration begins in ${remaining}s`,
          leftX,
          y,
          "#ffaa00",
          fontSize
        );
      } else if (state === "auto_calibrate") {
        const leftValid = anglesValid && pose.leftVisible && !isNaN(pose.leftKneeAngle);
        const rightValid = anglesValid && pose.rightVisible && !isNaN(pose.rightKneeAngle);

        let autoInstruction = "Move both legs through full ROM.";
        if (!leftValid && !rightValid) {
          autoInstruction += " Ensure legs are visible.";
        } else if (!leftValid) {
          autoInstruction += " Ensure left leg is visible.";
        } else if (!rightValid) {
          autoInstruction += " Ensure right leg is visible.";
        }

        drawHudText(
          ctx,
          autoInstruction,
          leftX,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;

        const lLine1 = leftValid
          ? `LEFT: curr: ${Math.round(pose.leftKneeAngle)}°`
          : "LEFT: curr: --°";
        const lLine2 = leftValid
          ? minL.current !== null
            ? `rom: ${Math.round(maxL.current! - minL.current)}° (min ${Math.round(minL.current)}° | max ${Math.round(maxL.current!)}°)`
            : "move through ROM"
          : "";

        const rLine1 = rightValid
          ? `RIGHT: curr: ${Math.round(pose.rightKneeAngle)}°`
          : "RIGHT: curr: --°";
        const rLine2 = rightValid
          ? minR.current !== null
            ? `rom: ${Math.round(maxR.current! - minR.current)}° (min ${Math.round(minR.current)}° | max ${Math.round(maxR.current!)}°)`
            : "move through ROM"
          : "";

        // Left leg stats on left side of screen
        drawHudText(ctx, lLine1, leftX, y, "#AC3834", fontSize);
        if (lLine2) {
          drawHudText(ctx, lLine2, leftX, y + lineGap, "#AC3834", fontSize);
        }

        // Right leg stats on right side of screen (no divider line)
        drawHudText(ctx, rLine1, rightX, y, "#4292C6", fontSize);
        if (rLine2) {
          drawHudText(ctx, rLine2, rightX, y + lineGap, "#4292C6", fontSize);
        }

        y += lineGap * 2;
      } else if (state === "manual_min_l") {
        const leftValid = anglesValid && pose.leftVisible && !isNaN(pose.leftKneeAngle);
        const instruction = leftValid
          ? "Straighten left leg."
          : "Straighten left leg. Ensure leg is visible.";
        drawHudText(
          ctx,
          instruction,
          leftX,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        const lStr = leftValid
          ? `LEFT: curr: ${Math.round(pose.leftKneeAngle)}°`
          : "LEFT: curr: --°";
        drawHudText(ctx, lStr, leftX, y, "#AC3834", fontSize);
      } else if (state === "manual_max_l") {
        const leftValid = anglesValid && pose.leftVisible && !isNaN(pose.leftKneeAngle);
        const instruction = leftValid
          ? "Bend left knee."
          : "Bend left knee. Ensure leg is visible.";
        drawHudText(
          ctx,
          instruction,
          leftX,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        const lStr = leftValid
          ? `LEFT: curr: ${Math.round(pose.leftKneeAngle)}°`
          : "LEFT: curr: --°";
        drawHudText(ctx, lStr, leftX, y, "#AC3834", fontSize);
      } else if (state === "manual_min_r") {
        const rightValid = anglesValid && pose.rightVisible && !isNaN(pose.rightKneeAngle);
        const instruction = rightValid
          ? "Straighten right leg."
          : "Straighten right leg. Ensure leg is visible.";
        drawHudText(
          ctx,
          instruction,
          leftX,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        const rStr = rightValid
          ? `RIGHT: curr: ${Math.round(pose.rightKneeAngle)}°`
          : "RIGHT: curr: --°";
        drawHudText(ctx, rStr, leftX, y, "#4292C6", fontSize);
      } else if (state === "manual_max_r") {
        const rightValid = anglesValid && pose.rightVisible && !isNaN(pose.rightKneeAngle);
        const instruction = rightValid
          ? "Bend right knee."
          : "Bend right knee. Ensure leg is visible.";
        drawHudText(
          ctx,
          instruction,
          leftX,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        const rStr = rightValid
          ? `RIGHT: curr: ${Math.round(pose.rightKneeAngle)}°`
          : "RIGHT: curr: --°";
        drawHudText(ctx, rStr, leftX, y, "#4292C6", fontSize);
      } else if (state === "tracking_mode_select") {
        drawHudText(
          ctx,
          "Calibration Complete! Select Tracking Mode:",
          24,
          y,
          "#89429b",
          fontSize
        );
        y += lineGap;
        drawHudText(
          ctx,
          "Movement Watcher (Monitors Trunk Lean & Weight Offloading)",
          24,
          y,
          "#ffffff",
          fontSize
        );
        y += lineGap;
        drawHudText(
          ctx,
          "Movement Trainer (Target ROM Arcs, Reps & Holds)",
          24,
          y,
          "#ffffff",
          fontSize
        );
      } else if (state === "tracking") {
        const tracker = trackerRef.current;
        const sideX = leftX;
        const sideColor = tracker.injuredSide === "left" ? "#AC3834" : "#4292C6";
        const modeTitle = trackingMode === "watcher" ? "Movement Watcher" : "Movement Trainer";
        const modeColor = sideColor;

        drawHudText(
          ctx,
          modeTitle,
          sideX,
          y,
          modeColor,
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

          const romPct = fb.rom > 0
            ? Math.max(0, Math.min(100, Math.round(((fb.currentAngle - fb.minAngle) / fb.rom) * 100)))
            : 0;

          if (trackingMode === "watcher") {
            hasWatchingDataRef.current = true;
            sessionMaxLean.current = Math.max(sessionMaxLean.current, Math.round(fb.leanDeg));
            sessionMaxLoad.current = Math.max(sessionMaxLoad.current, Math.round(fb.injuredLoad));

            // Movement Watcher Mode: Posture safety, trunk lean, weight offloading
            const angleColor = fb.isViolated ? "#ff4444" : sideColor;
            drawHudText(
              ctx,
              `curr: ${Math.round(fb.currentAngle)}° (${romPct}% of ROM) | min: ${Math.round(fb.minAngle)}° | max: ${Math.round(fb.maxAngle)}°`,
              sideX,
              y,
              angleColor,
              fontSize
            );
            y += lineGap;
            drawHudText(
              ctx,
              `load: ${fb.injuredLoad}% injured | ${fb.healthyLoad}% healthy`,
              sideX,
              y,
              "#ffdd44",
              fontSize
            );
            y += lineGap;
            drawHudText(ctx, fb.leanText, sideX, y, fb.leanColor, fontSize);
          } else {
            hasTrainingDataRef.current = true;
            // Movement Trainer Mode: Target ROM Arc, Reps, Holds & Safety Disclaimer
            if (pose.normalizedLandmarks) {
              ctx.save();
              ctx.translate(_width, 0);
              ctx.scale(-1, 1);
              drawTargetArcGauge(
                ctx,
                pose.normalizedLandmarks,
                _width,
                height,
                tracker.injuredSide,
                fb.currentAngle,
                fb.minAngle,
                fb.maxAngle
              );
              ctx.restore();
            }

            if (trainerSubMode === "planned") {
              const flexDone = fb.flexRepCount >= plannedTargetReps;
              const extDone = fb.extRepCount >= plannedTargetReps;
              const isComplete = flexDone && extDone;

              // Configure allowed movement mode for tracker
              if (isComplete) {
                tracker.allowedMovement = "both";
                if (!completionTriggeredRef.current) {
                  completionTriggeredRef.current = true;
                  setIsTrainingCompleteModal(true);
                  setShowPlannedModal(true);
                }
              } else if (plannedPattern === "sequential") {
                if (!flexDone) {
                  tracker.allowedMovement = "flexion";
                } else if (!extDone) {
                  tracker.allowedMovement = "extension";
                }
              } else {
                // Alternating mode: alternate flexion and extension
                if (fb.flexRepCount <= fb.extRepCount) {
                  tracker.allowedMovement = "flexion";
                } else {
                  tracker.allowedMovement = "extension";
                }
              }

              if (isComplete) {
                drawHudText(
                  ctx,
                  `Planned Routine Complete! (${plannedTargetReps} Flexion + ${plannedTargetReps} Extension reps)`,
                  sideX,
                  y,
                  sideColor,
                  fontSize
                );
                y += lineGap;
              } else if (plannedPattern === "sequential") {
                if (!flexDone) {
                  drawHudText(
                    ctx,
                    `curr: ${Math.round(fb.currentAngle)}° (${romPct}% ROM) | Flex Goal: ${fb.flexRepCount ?? 0} / ${plannedTargetReps} reps | hold: ${fb.holdTime.toFixed(1)}s / ${fb.targetHoldDuration.toFixed(1)}s`,
                    sideX,
                    y,
                    sideColor,
                    fontSize
                  );
                  y += lineGap;
                  drawHudText(
                    ctx,
                    `Bend knee to flexion target & hold ${fb.targetHoldDuration}s. Return past 50% ROM to reset.`,
                    sideX,
                    y,
                    "#ffffff",
                    Math.round(fontSize * 0.85)
                  );
                  y += lineGap;
                } else {
                  drawHudText(
                    ctx,
                    `curr: ${Math.round(fb.currentAngle)}° (${romPct}% ROM) | Ext Goal: ${fb.extRepCount ?? 0} / ${plannedTargetReps} reps | hold: ${fb.holdTime.toFixed(1)}s / ${fb.targetHoldDuration.toFixed(1)}s`,
                    sideX,
                    y,
                    sideColor,
                    fontSize
                  );
                  y += lineGap;
                  drawHudText(
                    ctx,
                    `Flexion Complete! Straighten leg to extension target & hold ${fb.targetHoldDuration}s.`,
                    sideX,
                    y,
                    "#ffffff",
                    Math.round(fontSize * 0.85)
                  );
                  y += lineGap;
                }
              } else {
                // Alternating pattern
                const targetMove = fb.flexRepCount <= fb.extRepCount ? "Flexion" : "Extension";
                drawHudText(
                  ctx,
                  `curr: ${Math.round(fb.currentAngle)}° (${romPct}% ROM) | Flex: ${fb.flexRepCount ?? 0}/${plannedTargetReps} | Ext: ${fb.extRepCount ?? 0}/${plannedTargetReps} | hold: ${fb.holdTime.toFixed(1)}s / ${fb.targetHoldDuration.toFixed(1)}s`,
                  sideX,
                  y,
                  sideColor,
                  fontSize
                );
                y += lineGap;
                drawHudText(
                  ctx,
                  targetMove === "Flexion"
                    ? `Next: Bend knee to flexion target & hold ${fb.targetHoldDuration}s. Return past 50% ROM to reset.`
                    : `Next: Straighten leg to extension target & hold ${fb.targetHoldDuration}s. Return past 50% ROM to reset.`,
                  sideX,
                  y,
                  "#ffffff",
                  Math.round(fontSize * 0.85)
                );
                y += lineGap;
              }
            } else {
              // Freestyle Sub-Mode
              tracker.allowedMovement = "both";
              drawHudText(
                ctx,
                `curr: ${Math.round(fb.currentAngle)}° (${romPct}% ROM) | flex reps: ${fb.flexRepCount ?? 0} | ext reps: ${fb.extRepCount ?? 0} | hold: ${fb.holdTime.toFixed(1)}s / ${fb.targetHoldDuration.toFixed(1)}s`,
                sideX,
                y,
                sideColor,
                fontSize
              );
              y += lineGap;

              drawHudText(
                ctx,
                "flex (flexion) = knee bend  |  ext (extension) = leg straighten (50% ROM reset)",
                sideX,
                y,
                "rgba(255, 255, 255, 0.75)",
                Math.round(fontSize * 0.8)
              );
              y += lineGap;
            }

            // Safety Disclaimer Banner
            drawHudText(
              ctx,
              "Proceed safely. Sit or use support as recommended by your physical therapist.",
              sideX,
              y,
              "#ffaa00",
              Math.round(fontSize * 0.78)
            );
          }
        } else {
          drawHudText(
            ctx,
            `Move ${tracker.injuredSide} leg completely into the frame.`,
            sideX,
            y,
            sideColor,
            fontSize
          );
        }
      }
    },
    [state, trackingMode, trainerSubMode, plannedTargetReps, plannedPattern]
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
    const injMin = tracker.injuredSide === "left" ? minL.current : minR.current;
    const injMax = tracker.injuredSide === "left" ? maxL.current : maxR.current;

    // if no real recorded results, reset back to mode selection screen
    if (injMin === null || injMax === null) {
      resetSession();
      return null;
    }

    const injRom = Math.max(0, injMax - injMin);

    return (
      <SessionSummary
        injuredSide={tracker.injuredSide}
        minAngle={Math.round(injMin)}
        maxAngle={Math.round(injMax)}
        rom={Math.round(injRom)}
        bodyLeanMax={Math.round(sessionMaxLean.current)}
        maxLoad={Math.round(sessionMaxLoad.current)}
        flexReps={tracker.flexRepCount}
        extReps={tracker.extRepCount}
        hasWatchingData={hasWatchingDataRef.current}
        hasTrainingData={hasTrainingDataRef.current}
        onNewSession={resetSession}
        onGoBack={() => setState(previousStateRef.current)}
      />
    );
  }

  const isFrontal = state.startsWith("auto_calibrate") || state === "mode_select";
  const filterSide: "left" | "right" | "all" =
    state === "manual_min_l" || state === "manual_max_l"
      ? "left"
      : state === "manual_min_r" || state === "manual_max_r"
        ? "right"
        : state === "tracking" && trackingMode === "trainer"
          ? trackerRef.current.injuredSide
          : "all";

  const isActive =
    state === "auto_calibrate_countdown" ||
    state === "auto_calibrate" ||
    state.startsWith("manual_") ||
    state === "tracking";

  return (
    <div className="session-view-wrapper">
      <CameraView
        engine={engineRef.current}
        isFrontal={isFrontal}
        filterSide={filterSide}
        isActive={isActive}
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
              Auto Calibration [A]
            </button>
            <button
              id="manual-calib-btn"
              className="btn btn-secondary"
              onClick={startManualCalib}
            >
              Manual Calibration [M]
            </button>
            <button
              id="shortcuts-btn"
              className="btn btn-secondary"
              onClick={() => setShowShortcutsModal(true)}
            >
              Shortcuts [?]
            </button>
          </div>
        )}

        {state === "auto_calibrate_countdown" && (
          <div className="control-button-group">
            <div className="control-info">
              <span>Get in position facing the camera...</span>
            </div>
            <button
              id="switch-to-manual-btn"
              className="btn btn-secondary"
              onClick={startManualCalib}
            >
              Switch to Manual [M]
            </button>
            <button
              className="btn btn-secondary"
              onClick={resetSession}
            >
              Cancel [Q]
            </button>
          </div>
        )}

        {state === "auto_calibrate" && (
          <div className="control-button-group">
            <button
              id="lock-calib-btn"
              className="btn btn-primary"
              onClick={handleLockOrAdvance}
            >
              Lock Range [Space / Click]
            </button>
            <button
              id="switch-to-manual-btn"
              className="btn btn-secondary"
              onClick={startManualCalib}
            >
              Switch to Manual [M]
            </button>
            <button
              className="btn btn-secondary"
              onClick={resetSession}
            >
              Cancel [Q]
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
              Lock Angle [Space / Click]
            </button>
            <button
              id="switch-to-auto-btn"
              className="btn btn-secondary"
              onClick={startAutoCalib}
            >
              Switch to Auto [A]
            </button>
            <button
              className="btn btn-secondary"
              onClick={resetSession}
            >
              Cancel [Q]
            </button>
          </div>
        )}

        {state === "tracking_mode_select" && (
          <div className="control-button-group">
            <button
              id="mode-watcher-btn"
              className="btn btn-primary"
              onClick={() => {
                setTrackingMode("watcher");
                setState("tracking");
              }}
            >
              Movement Watcher [W]
            </button>
            <button
              id="mode-trainer-btn"
              className="btn btn-secondary"
              onClick={() => {
                setTrackingMode("trainer");
                setState("tracking");
              }}
            >
              Movement Trainer [T]
            </button>
            <button
              id="goto-summary-btn"
              className="btn btn-secondary"
              onClick={() => {
                previousStateRef.current = "tracking_mode_select";
                setState("session_end");
              }}
            >
              Summary [S]
            </button>
          </div>
        )}

        {state === "tracking" && (
          <div className="control-button-group">
            {trackingMode === "trainer" && (
              <>
                {trainerSubMode === "planned" && (
                  <button
                    id="configure-planned-btn"
                    className="btn btn-secondary"
                    onClick={() => setShowPlannedModal(true)}
                  >
                    Configure ({plannedTargetReps} reps @ {trackerRef.current.targetHoldDuration}s)
                  </button>
                )}
                <button
                  id="switch-submode-btn"
                  className="btn btn-secondary"
                  onClick={() => {
                    if (trainerSubMode === "freestyle") {
                      setShowPlannedModal(true);
                    } else {
                      setTrainerSubMode("freestyle");
                    }
                  }}
                >
                  {trainerSubMode === "freestyle" ? "Planned Routine [P]" : "Freestyle [F]"}
                </button>
              </>
            )}

            <button
              id="switch-mode-btn"
              className="btn btn-secondary"
              onClick={() => {
                setTrackingMode((prev) => (prev === "watcher" ? "trainer" : "watcher"));
              }}
            >
              {trackingMode === "watcher" ? "Switch to Training [T]" : "Switch to Watching [W]"}
            </button>
            <button
              id="recalibrate-btn"
              className="btn btn-secondary"
              onClick={() => setShowRecalibrateModal(true)}
              title="Recalibrate session [Q]"
            >
              Recalibrate [Q]
            </button>
            <button
              id="end-session-btn"
              className="btn btn-primary"
              onClick={() => {
                const tracker = trackerRef.current;
                const injMin = tracker.injuredSide === "left" ? minL.current : minR.current;
                const injMax = tracker.injuredSide === "left" ? maxL.current : maxR.current;
                if (injMin !== null && injMax !== null) {
                  previousStateRef.current = "tracking";
                  setState("session_end");
                } else {
                  resetSession();
                }
              }}
            >
              Summary [S]
            </button>
          </div>
        )}

        {showRecalibrateModal && (
          <div className="modal-backdrop" onClick={() => setShowRecalibrateModal(false)}>
            <div className="glass-card confirm-modal" onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 1rem 0", fontSize: "0.95rem", fontWeight: 500, color: "var(--text-primary)", textAlign: "center" }}>
                Recalibrate? <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({recalibrateCountdown}s)</span>
              </h3>
              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setShowRecalibrateModal(false);
                    resetSession();
                  }}
                >
                  Yes [Q]
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowRecalibrateModal(false)}
                >
                  No [Esc]
                </button>
              </div>
            </div>
          </div>
        )}

        {showPlannedModal && (
          <div className="modal-backdrop">
            <div className="glass-card planned-config-modal">
              <h3 style={{ marginTop: 0, marginBottom: "0.5rem", fontSize: "1.15rem", fontWeight: 600, color: isTrainingCompleteModal ? "var(--success)" : "var(--text-primary)" }}>
                {isTrainingCompleteModal ? "Congratulations! Training complete." : "Configure Training Plan"}
              </h3>

              {isTrainingCompleteModal && (
                <p style={{ fontSize: "0.88rem", color: "var(--text-secondary)", marginBottom: "1.25rem" }}>
                  You completed your set! Adjust your parameters below to start another routine.
                </p>
              )}

              {plannedInputError && (
                <p className="error-text" style={{ marginBottom: "1rem", color: "var(--danger)", fontSize: "0.88rem" }}>
                  {plannedInputError}
                </p>
              )}

              <div style={{ marginBottom: "1.25rem", textAlign: "left" }}>
                <label style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.88rem", color: "var(--text-secondary)" }}>
                  Movement Order:
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
                  <button
                    type="button"
                    className={`btn ${plannedPattern === "sequential" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setPlannedPattern("sequential")}
                    style={{ fontSize: "0.82rem", padding: "0.55rem 0.4rem", width: "100%", justifyContent: "center" }}
                  >
                    Flexion then Extension
                  </button>
                  <button
                    type="button"
                    className={`btn ${plannedPattern === "alternating" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setPlannedPattern("alternating")}
                    style={{ fontSize: "0.82rem", padding: "0.55rem 0.4rem", width: "100%", justifyContent: "center" }}
                  >
                    Alternating
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: "1.25rem", textAlign: "left" }}>
                <label style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.88rem", color: "var(--text-secondary)" }}>
                  Target Reps per Movement:
                </label>
                <input
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.8rem",
                    borderRadius: "6px",
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    fontSize: "0.95rem",
                  }}
                  value={plannedRepInput}
                  onChange={(e) => setPlannedRepInput(e.target.value)}
                />
              </div>

              <div style={{ marginBottom: "1.75rem", textAlign: "left" }}>
                <label style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.88rem", color: "var(--text-secondary)" }}>
                  Hold Duration per Rep (seconds):
                </label>
                <input
                  type="number"
                  min="0.1"
                  max="30"
                  step="0.1"
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.8rem",
                    borderRadius: "6px",
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    fontSize: "0.95rem",
                  }}
                  value={plannedDurationInput}
                  onChange={(e) => setPlannedDurationInput(e.target.value)}
                />
              </div>

              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowPlannedModal(false);
                    setPlannedInputError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSavePlannedConfig}
                >
                  Start Planned Routine
                </button>
              </div>
            </div>
          </div>
        )}

        {showShortcutsModal && (
          <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />
        )}
      </div>
    </div>
  );
}
