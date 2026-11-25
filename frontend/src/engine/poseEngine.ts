// kinematics and pose estimation engine powered by MediaPipe PoseLandmarker (33 landmarks).
// uses 3d metric world landmarks (origin at hip midpoint, metric units) for true 0° extension knee ROM,
// smoothed with 1-euro adaptive speed filtering to completely silence resting jitter.

import {
  PoseLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { OneEuroFilter, PoseLandmarkFilter } from "./oneEuroFilter";

export { type NormalizedLandmark };

export const MEDIAPIPE_KEYPOINTS = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export interface PoseState {
  targetKneeAngle: number;
  leftKneeAngle: number;
  rightKneeAngle: number;
  // side-on view alignment validation
  isSideAligned: boolean;
  sideAlignmentWarning: string | null;
  // estimated load bearing on injured leg (50 = symmetrical, <50 = offloaded to healthy, >50 = overloaded)
  weightDist: number;
  // trunk lean magnitude in degrees relative to vertical
  bodyLean: number;
  // direction of trunk lean relative to injury: "injured", "healthy", or "centered"
  leanDirection: "injured" | "healthy" | "centered";
  // leg physically closer to camera in side-on view ("left" | "right" | "unknown")
  nearSide: "left" | "right" | "unknown";
  // per-leg confidence — false when any key joint is occluded or below confidence threshold
  leftVisible: boolean;
  rightVisible: boolean;
  // normalized landmarks formatted for skeleton drawing
  normalizedLandmarks: NormalizedLandmark[];
}

type Vec3 = [number, number, number];
type Vec2 = [number, number];

// 3d euclidean joint angle from metric world landmarks (0° = full extension, 180° = full flexion)
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

// applies exponential moving average smoothing
function applyEma(curr: number, prev: number | null, alpha: number): number {
  if (prev === null || isNaN(prev)) return curr;
  return alpha * curr + (1 - alpha) * prev;
}

export class PoseEngine {
  injuredSide: "left" | "right" = "left";
  public alpha: number = 0.35;
  private landmarker: PoseLandmarker | null = null;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  private lastTimestampMs = -1;

  // 1-euro filters for rock-solid stability and zero lag
  private landmarkFilter = new PoseLandmarkFilter(33, 0.5, 0.02);
  private worldLandmarkFilter = new PoseLandmarkFilter(33, 0.5, 0.02);
  private angleFilterL = new OneEuroFilter(0.8, 0.02);
  private angleFilterR = new OneEuroFilter(0.8, 0.02);

  // temporal side-on alignment memory
  private prevShoulderRatio: number | null = null;
  private prevHipRatio: number | null = null;
  private prevW: number | null = null;
  private prevLean: number | null = null;

  async init(): Promise<void> {
    if (this.landmarker) return Promise.resolve();
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
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
          // fallback to CPU if GPU delegate is restricted by browser context
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
      } finally {
        this.isInitializing = false;
      }
    })();

    return this.initPromise;
  }

  // resets temporal EMA filters when switching exercises or sides
  resetFilters(): void {
    this.landmarkFilter.reset();
    this.worldLandmarkFilter.reset();
    this.angleFilterL.reset();
    this.angleFilterR.reset();
    this.prevW = null;
    this.prevLean = null;
    this.prevShoulderRatio = null;
    this.prevHipRatio = null;
  }

  // processes video frame directly via MediaPipe PoseLandmarker
  processFrame(
    video: HTMLVideoElement,
    timestampMs: number,
    _isFrontal?: boolean
  ): PoseState | null {
    if (!this.landmarker || !video || video.readyState < 2) {
      return null;
    }

    let validTimestamp = timestampMs;
    if (validTimestamp <= this.lastTimestampMs) {
      validTimestamp = this.lastTimestampMs + 1;
    }
    this.lastTimestampMs = validTimestamp;

    let result;
    try {
      result = this.landmarker.detectForVideo(video, validTimestamp);
    } catch {
      return null;
    }

    if (
      !result ||
      !result.landmarks ||
      result.landmarks.length === 0 ||
      !result.landmarks[0]
    ) {
      return null;
    }

    const rawNorm = result.landmarks[0];
    const rawWorld =
      result.worldLandmarks && result.worldLandmarks[0] && result.worldLandmarks[0].length > 0
        ? result.worldLandmarks[0]
        : rawNorm;

    // apply 1-euro adaptive speed filtering: heavy noise smoothing at rest, zero lag when moving
    const normalizedLandmarks = this.landmarkFilter.filter(rawNorm, validTimestamp);
    const worldLandmarks = this.worldLandmarkFilter.filter(rawWorld, validTimestamp);

    // key landmark references
    const lSh = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.LEFT_SHOULDER];
    const rSh = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.RIGHT_SHOULDER];
    const lHip = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.LEFT_HIP];
    const rHip = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.RIGHT_HIP];
    const lKnee = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.LEFT_KNEE];
    const rKnee = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.RIGHT_KNEE];
    const lAnkle = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.LEFT_ANKLE];
    const rAnkle = normalizedLandmarks[MEDIAPIPE_KEYPOINTS.RIGHT_ANKLE];

    // world landmarks for 3d metric angle (bone rotation centers reach true 0° extension)
    const wLHip = worldLandmarks[MEDIAPIPE_KEYPOINTS.LEFT_HIP];
    const wRHip = worldLandmarks[MEDIAPIPE_KEYPOINTS.RIGHT_HIP];
    const wLKnee = worldLandmarks[MEDIAPIPE_KEYPOINTS.LEFT_KNEE];
    const wRKnee = worldLandmarks[MEDIAPIPE_KEYPOINTS.RIGHT_KNEE];
    const wLAnk = worldLandmarks[MEDIAPIPE_KEYPOINTS.LEFT_ANKLE];
    const wRAnk = worldLandmarks[MEDIAPIPE_KEYPOINTS.RIGHT_ANKLE];

    const lVisible = (lHip?.visibility ?? 1) >= 0.5 && (lKnee?.visibility ?? 1) >= 0.5;
    const rVisible = (rHip?.visibility ?? 1) >= 0.5 && (rKnee?.visibility ?? 1) >= 0.5;

    // determine near side from depth
    let nearSide: "left" | "right" | "unknown" = "unknown";
    if (lKnee && rKnee) {
      if (lKnee.z !== undefined && rKnee.z !== undefined) {
        nearSide = lKnee.z < rKnee.z - 0.05 ? "left" : rKnee.z < lKnee.z - 0.05 ? "right" : "unknown";
      }
    }

    // compute 3D metric knee angles
    const rawAngleL = getAngle3d(
      [wLHip.x, wLHip.y, wLHip.z ?? 0],
      [wLKnee.x, wLKnee.y, wLKnee.z ?? 0],
      [wLAnk.x, wLAnk.y, wLAnk.z ?? 0]
    );
    const rawAngleR = getAngle3d(
      [wRHip.x, wRHip.y, wRHip.z ?? 0],
      [wRKnee.x, wRKnee.y, wRKnee.z ?? 0],
      [wRAnk.x, wRAnk.y, wRAnk.z ?? 0]
    );

    // smooth angles with 1-euro filter (eliminates angle flutter)
    const angleL = this.angleFilterL.filter(rawAngleL, validTimestamp);
    const angleR = this.angleFilterR.filter(rawAngleR, validTimestamp);

    const targetAngle = this.injuredSide === "left" ? angleL : angleR;

    // side-on view alignment check:
    let isSideAligned = true;
    let sideAlignmentWarning: string | null = null;

    const shoulderSpan = Math.abs(lSh.x - rSh.x);
    const hipSpan = Math.abs(lHip.x - rHip.x);
    const torsoHeight = Math.hypot(
      (lSh.x + rSh.x) / 2 - (lHip.x + rHip.x) / 2,
      (lSh.y + rSh.y) / 2 - (lHip.y + rHip.y) / 2
    );

    if (torsoHeight > 0.08) {
      const rawShoulderRatio = shoulderSpan / torsoHeight;
      const rawHipRatio = hipSpan / torsoHeight;
      this.prevShoulderRatio = applyEma(rawShoulderRatio, this.prevShoulderRatio, 0.25);
      this.prevHipRatio = applyEma(rawHipRatio, this.prevHipRatio, 0.25);

      const smoothShoulder = this.prevShoulderRatio ?? rawShoulderRatio;
      const smoothHip = this.prevHipRatio ?? rawHipRatio;

      if (smoothShoulder > 0.46 || smoothHip > 0.40) {
        isSideAligned = false;
        sideAlignmentWarning = "Turn 90° sideways to the camera";
      }
    }

    // frontal plane metrics:
    // 1. weight distribution across feet
    const comX = (lSh.x + rSh.x) / 2;
    const bosWidth = Math.abs(rAnkle.x - lAnkle.x);
    const healthyAnkleX = this.injuredSide === "left" ? rAnkle.x : lAnkle.x;

    let rawW = 50;
    if (bosWidth > 0.05) {
      const distFromHealthy = Math.abs(comX - healthyAnkleX);
      rawW = Math.max(0, Math.min(100, (distFromHealthy / bosWidth) * 100));
    }
    this.prevW = applyEma(rawW, this.prevW, 0.35);

    // 2. trunk lean relative to true vertical
    const midSh: Vec2 = [(lSh.x + rSh.x) / 2, (lSh.y + rSh.y) / 2];
    const midHip: Vec2 = [(lHip.x + rHip.x) / 2, (lHip.y + rHip.y) / 2];
    const trunkVec: Vec2 = [midSh[0] - midHip[0], midSh[1] - midHip[1]];
    const vertical: Vec2 = [0, -1];
    const trunkNorm = Math.sqrt(trunkVec[0] ** 2 + trunkVec[1] ** 2);

    let rawBodyLean = 0;
    if (trunkNorm > 0) {
      const dot = trunkVec[0] * vertical[0] + trunkVec[1] * vertical[1];
      const cosine = Math.max(-1, Math.min(1, dot / trunkNorm));
      rawBodyLean = (Math.acos(cosine) * 180) / Math.PI;
    }

    const lateralShift = trunkVec[0];
    let leanDirection: "injured" | "healthy" | "centered";
    if (Math.abs(lateralShift) < 0.015 || rawBodyLean < 2) {
      leanDirection = "centered";
    } else {
      const leaningSide = lateralShift > 0 ? "left" : "right";
      leanDirection = leaningSide === this.injuredSide ? "injured" : "healthy";
    }
    this.prevLean = applyEma(rawBodyLean, this.prevLean, 0.35);

    return {
      targetKneeAngle: targetAngle,
      leftKneeAngle: angleL,
      rightKneeAngle: angleR,
      isSideAligned,
      sideAlignmentWarning,
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
