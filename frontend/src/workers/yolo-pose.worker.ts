import * as ort from "onnxruntime-web";
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
// use single thread to keep memory footprint minimal and avoid virtual address exhaustion
ort.env.wasm.numThreads = 1;

let session: ort.InferenceSession | null = null;
let activeProvider: "webgpu" | "wasm" = "wasm";
const keypointFilter = new PoseKeypointFilter(17, 1.2, 0.007);

const MODEL_INPUT_SIZE = 640;
const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
// pre-allocated static buffer to avoid continuous memory reallocation and GC spikes
// pre-filled with standard YOLO letterbox gray (114 / 255.0)
const preallocatedFloat32 = new Float32Array(3 * pixelCount);
preallocatedFloat32.fill(114 / 255.0);

// offscreen canvas for letterboxing preprocessing
let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

function getCanvas(width = MODEL_INPUT_SIZE, height = MODEL_INPUT_SIZE): {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
} {
  if (!offscreenCanvas || !offscreenCtx) {
    offscreenCanvas = new OffscreenCanvas(width, height);
    offscreenCtx = offscreenCanvas.getContext("2d", {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D;
  }
  if (offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
    offscreenCanvas.width = width;
    offscreenCanvas.height = height;
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

    // try WebGPU first for maximum 30+ FPS hardware acceleration
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

  // compute aspect-ratio letterbox scaling
  const scale = Math.min(MODEL_INPUT_SIZE / origW, MODEL_INPUT_SIZE / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = Math.round((MODEL_INPUT_SIZE - newW) / 2);
  const padY = Math.round((MODEL_INPUT_SIZE - newH) / 2);

  // use offscreen canvas sized to newW x newH so getImageData only reads active pixels
  const { ctx } = getCanvas(newW, newH);

  // draw scaled image and ensure bitmap GPU surface is closed immediately
  try {
    ctx.drawImage(imageBitmap, 0, 0, newW, newH);
  } finally {
    imageBitmap.close();
  }

  const imgData = ctx.getImageData(0, 0, newW, newH);
  const rgba = imgData.data;

  // copy active image rows into preallocatedFloat32 centered with gray padding
  const inv255 = 1.0 / 255.0;
  const p2 = 2 * pixelCount;
  for (let y = 0; y < newH; y++) {
    const srcRowOffset = y * newW * 4;
    const dstRowOffset = (padY + y) * MODEL_INPUT_SIZE + padX;
    for (let x = 0; x < newW; x++) {
      const i4 = srcRowOffset + x * 4;
      const dstIdx = dstRowOffset + x;
      preallocatedFloat32[dstIdx] = rgba[i4] * inv255; // channel 0: R
      preallocatedFloat32[pixelCount + dstIdx] = rgba[i4 + 1] * inv255; // channel 1: G
      preallocatedFloat32[p2 + dstIdx] = rgba[i4 + 2] * inv255; // channel 2: B
    }
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

  // precompute row stride offsets to maximize CPU cache locality
  const rowW = 2 * numCandidates;
  const rowH = 3 * numCandidates;
  const rowBoxScore = 4 * numCandidates;
  const rowLHip = (5 + 11 * 3 + 2) * numCandidates;
  const rowRHip = (5 + 12 * 3 + 2) * numCandidates;
  const rowLKnee = (5 + 13 * 3 + 2) * numCandidates;
  const rowRKnee = (5 + 14 * 3 + 2) * numCandidates;
  const rowLAnk = (5 + 15 * 3 + 2) * numCandidates;
  const rowRAnk = (5 + 16 * 3 + 2) * numCandidates;

  let bestBoxIdx = -1;
  let bestQuality = 0;

  // find the candidate person box with highest full-body and lower-limb quality
  for (let c = 0; c < numCandidates; c++) {
    const boxScore = data[rowBoxScore + c];
    if (boxScore < 0.20) continue;

    const w = data[rowW + c];
    const h = data[rowH + c];
    const area = w * h;
    // reject tiny partial boxes (must have reasonable person scale)
    if (area < 2500) continue;

    // measure keypoint confidence across hips, knees, and ankles (COCO indices 11, 12, 13, 14, 15, 16)
    const legKeypointScore =
      (data[rowLHip + c] +
        data[rowRHip + c] +
        data[rowLKnee + c] +
        data[rowRKnee + c] +
        data[rowLAnk + c] +
        data[rowRAnk + c]) /
      6.0;
    const quality = boxScore * 0.4 + legKeypointScore * 0.6;

    if (quality > bestQuality) {
      bestQuality = quality;
      bestBoxIdx = c;
    }
  }

  // fallback to highest box score if no candidate passed the strict area filter
  if (bestBoxIdx === -1) {
    let maxScore = 0.25;
    for (let c = 0; c < numCandidates; c++) {
      const score = data[rowBoxScore + c];
      if (score > maxScore) {
        maxScore = score;
        bestBoxIdx = c;
      }
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
    // YOLO keypoint visibility scores in this ONNX export are direct probabilities [0, 1]
    const kScore = Math.max(0, Math.min(1, rawScore));

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
    let tensor: ort.Tensor | null = null;
    try {
      const prep = preprocess(imageBitmap);
      tensor = prep.tensor;

      // fetch input name dynamically from loaded ONNX session
      const inputName = session.inputNames[0];
      const feeds: Record<string, ort.Tensor> = {};
      feeds[inputName] = tensor;

      const results = await session.run(feeds);
      let keypoints: Keypoint[] | null = null;
      try {
        const outputName = session.outputNames[0];
        const outputTensor = results[outputName];
        keypoints = postprocess(outputTensor, prep.scale, prep.padX, prep.padY, prep.origW, prep.origH);
      } finally {
        // immediately dispose all output tensors to release WebGPU buffers from VRAM
        for (const name of Object.keys(results)) {
          results[name]?.dispose?.();
        }
      }

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
    } finally {
      // immediately dispose input tensor to release WebGPU buffers from VRAM
      tensor?.dispose?.();
    }
  }
};
