// port of calibration.py
// runs mediapipe pose landmarker entirely client-side via wasm.
// uses world landmarks for 3d metric math (origin at hip midpoint, units in meters).

import {
  PoseLandmarker,
  FilesetResolver,
  type PoseLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

// landmark indices (mediapipe pose model, 33 landmarks)
const LM = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
} as const;

// min per-landmark confidence to trust a frame's angle data (matching calibration.py)
const VISIBILITY_THRESHOLD = 0.5;

export interface PoseState {
  targetKneeAngle: number;
  leftKneeAngle: number;
  rightKneeAngle: number;
  // estimated load bearing on injured leg
  // 50 = symmetrical, <50 = offloaded to healthy, >50 = overloaded
  weightDist: number;
  // trunk lean magnitude in degrees relative to vertical
  bodyLean: number;
  // direction of trunk lean relative to injury: "injured", "healthy", or "centered"
  leanDirection: "injured" | "healthy" | "centered";
  // leg physically closer to the camera, determined by knee z-depth
  nearSide: "left" | "right" | "unknown";
  // per-leg confidence — false when any key landmark is below visibility threshold.
  leftVisible: boolean;
  rightVisible: boolean;
  // normalized landmarks for skeleton drawing (0-1 image coords)
  normalizedLandmarks: NormalizedLandmark[];
}

type Vec3 = [number, number, number];
type Vec2 = [number, number];

// 3d euclidean joint angle converted to clinical goniometry notation (0° = full extension, 180° = full flexion)
function getAngle3d(a: Vec3, b: Vec3, c: Vec3): number {
  const ba: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const bc: Vec3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const dot = ba[0] * bc[0] + ba[1] * bc[1] + ba[2] * bc[2];
  const magBa = Math.sqrt(ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2);
  const magBc = Math.sqrt(bc[0] ** 2 + bc[1] ** 2 + bc[2] ** 2);
  const cosine = Math.max(-1, Math.min(1, dot / (magBa * magBc || 1e-6)));
  const internalAngle = (Math.acos(cosine) * 180) / Math.PI;
  return Math.max(0, Math.min(180, 180 - internalAngle));
}

// 2d planar angle converted to clinical goniometry notation (0° = full extension, 180° = full flexion)
function getAngle2d(a: Vec3, b: Vec3, c: Vec3): number {
  const ba: Vec2 = [a[0] - b[0], a[1] - b[1]];
  const bc: Vec2 = [c[0] - b[0], c[1] - b[1]];
  const dot = ba[0] * bc[0] + ba[1] * bc[1];
  const magBa = Math.sqrt(ba[0] ** 2 + ba[1] ** 2);
  const magBc = Math.sqrt(bc[0] ** 2 + bc[1] ** 2);
  const cosine = Math.max(-1, Math.min(1, dot / (magBa * magBc || 1e-6)));
  const internalAngle = (Math.acos(cosine) * 180) / Math.PI;
  return Math.max(0, Math.min(180, 180 - internalAngle));
}

// check visibility from normalized landmarks array (matching calibration.py _landmarks_visible)
function landmarksVisible(
  ...lms: (NormalizedLandmark | undefined)[]
): boolean {
  return lms.every((lm) => {
    if (!lm) return false;
    // if visibility is undefined or not provided by model, assume visible
    const v = lm.visibility !== undefined ? lm.visibility : 1.0;
    return v >= VISIBILITY_THRESHOLD;
  });
}

// apply exponential moving average (matching calibration.py apply_ema)
function applyEma(
  curr: number,
  prev: number | null,
  alpha: number
): number {
  if (prev === null || isNaN(prev)) return curr;
  return alpha * curr + (1 - alpha) * prev;
}

export class PoseEngine {
  private landmarker: PoseLandmarker | null = null;
  private latestResult: PoseLandmarkerResult | null = null;
  private lastTimestampMs = 0;

  injuredSide: "left" | "right" = "left";
  alpha = 0.25;

  // ema temporal memory
  private prevL: number | null = null;
  private prevR: number | null = null;
  private prevW: number | null = null;
  private prevLean: number | null = null;

  // initialize the mediapipe wasm runtime and create the pose landmarker.
  async init(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm"
    );

    try {
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch {
      // fallback to CPU if GPU delegate encounters WebGL constraints
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
  }

  // reset temporal ema filters when switching states (matching calibration.py reset_filters)
  resetFilters(): void {
    this.prevL = null;
    this.prevR = null;
    this.prevW = null;
    this.prevLean = null;
  }

  // process a single video frame and return the current pose state.
  // mirrors calibration.py process_frame().
  processFrame(
    video: HTMLVideoElement,
    timestampMs: number,
    isFrontal?: boolean
  ): PoseState | null {
    if (!this.landmarker || !video || video.readyState < 2) {
      return null;
    }

    // ensure timestamp is strictly monotonically increasing
    let validTimestamp = timestampMs;
    if (validTimestamp <= this.lastTimestampMs) {
      validTimestamp = this.lastTimestampMs + 1;
    }
    this.lastTimestampMs = validTimestamp;

    try {
      this.latestResult = this.landmarker.detectForVideo(video, validTimestamp);
    } catch {
      return null;
    }

    const result = this.latestResult;
    if (
      !result ||
      !result.landmarks ||
      result.landmarks.length === 0 ||
      !result.landmarks[0]
    ) {
      return null;
    }

    const normalizedLandmarks = result.landmarks[0];
    const wlms =
      result.worldLandmarks && result.worldLandmarks[0] && result.worldLandmarks[0].length > 0
        ? result.worldLandmarks[0]
        : normalizedLandmarks;

    // convenience refs for normalized landmarks (for visibility checks)
    const normLHip = normalizedLandmarks[LM.LEFT_HIP];
    const normLKnee = normalizedLandmarks[LM.LEFT_KNEE];
    const normLAnkle = normalizedLandmarks[LM.LEFT_ANKLE];
    const normRHip = normalizedLandmarks[LM.RIGHT_HIP];
    const normRKnee = normalizedLandmarks[LM.RIGHT_KNEE];
    const normRAnkle = normalizedLandmarks[LM.RIGHT_ANKLE];

    // convenience refs for world landmarks (for 3D metric math in meters)
    const lmLHip = wlms[LM.LEFT_HIP] ?? normLHip;
    const lmLKnee = wlms[LM.LEFT_KNEE] ?? normLKnee;
    const lmLAnkle = wlms[LM.LEFT_ANKLE] ?? normLAnkle;
    const lmRHip = wlms[LM.RIGHT_HIP] ?? normRHip;
    const lmRKnee = wlms[LM.RIGHT_KNEE] ?? normRKnee;
    const lmRAnkle = wlms[LM.RIGHT_ANKLE] ?? normRAnkle;

    if (!lmLHip || !lmLKnee || !lmLAnkle || !lmRHip || !lmRKnee || !lmRAnkle) {
      return null;
    }

    // extract coords
    const lHip: Vec3 = [lmLHip.x, lmLHip.y, lmLHip.z ?? 0];
    const lKnee: Vec3 = [lmLKnee.x, lmLKnee.y, lmLKnee.z ?? 0];
    const lAnkle: Vec3 = [lmLAnkle.x, lmLAnkle.y, lmLAnkle.z ?? 0];
    const rHip: Vec3 = [lmRHip.x, lmRHip.y, lmRHip.z ?? 0];
    const rKnee: Vec3 = [lmRKnee.x, lmRKnee.y, lmRKnee.z ?? 0];
    const rAnkle: Vec3 = [lmRAnkle.x, lmRAnkle.y, lmRAnkle.z ?? 0];

    // determine which leg is closer to camera using knee z-depth (matching calibration.py)
    const kneeZDiff = (lmLKnee.z ?? 0) - (lmRKnee.z ?? 0);
    let nearSide: "left" | "right" | "unknown";
    if (kneeZDiff < -0.05) nearSide = "left";
    else if (kneeZDiff > 0.05) nearSide = "right";
    else nearSide = "unknown";

    // auto-detect frontal mode if not explicitly passed
    const frontal = isFrontal !== undefined ? isFrontal : nearSide === "unknown";

    // per-leg visibility gate checked against normalized landmarks
    const lVisible = landmarksVisible(normLHip, normLKnee, normLAnkle);
    const rVisible = landmarksVisible(normRHip, normRKnee, normRAnkle);

    // 2D planar vectors from normalized image landmarks (0-1 coords)
    const normLHipVec: Vec3 = [normLHip.x, normLHip.y, 0];
    const normLKneeVec: Vec3 = [normLKnee.x, normLKnee.y, 0];
    const normLAnkleVec: Vec3 = [normLAnkle.x, normLAnkle.y, 0];
    const normRHipVec: Vec3 = [normRHip.x, normRHip.y, 0];
    const normRKneeVec: Vec3 = [normRKnee.x, normRKnee.y, 0];
    const normRAnkleVec: Vec3 = [normRAnkle.x, normRAnkle.y, 0];

    // compute angles: 3D world metric math for frontal mode, pure 2D image coordinates for side-on trainer tracking
    const rawAngleL = frontal
      ? getAngle3d(lHip, lKnee, lAnkle)
      : getAngle2d(normLHipVec, normLKneeVec, normLAnkleVec);

    const rawAngleR = frontal
      ? getAngle3d(rHip, rKnee, rAnkle)
      : getAngle2d(normRHipVec, normRKneeVec, normRAnkleVec);

    if (lVisible) {
      this.prevL = applyEma(rawAngleL, this.prevL, this.alpha);
    }
    if (rVisible) {
      this.prevR = applyEma(rawAngleR, this.prevR, this.alpha);
    }

    const angleL = this.prevL ?? rawAngleL;
    const angleR = this.prevR ?? rawAngleR;

    const targetAngle =
      this.injuredSide === "left" ? angleL : angleR;

    // weight distribution (matching calibration.py lines 155-171)
    const normLSh = normalizedLandmarks[LM.LEFT_SHOULDER];
    const normRSh = normalizedLandmarks[LM.RIGHT_SHOULDER];
    const lSh = wlms[LM.LEFT_SHOULDER] ?? normLSh;
    const rSh = wlms[LM.RIGHT_SHOULDER] ?? normRSh;

    const comX = lSh && rSh ? (lSh.x + rSh.x) / 2 : (lHip[0] + rHip[0]) / 2;
    const bosWidth = Math.abs(rAnkle[0] - lAnkle[0]);
    const healthyAnkleX =
      this.injuredSide === "left" ? rAnkle[0] : lAnkle[0];

    let rawW = 50;
    if (bosWidth > 0.05) {
      const distFromHealthy = Math.abs(comX - healthyAnkleX);
      rawW = Math.max(0, Math.min(100, (distFromHealthy / bosWidth) * 100));
    }
    this.prevW = applyEma(rawW, this.prevW, this.alpha);

    // trunk lean calculation (matching calibration.py lines 173-187)
    const shL: Vec2 = lSh ? [lSh.x, lSh.y] : [lHip[0], lHip[1] - 0.5];
    const shR: Vec2 = rSh ? [rSh.x, rSh.y] : [rHip[0], rHip[1] - 0.5];
    const midSh: Vec2 = [(shL[0] + shR[0]) / 2, (shL[1] + shR[1]) / 2];
    const midHip: Vec2 = [(lHip[0] + rHip[0]) / 2, (lHip[1] + rHip[1]) / 2];
    const trunkVec: Vec2 = [midSh[0] - midHip[0], midSh[1] - midHip[1]];
    const vertical: Vec2 = [0, -1];
    const norm = Math.sqrt(trunkVec[0] ** 2 + trunkVec[1] ** 2);

    let rawBodyLean = 0;
    if (norm > 0) {
      const dot = trunkVec[0] * vertical[0] + trunkVec[1] * vertical[1];
      const cosine = Math.max(-1, Math.min(1, dot / norm));
      rawBodyLean = (Math.acos(cosine) * 180) / Math.PI;
    }

    // determine lean direction relative to injured side
    const lateralShift = trunkVec[0]; // positive = subject's left
    let leanDirection: "injured" | "healthy" | "centered";
    if (Math.abs(lateralShift) < 0.015 || rawBodyLean < 2) {
      leanDirection = "centered";
    } else {
      const leaningSide = lateralShift > 0 ? "left" : "right";
      leanDirection =
        leaningSide === this.injuredSide ? "injured" : "healthy";
    }

    this.prevLean = applyEma(rawBodyLean, this.prevLean, this.alpha);

    return {
      targetKneeAngle: targetAngle,
      leftKneeAngle: angleL,
      rightKneeAngle: angleR,
      weightDist: this.prevW ?? 50,
      bodyLean: this.prevLean ?? 0,
      leanDirection,
      nearSide,
      leftVisible: lVisible,
      rightVisible: rVisible,
      normalizedLandmarks,
    };
  }
}
