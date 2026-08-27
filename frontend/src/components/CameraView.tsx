// core component: acquires webcam, runs mediapipe continuously, and renders
// the skeleton overlay + hud on an html5 canvas stacked on top of the video.

import { useEffect, useRef, useState } from "react";
import { PoseEngine, type PoseState } from "../engine/poseEngine";
import { drawSkeleton } from "../engine/drawUtils";

interface CameraViewProps {
  engine: PoseEngine;
  // whether to use 3D Euclidean angle (frontal auto-calib) or 2D planar angle (side-on manual/tracking)
  isFrontal?: boolean;
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
  isActive,
  onFrame,
  renderHud,
  onCanvasClick,
}: CameraViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // keep callback refs fresh so the continuous RAF loop never drops frames
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const renderHudRef = useRef(renderHud);
  renderHudRef.current = renderHud;

  const engineRef = useRef(engine);
  engineRef.current = engine;

  const isFrontalRef = useRef(isFrontal);
  isFrontalRef.current = isFrontal;

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
          videoRef.current.play().catch(() => {});
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

          // clear canvas frame
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // draw skeleton in mirrored selfie coordinates
          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          if (state?.normalizedLandmarks) {
            drawSkeleton(ctx, state.normalizedLandmarks, canvas.width, canvas.height);
          }
          ctx.restore();

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
    </div>
  );
}
