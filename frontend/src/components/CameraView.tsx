// core component: acquires webcam, runs MediaPipe PoseLandmarker continuously on GPU,
// and renders the smoothed skeleton overlay + hud on canvas stacked on top of video.

import { useEffect, useRef, useState } from "react";
import type { PoseEngine, PoseState } from "../engine/poseEngine";
import { drawSkeleton, drawFrontalDiagnostics } from "../engine/drawUtils";

interface CameraViewProps {
  engine: PoseEngine;
  isFrontal?: boolean;
  filterSide?: "left" | "right" | "all";
  isActive?: boolean;
  onFrame?: (state: PoseState | null) => void;
  renderHud?: (
    ctx: CanvasRenderingContext2D,
    state: PoseState | null,
    width: number,
    height: number
  ) => void;
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
  const [modelReady, setModelReady] = useState(false);
  const [metrics, setMetrics] = useState({ inferMs: 0, fps: 0 });

  const latestPoseStateRef = useRef<PoseState | null>(null);
  const fpsCountRef = useRef(0);
  const fpsLastSampleRef = useRef(performance.now());

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

  // initialize MediaPipe PoseLandmarker model
  useEffect(() => {
    let isCancelled = false;

    async function loadPoseModel() {
      try {
        await engineRef.current.init();
        if (!isCancelled) {
          setModelReady(true);
        }
      } catch (err: any) {
        console.error("[CameraView] Failed to initialize MediaPipe PoseLandmarker:", err);
      }
    }

    loadPoseModel();

    return () => {
      isCancelled = true;
    };
  }, []);

  // start webcam stream
  useEffect(() => {
    let stream: MediaStream | null = null;

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user",
          },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err: any) {
        setCameraError(
          err.name === "NotAllowedError"
            ? "Camera permission denied. Please allow camera access in your browser."
            : `Unable to access camera: ${err.message}`
        );
      }
    }

    startCamera();

    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // continuous synchronous MediaPipe pose estimation & render loop
  useEffect(() => {
    let isRunning = true;
    let animId = 0;
    let lastTime = -1;

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
          const now = performance.now();
          const timestamp = now > lastTime ? now : lastTime + 1;
          lastTime = timestamp;

          let state: PoseState | null = null;
          if (modelReady) {
            try {
              state = engineRef.current.processFrame(video, timestamp, isFrontalRef.current);
            } catch (err) {
              console.warn("[CameraView] processFrame error:", err);
            }
          }

          if (state) {
            latestPoseStateRef.current = state;
            onFrameRef.current?.(state);

            // update FPS & inferMs metrics once every second
            fpsCountRef.current++;
            const elapsed = now - fpsLastSampleRef.current;
            if (elapsed >= 1000) {
              setMetrics({
                inferMs: state.inferMs ?? 0,
                fps: Math.round((fpsCountRef.current * 1000) / elapsed),
              });
              fpsCountRef.current = 0;
              fpsLastSampleRef.current = now;
            }
          }

          const currentPose = state ?? latestPoseStateRef.current;

          // clear canvas frame
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // draw skeleton in mirrored selfie coordinates
          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          if (currentPose?.normalizedLandmarks) {
            drawSkeleton(
              ctx,
              currentPose.normalizedLandmarks,
              canvas.width,
              canvas.height,
              filterSideRef.current
            );

            // draw frontal diagnostic overlays (plumb line, knee valgus, pelvic tilt)
            if (isFrontalRef.current) {
              drawFrontalDiagnostics(
                ctx,
                currentPose.normalizedLandmarks,
                canvas.width,
                canvas.height,
                filterSideRef.current
              );
            }
          }
          ctx.restore();

          // draw HUD text un-mirrored so it reads left-to-right
          if (renderHudRef.current) {
            renderHudRef.current(ctx, currentPose, canvas.width, canvas.height);
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
  }, [modelReady]);

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

      {/* Model status badge */}
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
          background: "rgba(18, 18, 24, 0.72)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          color: "rgba(255, 255, 255, 0.88)",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.25)",
          zIndex: 10,
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            backgroundColor: modelReady ? "#22c55e" : "#f59e0b",
            display: "inline-block",
            boxShadow: modelReady
              ? "0 0 6px rgba(34, 197, 94, 0.6)"
              : "0 0 6px rgba(245, 158, 11, 0.6)",
          }}
        />
        {modelReady
          ? metrics.fps > 0
            ? `MediaPipe 3D GPU (${metrics.inferMs}ms · ${metrics.fps} FPS)`
            : "MediaPipe 3D GPU"
          : "Loading Model..."}
      </div>
    </div>
  );
}
