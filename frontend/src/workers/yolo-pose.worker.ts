import * as ort from "onnxruntime-web/webgpu";
import type {
  YoloWorkerRequest,
  YoloWorkerResponse,
  Keypoint,
} from "../types/yoloPose";
import { PoseKeypointFilter } from "../engine/oneEuroFilter";

// configure WASM and JSEP asset location using official jsDelivr CDN matching onnxruntime-web@1.31.1
// this prevents Vite dev server from intercepting .mjs dynamic imports as source code
ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
// set thread count to 2 for web worker stability
ort.env.wasm.numThreads = 2;

let session: ort.InferenceSession | null = null;
let activeProvider: "webgpu" | "wasm" = "wasm";
const keypointFilter = new PoseKeypointFilter(17, 1.2, 0.007);

const MODEL_INPUT_SIZE = 640;
const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
// pre-allocated static buffer to avoid continuous memory reallocation and GC spikes
const preallocatedFloat32 = new Float32Array(3 * pixelCount);

// offscreen canvas for letterboxing preprocessing
let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

function getCanvas(): {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
} {
  if (!offscreenCanvas || !offscreenCtx) {
    offscreenCanvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    offscreenCtx = offscreenCanvas.getContext("2d", {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D;
  }
  return { canvas: offscreenCanvas, ctx: offscreenCtx };
}

async function initModel(modelSource: string | ArrayBuffer = "/models/yolov8n-pose.onnx") {
  try {
    console.log("[YOLO-Pose Worker] Starting model session creation...");
    const modelData =
      typeof modelSource === "string"
        ? modelSource
        : new Uint8Array(modelSource);

    // try WebGPU first for maximum hardware inference performance
    try {
      session = await (ort.InferenceSession.create as any)(modelData, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      activeProvider = "webgpu";
      console.log("[YOLO-Pose Worker] Loaded session with WebGPU provider.");
    } catch (gpuErr) {
      console.warn(
        "[YOLO-Pose Worker] WebGPU initialization failed, falling back to WASM:",
        gpuErr
      );
      session = await (ort.InferenceSession.create as any)(modelData, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      activeProvider = "wasm";
      console.log("[YOLO-Pose Worker] Loaded session with WASM provider.");
    }

    const response: YoloWorkerResponse = {
      type: "MODEL_READY",
      provider: activeProvider,
    };
    self.postMessage(response);
  } catch (err: any) {
    console.error("[YOLO-Pose Worker] Model initialization failed:", err);
    const response: YoloWorkerResponse = {
      type: "ERROR",
      message: err?.message || "Failed to initialize YOLOv8 pose model",
    };
    self.postMessage(response);
  }
}

// letterbox pre-processing: maintains image aspect ratio, pads remaining area with gray (114).
// returns CHW float32 tensor [1, 3, 640, 640] normalized to [0, 1].
function preprocess(imageBitmap: ImageBitmap): {
  tensor: ort.Tensor;
  scale: number;
  padX: number;
  padY: number;
  origW: number;
  origH: number;
} {
  const origW = imageBitmap.width;
  const origH = imageBitmap.height;
  const { ctx } = getCanvas();

  // compute aspect-ratio letterbox scaling
  const scale = Math.min(MODEL_INPUT_SIZE / origW, MODEL_INPUT_SIZE / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = (MODEL_INPUT_SIZE - newW) / 2;
  const padY = (MODEL_INPUT_SIZE - newH) / 2;

  // fill padding background (YOLO standard gray 114)
  ctx.fillStyle = "rgb(114, 114, 114)";
  ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

  // draw scaled image centered
  ctx.drawImage(imageBitmap, padX, padY, newW, newH);

  const imgData = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const rgba = imgData.data;

  // convert HWC (RGBA) to CHW (RGB) normalized to [0.0, 1.0] with fast stride loop
  const inv255 = 1.0 / 255.0;
  const p2 = 2 * pixelCount;
  for (let i = 0, i4 = 0; i < pixelCount; i++, i4 += 4) {
    preallocatedFloat32[i] = rgba[i4] * inv255; // channel 0: R
    preallocatedFloat32[pixelCount + i] = rgba[i4 + 1] * inv255; // channel 1: G
    preallocatedFloat32[p2 + i] = rgba[i4 + 2] * inv255; // channel 2: B
  }

  const tensor = new ort.Tensor("float32", preallocatedFloat32, [
    1,
    3,
    MODEL_INPUT_SIZE,
    MODEL_INPUT_SIZE,
  ]);
  return { tensor, scale, padX, padY, origW, origH };
}

// post-processes YOLOv8-Pose output tensor.
// output shape: [1, 56, 8400]
// 56 features:
//   0..3: x_center, y_center, width, height (bbox in 640x640 space)
//   4: box confidence score
//   5..55: 17 keypoints * 3 (x, y, confidence score per keypoint)
function postprocess(
  outputTensor: ort.Tensor,
  scale: number,
  padX: number,
  padY: number,
  origW: number,
  origH: number
): Keypoint[] | null {
  const data = outputTensor.data as Float32Array;
  // tensor shape: [1, 56, 8400]
  const numCandidates = 8400;

  let bestBoxIdx = -1;
  let maxScore = 0.25; // person detection threshold

  // find the candidate person box with the highest confidence
  for (let c = 0; c < numCandidates; c++) {
    const score = data[4 * numCandidates + c];
    if (score > maxScore) {
      maxScore = score;
      bestBoxIdx = c;
    }
  }

  if (bestBoxIdx === -1) {
    return null;
  }

  // extract the 17 keypoints from the highest confidence detection
  const keypoints: Keypoint[] = [];
  for (let k = 0; k < 17; k++) {
    const kxIdx = (5 + k * 3) * numCandidates + bestBoxIdx;
    const kyIdx = (5 + k * 3 + 1) * numCandidates + bestBoxIdx;
    const kScoreIdx = (5 + k * 3 + 2) * numCandidates + bestBoxIdx;

    const rawX = data[kxIdx];
    const rawY = data[kyIdx];
    const rawScore = data[kScoreIdx];
    // YOLO keypoint visibility values in ONNX exports are raw logits; apply sigmoid to get true probability
    const kScore = 1.0 / (1.0 + Math.exp(-rawScore));

    // un-letterbox: remove padding and rescale back to original image space
    const unpaddedX = (rawX - padX) / scale;
    const unpaddedY = (rawY - padY) / scale;

    // normalize coordinates to [0, 1] relative to video frame dimensions
    const normX = Math.max(0, Math.min(1, unpaddedX / origW));
    const normY = Math.max(0, Math.min(1, unpaddedY / origH));

    keypoints.push({
      x: normX,
      y: normY,
      score: kScore,
    });
  }

  // apply 1-euro filter to eliminate jitter while preserving fast movement fidelity
  return keypointFilter.filter(keypoints);
}

self.onmessage = async (e: MessageEvent<YoloWorkerRequest>) => {
  const msg = e.data;

  if (msg.type === "INIT_MODEL") {
    await initModel(msg.modelBuffer || msg.modelPath || "/models/yolov8n-pose.onnx");
    return;
  }

  if (msg.type === "PROCESS_FRAME") {
    const { imageBitmap } = msg;

    if (!session) {
      imageBitmap.close();
      const response: YoloWorkerResponse = {
        type: "ERROR",
        message: "Model not initialized yet",
      };
      self.postMessage(response);
      return;
    }

    const startTime = performance.now();
    try {
      const { tensor, scale, padX, padY, origW, origH } = preprocess(imageBitmap);
      imageBitmap.close(); // clean up GPU/memory transfer bitmap immediately

      // fetch input name dynamically from loaded ONNX session
      const inputName = session.inputNames[0];
      const feeds: Record<string, ort.Tensor> = {};
      feeds[inputName] = tensor;

      const results = await session.run(feeds);
      const outputName = session.outputNames[0];
      const outputTensor = results[outputName];

      const keypoints = postprocess(outputTensor, scale, padX, padY, origW, origH);
      const inferenceTimeMs = performance.now() - startTime;

      const response: YoloWorkerResponse = {
        type: "POSE_RESULT",
        keypoints,
        inferenceTimeMs,
      };
      self.postMessage(response);
    } catch (err: any) {
      console.error("[YOLO-Pose Worker] Inference error:", err);
      imageBitmap.close?.();
      const response: YoloWorkerResponse = {
        type: "ERROR",
        message: err?.message || "Inference error",
      };
      self.postMessage(response);
    }
  }
};
