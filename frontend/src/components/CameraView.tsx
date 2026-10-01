// core component: acquires webcam, runs mediapipe continuously, and renders
// the skeleton overlay + hud on an html5 canvas stacked on top of the video.

import { useEffect, useRef, useState } from "react";
import type { PoseEngine, PoseState } from "../engine/poseEngine";
import { useOpticalFlowTracker } from "../hooks/useOpticalFlowTracker";
import { drawSkeleton, drawSlamAnchorCrosshair } from "../engine/drawUtils";
import { type FallbackTriggerEvent } from "./PoseScanner";

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

  const lostSidesRef = useRef<Set<"left" | "right">>(new Set());
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

          const lm = state?.normalizedLandmarks;
          type Side = "left" | "right";
          type Pt = { x: number; y: number };
          const KNEE = { left: 25, right: 26 } as const;
          const sides: Side[] =
            filterSideRef.current === "left" ? ["left"] :
            filterSideRef.current === "right" ? ["right"] : ["left", "right"];

          const anchors: { left?: Pt; right?: Pt } = {};
          const lost = new Set<Side>();
          for (const s of sides) {
            const k = lm?.[KNEE[s]] as (import("@mediapipe/tasks-vision").NormalizedLandmark & { presence?: number }) | undefined;
            const conf = k ? Math.min(k.visibility ?? 0, k.presence ?? 1) : 0;
            if (k && conf >= 0.6) {
              anchors[s] = { x: k.x, y: k.y };
            } else {
              lost.add(s);
            }
          }
          lostSidesRef.current = lost;

          // keep the worker fed continuously, one frame in flight, no hallucinated seeds
          if (!inFlightRef.current && !slamTrackerRef.current.isBusy()) {
            inFlightRef.current = true;
            createImageBitmap(video, { resizeWidth: 640, resizeHeight: 360 })
              .then((bmp) => slamTrackerRef.current.sync(bmp, anchors))
              .catch(() => {})
              .finally(() => {
                inFlightRef.current = false;
              });
          }

          // Throttle HUD fallback status state updates
          const isTriggered = lost.size > 0;
          setFallbackStatus((prev) => {
            if (prev?.triggered === isTriggered && (prev as any)?.count === lost.size) return prev;
            return {
              triggered: isTriggered,
              joint: Array.from(lost).map((s) => `${s} knee`).join(" & ") || "none",
              sidesToTrack: Array.from(lost),
              confidence: isTriggered ? 0.3 : 1.0,
              count: lost.size,
            } as any;
          });

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

          // draw SLAM optical flow target crosshairs ONLY on lost sides
          const pts = slamTrackerRef.current.points;
          for (const s of lostSidesRef.current) {
            if (pts?.[s]) {
              drawSlamAnchorCrosshair(ctx, pts[s]!, canvas.width, canvas.height, s);
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
            padding: "5px 11px",
            borderRadius: "20px",
            fontSize: "0.74rem",
            fontWeight: 500,
            letterSpacing: "0.02em",
            fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: "7px",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            zIndex: 10,
            border: fallbackStatus.triggered
              ? "1px solid rgba(239, 68, 68, 0.45)"
              : "1px solid rgba(255, 255, 255, 0.12)",
            background: fallbackStatus.triggered
              ? "rgba(24, 15, 20, 0.82)"
              : "rgba(15, 23, 42, 0.72)",
            color: fallbackStatus.triggered ? "#fca5a5" : "rgba(255, 255, 255, 0.85)",
            boxShadow: fallbackStatus.triggered
              ? "0 4px 14px rgba(239, 68, 68, 0.25)"
              : "0 4px 12px rgba(0, 0, 0, 0.2)",
            pointerEvents: "none",
            transition: "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: fallbackStatus.triggered ? "#ef4444" : "#22c55e",
              boxShadow: fallbackStatus.triggered
                ? "0 0 6px #ef4444"
                : "0 0 4px #22c55e",
              flexShrink: 0,
            }}
          />
          {fallbackStatus.triggered ? (
            <span>
              SLAM FALLBACK ({fallbackStatus.joint}: {(fallbackStatus.confidence * 100).toFixed(0)}%)
            </span>
          ) : (
            <span>
              MEDIAPIPE ({(fallbackStatus.confidence * 100).toFixed(0)}%)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
