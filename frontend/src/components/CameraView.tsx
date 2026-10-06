// core component: acquires webcam, runs mediapipe continuously, and renders
// the skeleton overlay + hud on an html5 canvas stacked on top of the video.

import { useEffect, useRef, useState } from "react";
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

  const lastKnownJointsRef = useRef<Record<number, { x: number; y: number }>>({});
  const inFlightRef = useRef(false);

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
  }, []);

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

          // update last-known valid high-confidence landmark positions
          if (state?.normalizedLandmarks && !inFlightRef.current) {
            state.normalizedLandmarks.forEach((lm, idx) => {
              if (lm && (lm.visibility === undefined || lm.visibility >= 0.6)) {
                lastKnownJointsRef.current[idx] = { x: lm.x, y: lm.y };
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
                  if (!slamTrackerRef.current.isTrackingRef.current) {
                    const sidesToTrack = evt.sidesToTrack && evt.sidesToTrack.length > 0
                      ? evt.sidesToTrack
                      : ["left" as const, "right" as const];

                    const anchors: { left?: { x: number; y: number }; right?: { x: number; y: number } } = {};
                    const limbs: { left?: { x: number; y: number }[]; right?: { x: number; y: number }[] } = {};

                    const lm = lastKnownJointsRef.current;

                    for (const side of sidesToTrack) {
                      const kneeIdx = side === "right" ? 26 : 25;
                      const [h, a] = side === "right" ? [24, 28] : [23, 27];
                      const anchorPoint =
                        lm[kneeIdx] ??
                        state.normalizedLandmarks[kneeIdx] ??
                        { x: side === "right" ? 0.6 : 0.4, y: 0.5 };
                      anchors[side] = anchorPoint;
                      limbs[side] = [lm[h], anchorPoint, lm[a]].filter(
                        (p): p is { x: number; y: number } => Boolean(p)
                      );
                    }

                    slamTrackerRef.current.initAnchor(evt.imageBitmap, anchors, limbs);
                  } else {
                    slamTrackerRef.current.trackFrame(evt.imageBitmap);
                  }
                } else if (!evt.triggered && slamTrackerRef.current.isTrackingRef.current) {
                  slamTrackerRef.current.resetTracker();
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

          // draw SLAM optical flow target crosshairs matching side colors when tracking
          if (slamTrackerRef.current.isTracking && slamTrackerRef.current.trackedPoints) {
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
