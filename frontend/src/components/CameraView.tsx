// core component: acquires webcam, runs mediapipe continuously, and renders
// the skeleton overlay + hud on an html5 canvas stacked on top of the video.

import { useEffect, useRef, useState, useCallback } from "react";
import type { PoseEngine, PoseState } from "../engine/poseEngine";
import { useOpticalFlowTracker } from "../hooks/useOpticalFlowTracker";
import { drawSkeleton, drawSlamAnchorCrosshair } from "../engine/drawUtils";
import { checkConfidenceAndTriggerFallback, type FallbackTriggerEvent } from "./PoseScanner";

interface CameraViewProps {
  engine: PoseEngine;
  // whether to use 3D Euclidean angle (frontal auto-calib) or 2D planar angle (side-on manual/tracking)
  isFrontal?: boolean;
  // filter skeleton rendering to specific leg during manual calibration
  filterSide?: "left" | "right" | "all";
  // whether calibration or tracking is actively running
  isActive?: boolean;
  // called every frame with the latest pose state (or null if no detection)
  onFrame?: (state: PoseState | null) => void;
  // hud rendering callback — the parent state machine decides what text to show
  renderHud?: (
    ctx: CanvasRenderingContext2D,
    state: PoseState | null,
    width: number,
    height: number
  ) => void;
  // fired when the user clicks the canvas (used for calibration lock)
  onCanvasClick?: () => void;
}

interface CachedJoint {
  x: number;
  y: number;
  visibility: number;
  timestamp: number;
}

export default function CameraView({
  engine,
  isFrontal,
  filterSide,
  isActive,
  onFrame,
  renderHud,
  onCanvasClick,
}: CameraViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<FallbackTriggerEvent | null>(null);

  const slamTracker = useOpticalFlowTracker();
  const slamTrackerRef = useRef(slamTracker);
  slamTrackerRef.current = slamTracker;

  const lastKnownJointsRef = useRef<Record<number, CachedJoint>>({});
  const inFlightRef = useRef(false);

  // invalidate cached joint coordinates
  const invalidateJointCache = useCallback(() => {
    lastKnownJointsRef.current = {};
  }, []);

  // clear cached coordinates when session or calibration resets
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    if (prevIsActiveRef.current !== isActive) {
      prevIsActiveRef.current = isActive;
      invalidateJointCache();
      if (slamTrackerRef.current.hasActiveTracker()) {
        slamTrackerRef.current.resetTracker();
      }
    }
  }, [isActive, invalidateJointCache]);

  // keep callback refs fresh so the continuous RAF loop never drops frames
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const renderHudRef = useRef(renderHud);
  renderHudRef.current = renderHud;

  const engineRef = useRef(engine);
  engineRef.current = engine;

  const isFrontalRef = useRef(isFrontal);
  isFrontalRef.current = isFrontal;

  const filterSideRef = useRef(filterSide);
  filterSideRef.current = filterSide;

  // start webcam stream
  useEffect(() => {
    let stream: MediaStream | null = null;

    async function startCamera() {
      try {
        invalidateJointCache();
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, min: 640 },
            height: { ideal: 720, min: 480 },
            facingMode: "user",
          },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => { });
        }
      } catch {
        setCameraError("Camera access denied or unavailable. Please enable permissions.");
      }
    }

    startCamera();

    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [invalidateJointCache]);

  // permanent, continuous render loop
  useEffect(() => {
    let isRunning = true;
    let animId = 0;
    let lastTimestamp = 0;

    function renderLoop() {
      if (!isRunning) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (
        video &&
        canvas &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        // sync canvas internal buffer dimensions to video resolution
        if (
          canvas.width !== video.videoWidth ||
          canvas.height !== video.videoHeight
        ) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          invalidateJointCache();
        }

        const ctx = canvas.getContext("2d");
        if (ctx) {
          let now = performance.now();
          if (now <= lastTimestamp) {
            now = lastTimestamp + 1;
          }
          lastTimestamp = now;

          // process frame through mediapipe wasm with deterministic isFrontal mode
          const state = engineRef.current.processFrame(video, now, isFrontalRef.current);

          // update last-known valid high-confidence landmark positions with timestamps
          if (state?.normalizedLandmarks && !inFlightRef.current) {
            state.normalizedLandmarks.forEach((lm, idx) => {
              const vis = lm.visibility ?? 1.0;
              if (vis >= 0.6) {
                lastKnownJointsRef.current[idx] = {
                  x: lm.x,
                  y: lm.y,
                  visibility: vis,
                  timestamp: now,
                };
              }
            });

            const targetJoints =
              filterSideRef.current === "left"
                ? [23, 25, 27]
                : filterSideRef.current === "right"
                  ? [24, 26, 28]
                  : [23, 24, 25, 26, 27, 28];

            inFlightRef.current = true;
            checkConfidenceAndTriggerFallback(state.normalizedLandmarks, targetJoints, video)
              .then((evt) => {
                setFallbackStatus((prev) => {
                  if (
                    prev?.triggered === evt.triggered &&
                    prev?.joint === evt.joint &&
                    Math.abs((prev?.confidence ?? 0) - evt.confidence) < 0.05
                  ) {
                    return prev;
                  }
                  return evt;
                });

                if (evt.triggered && evt.imageBitmap) {
                  if (!slamTrackerRef.current.hasActiveTracker()) {
                    const sidesToTrack = evt.sidesToTrack && evt.sidesToTrack.length > 0
                      ? evt.sidesToTrack
                      : ["left" as const, "right" as const];

                    const anchors: { left?: { x: number; y: number }; right?: { x: number; y: number } } = {};
                    const limbs: { left?: { x: number; y: number }[]; right?: { x: number; y: number }[] } = {};

                    for (const side of sidesToTrack) {
                      const kneeIdx = side === "right" ? 26 : 25;
                      const [h, a] = side === "right" ? [24, 28] : [23, 27];

                      // 1. Prefer current reliable MediaPipe knee observation
                      const currentLm = state.normalizedLandmarks[kneeIdx];
                      let selectedAnchor: { x: number; y: number } | null = null;
                      let source = "none";
                      let confidence = 0;
                      let ageMs = 0;

                      if (currentLm && (currentLm.visibility === undefined || currentLm.visibility >= 0.6)) {
                        selectedAnchor = { x: currentLm.x, y: currentLm.y };
                        source = "current MediaPipe";
                        confidence = currentLm.visibility ?? 1.0;
                        ageMs = 0;
                      } else {
                        // 2. Otherwise, check recent cached knee coordinate (<= 150ms)
                        const cached = lastKnownJointsRef.current[kneeIdx];
                        if (cached) {
                          const age = now - cached.timestamp;
                          if (age <= 150) {
                            selectedAnchor = { x: cached.x, y: cached.y };
                            source = "cached";
                            confidence = cached.visibility;
                            ageMs = Math.round(age);
                          }
                        }
                      }

                      // 3. Register valid anchor or log diagnostic skip
                      if (selectedAnchor) {
                        anchors[side] = selectedAnchor;

                        const hipPt = state.normalizedLandmarks[h]
                          ? { x: state.normalizedLandmarks[h].x, y: state.normalizedLandmarks[h].y }
                          : lastKnownJointsRef.current[h]
                            ? { x: lastKnownJointsRef.current[h].x, y: lastKnownJointsRef.current[h].y }
                            : undefined;

                        const anklePt = state.normalizedLandmarks[a]
                          ? { x: state.normalizedLandmarks[a].x, y: state.normalizedLandmarks[a].y }
                          : lastKnownJointsRef.current[a]
                            ? { x: lastKnownJointsRef.current[a].x, y: lastKnownJointsRef.current[a].y }
                            : undefined;

                        limbs[side] = [hipPt, selectedAnchor, anklePt].filter(
                          (p): p is { x: number; y: number } => Boolean(p)
                        );

                        console.log(`[CameraView:INIT_ANCHOR] ACCEPTED ${side} knee:`, {
                          side,
                          anchor: { x: Number(selectedAnchor.x.toFixed(4)), y: Number(selectedAnchor.y.toFixed(4)) },
                          source,
                          confidence: Number(confidence.toFixed(2)),
                          age: `${ageMs}ms`,
                          frameDimensions: `${video.videoWidth}x${video.videoHeight}`,
                          status: "ACCEPTED",
                        });
                      } else {
                        console.warn(`[CameraView:INIT_ANCHOR] SKIPPED ${side} knee (no valid or fresh observation <= 150ms):`, {
                          side,
                          source: "none",
                          status: "SKIPPED",
                          frameDimensions: `${video.videoWidth}x${video.videoHeight}`,
                        });
                      }
                    }

                    // 4. Only initialize if at least one valid anchor was found
                    if (Object.keys(anchors).length > 0) {
                      slamTrackerRef.current.initAnchor(evt.imageBitmap, anchors, limbs);
                    } else {
                      console.warn("[CameraView:INIT_ANCHOR] Optical-flow initialization skipped: no valid knee anchors available");
                      evt.imageBitmap.close();
                    }
                  } else {
                    slamTrackerRef.current.trackFrame(evt.imageBitmap);
                  }
                } else if (!evt.triggered && slamTrackerRef.current.hasActiveTracker()) {
                  slamTrackerRef.current.resetTracker();
                  invalidateJointCache();
                }
              })
              .finally(() => {
                inFlightRef.current = false;
              });
          } else if (!state?.normalizedLandmarks) {
            setFallbackStatus((prev) => {
              if (prev?.triggered === true && prev.joint === "both legs" && prev.confidence === 0) {
                return prev;
              }
              return { triggered: true, joint: "both legs", sidesToTrack: ["left", "right"], confidence: 0 };
            });
          }

          // clear canvas frame
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // draw skeleton in mirrored selfie coordinates
          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          if (state?.normalizedLandmarks) {
            drawSkeleton(ctx, state.normalizedLandmarks, canvas.width, canvas.height, filterSideRef.current);
          }
          ctx.restore();

          // draw SLAM optical flow target crosshairs matching side colors when tracking or recovering
          const isTrackingOrUncertain =
            slamTrackerRef.current.lifecycle === "TRACKING" ||
            slamTrackerRef.current.lifecycle === "UNCERTAIN";
          if (isTrackingOrUncertain && slamTrackerRef.current.trackedPoints) {
            const pts = slamTrackerRef.current.trackedPoints;
            if (pts.left) {
              drawSlamAnchorCrosshair(ctx, pts.left, canvas.width, canvas.height, "left");
            }
            if (pts.right) {
              drawSlamAnchorCrosshair(ctx, pts.right, canvas.width, canvas.height, "right");
            }
          }

          // draw HUD text un-mirrored so it reads left-to-right
          if (renderHudRef.current) {
            renderHudRef.current(ctx, state, canvas.width, canvas.height);
          }

          // fire onFrame state notification to parent
          if (onFrameRef.current) {
            onFrameRef.current(state);
          }
        }
      }

      animId = requestAnimationFrame(renderLoop);
    }

    animId = requestAnimationFrame(renderLoop);

    return () => {
      isRunning = false;
      cancelAnimationFrame(animId);
    };
  }, []);

  if (cameraError) {
    return (
      <div className="camera-error glass-card">
        <h3>Camera Error</h3>
        <p>{cameraError}</p>
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

  return (
    <div
      className={`camera-container ${isActive ? "active-session" : ""}`}
      onClick={onCanvasClick}
      role="button"
      tabIndex={isActive ? 0 : -1}
      title={isActive ? "Click to lock calibration or advance step" : "Pocket Physio Camera"}
      style={{ position: "relative" }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
      />
      <canvas
        ref={canvasRef}
      />
      {fallbackStatus && (
        <div
          className="fallback-hud-badge"
          style={{
            position: "absolute",
            top: "14px",
            right: "14px",
            padding: "5px 12px",
            borderRadius: "6px",
            fontSize: "0.76rem",
            fontWeight: 500,
            letterSpacing: "0.01em",
            fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: "7px",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            zIndex: 10,
            border: "1px solid rgba(137, 66, 155, 0.4)",
            background: "rgba(24, 15, 30, 0.75)",
            color: "#ffffff",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
            pointerEvents: "none",
            transition: "all 0.2s ease",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: "#89429b",
              flexShrink: 0,
            }}
          />
          {fallbackStatus.triggered ? (
            <span>
              Optical Fallback • {(fallbackStatus.confidence * 100).toFixed(0)}%
            </span>
          ) : (
            <span>
              Pose Tracking • {(fallbackStatus.confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}
