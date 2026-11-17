// Keypoint definition for YOLOv8 Pose (17 COCO keypoints)
export interface Keypoint {
  x: number; // normalized [0, 1] relative to original image width
  y: number; // normalized [0, 1] relative to original image height
  score: number; // confidence score [0, 1]
}

export type PoseKeypoints = Keypoint[]; // length 17

export interface YoloPoseWorkerInput {
  type: "PROCESS_FRAME";
  imageBitmap: ImageBitmap;
}

export interface YoloPoseWorkerInit {
  type: "INIT_MODEL";
  modelPath?: string;
}

export type YoloWorkerRequest = YoloPoseWorkerInput | YoloPoseWorkerInit;

export interface YoloPoseWorkerReady {
  type: "MODEL_READY";
  provider: "webgpu" | "wasm";
}

export interface YoloPoseWorkerResult {
  type: "POSE_RESULT";
  keypoints: PoseKeypoints | null; // null if no person detected with sufficient confidence
  inferenceTimeMs: number;
}

export interface YoloPoseWorkerError {
  type: "ERROR";
  message: string;
}

export type YoloWorkerResponse =
  | YoloPoseWorkerReady
  | YoloPoseWorkerResult
  | YoloPoseWorkerError;

// COCO keypoint indices for reference
export const COCO_KEYPOINTS = {
  NOSE: 0,
  LEFT_EYE: 1,
  RIGHT_EYE: 2,
  LEFT_EAR: 3,
  RIGHT_EAR: 4,
  LEFT_SHOULDER: 5,
  RIGHT_SHOULDER: 6,
  LEFT_ELBOW: 7,
  RIGHT_ELBOW: 8,
  LEFT_WRIST: 9,
  RIGHT_WRIST: 10,
  LEFT_HIP: 11,
  RIGHT_HIP: 12,
  LEFT_KNEE: 13,
  RIGHT_KNEE: 14,
  LEFT_ANKLE: 15,
  RIGHT_ANKLE: 16,
} as const;
