// core component: acquires webcam, transfers frames to yolo-pose.worker.ts,
// and renders the skeleton overlay + hud on an html5 canvas stacked on top of the video.

import { useEffect, useRef, useState } from "react";
import type { PoseEngine, PoseState } from "../engine/poseEngine";
import { drawSkeleton } from "../engine/drawUtils";
import type {
  YoloWorkerResponse,
  PoseKeypoints,
} from "../types/yoloPose";

interface CameraViewProps {
  engine: PoseEngine;
  // whether tracking frontal view or side-on view
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
  const [workerReady, setWorkerReady] = useState(false);
  const [inferenceFps, setInferenceFps] = useState<number>(0);
  const [activeProvider, setActiveProvider] = useState<string>("wasm");

  // YOLO pose web worker reference
  const workerRef = useRef<Worker | null>(null);
  // in-flight backpressure lock to prevent queue buildup
  const inFlightRef = useRef(false);
  // latest processed keypoints
  const latestKeypointsRef = useRef<PoseKeypoints | null>(null);

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

  // initialize yolo-pose worker
  useEffect(() => {
    // instantiate module worker
    const worker = new Worker(
      new URL("../workers/yolo-pose.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<YoloWorkerResponse>) => {
      const msg = e.data;

      if (msg.type === "MODEL_READY") {
        setWorkerReady(true);
        setActiveProvider(msg.provider);
        console.log(`[CameraView] YOLOv8 Pose Worker ready (${msg.provider})`);
      } else if (msg.type === "POSE_RESULT") {
        // save latest detected keypoints
        latestKeypointsRef.current = msg.keypoints;
        inFlightRef.current = false;

        if (msg.inferenceTimeMs > 0) {
          const fps = Math.round(1000 / msg.inferenceTimeMs);
          setInferenceFps(fps);
        }
      } else if (msg.type === "ERROR") {
        console.error("[CameraView] YOLO Worker error:", msg.message);
        inFlightRef.current = false;
      }
    };

    // fetch model binary on the main thread and transfer buffer to worker
    fetch("/models/yolov8n-pose.onnx")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to fetch YOLO model (${res.status} ${res.statusText})`);
        }
        return res.arrayBuffer();
      })
      .then((buffer) => {
        console.log(`[CameraView] Fetched YOLO model (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB), transferring to worker...`);
        worker.postMessage({ type: "INIT_MODEL", modelBuffer: buffer }, [buffer]);
      })
      .catch((err) => {
        console.error("[CameraView] Failed to load model file:", err);
        setCameraError("Failed to load YOLOv8 model file from /models/yolov8n-pose.onnx");
      });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

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

  // continuous RAF animation and video frame pipeline
  useEffect(() => {
    let isRunning = true;
    let animId = 0;

    async function renderLoop() {
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
          // send new frame to worker if not currently busy
          if (
            workerRef.current &&
            workerReady &&
            !inFlightRef.current &&
            video.videoWidth > 0
          ) {
            inFlightRef.current = true;
            try {
              // capture zero-copy ImageBitmap from video
              const bitmap = await createImageBitmap(video);
              // transfer bitmap ownership to worker
              workerRef.current.postMessage(
                { type: "PROCESS_FRAME", imageBitmap: bitmap },
                [bitmap]
              );
            } catch {
              inFlightRef.current = false;
            }
          }

          // process latest keypoints through pose engine
          const state = engineRef.current.processKeypoints(
            latestKeypointsRef.current,
            isFrontalRef.current
          );

          // clear canvas frame
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // draw skeleton in mirrored selfie coordinates
          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          if (state?.normalizedLandmarks) {
            drawSkeleton(
              ctx,
              state.normalizedLandmarks,
              canvas.width,
              canvas.height,
              filterSideRef.current
            );
          }
          ctx.restore();

          // draw HUD text un-mirrored so it reads left-to-right
          if (renderHudRef.current) {
            renderHudRef.current(ctx, state, canvas.width, canvas.height);
          }

          // notify parent component of state change
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
  }, [workerReady]);

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
            backgroundColor: workerReady ? "#22c55e" : "#eab308",
            flexShrink: 0,
          }}
        />
        <span>
          {workerReady
            ? `YOLOv8-Pose • ${activeProvider.toUpperCase()} (${inferenceFps} FPS)`
            : "Loading YOLOv8..."}
        </span>
      </div>
    </div>
  );
}
