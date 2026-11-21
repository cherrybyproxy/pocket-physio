// kinematics and pose estimation engine powered by YOLOv8-Pose (17 COCO keypoints).
// calculates 2D planar joint angles on side-on view (knee ROM)
// and lateral metrics on frontal view (trunk lean, weight offloading).

import type { Keypoint, PoseKeypoints } from "../types/yoloPose";
import { COCO_KEYPOINTS } from "../types/yoloPose";

// minimum per-landmark confidence score to trust a joint coordinate
const CONFIDENCE_THRESHOLD = 0.10;

export interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface PoseState {
  targetKneeAngle: number;
  leftKneeAngle: number;
  rightKneeAngle: number;
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

type Vec2 = [number, number];

// 2D planar joint angle converted to standard clinical notation (0° = full extension, 180° = full flexion)
function getAngle2d(a: Vec2, b: Vec2, c: Vec2): number {
  const ba: Vec2 = [a[0] - b[0], a[1] - b[1]];
  const bc: Vec2 = [c[0] - b[0], c[1] - b[1]];
  const dot = ba[0] * bc[0] + ba[1] * bc[1];
  const magBa = Math.sqrt(ba[0] ** 2 + ba[1] ** 2);
  const magBc = Math.sqrt(bc[0] ** 2 + bc[1] ** 2);
  const cosine = Math.max(-1, Math.min(1, dot / (magBa * magBc || 1e-6)));
  const internalAngle = (Math.acos(cosine) * 180) / Math.PI;
  return Math.max(0, Math.min(180, 180 - internalAngle));
}

// verifies joint visibility: hip and knee must meet confidence; ankle coordinate must be finite
function isLegTrackingValid(
  hip?: Keypoint,
  knee?: Keypoint,
  ankle?: Keypoint
): boolean {
  if (!hip || !knee || !ankle) return false;
  if (hip.score < CONFIDENCE_THRESHOLD || knee.score < CONFIDENCE_THRESHOLD) {
    return false;
  }
  return Number.isFinite(ankle.x) && Number.isFinite(ankle.y);
}

// applies exponential moving average smoothing
function applyEma(curr: number, prev: number | null, alpha: number): number {
  if (prev === null || isNaN(prev)) return curr;
  return alpha * curr + (1 - alpha) * prev;
}

export class PoseEngine {
  injuredSide: "left" | "right" = "left";
  alpha = 0.35;

  // EMA temporal memory
  private prevL: number | null = null;
  private prevR: number | null = null;
  private prevW: number | null = null;
  private prevLean: number | null = null;

  // temporal ankle tracking memory
  private prevAnkleL: Vec2 | null = null;
  private prevAnkleR: Vec2 | null = null;

  // backwards-compatible dummy method for CameraView lifecycles
  async init(): Promise<void> {
    // model initialization is handled asynchronously in yolo-pose.worker.ts
    return Promise.resolve();
  }

  // resets temporal EMA filters when switching exercises or sides
  resetFilters(): void {
    this.prevL = null;
    this.prevR = null;
    this.prevW = null;
    this.prevLean = null;
    this.prevAnkleL = null;
    this.prevAnkleR = null;
  }

  // stabilizes ankle tracking with outlier rejection and temporal continuity.
  // prevents coordinate flailing while maintaining smooth tracking down to full extension (0°)
  // even when pants fabric lowers contrast or covers the ankle joint.
  private stabilizeAnkle(
    hip: Keypoint,
    knee: Keypoint,
    ankle: Keypoint,
    side: "left" | "right"
  ): { x: number; y: number; confidence: number } {
    let currX = ankle.x;
    let currY = ankle.y;
    let conf = ankle.score;

    const prev = side === "left" ? this.prevAnkleL : this.prevAnkleR;
    const femurLen = Math.hypot(knee.x - hip.x, knee.y - hip.y);
    const shinLen = Math.hypot(currX - knee.x, currY - knee.y);

    if (prev && femurLen > 0.05) {
      // 1. if ankle collapsed up toward the knee (pants hem misdetected as ankle), hold previous valid position
      if (shinLen < 0.38 * femurLen) {
        currX = prev[0];
        currY = prev[1];
        conf = Math.max(conf, 0.45);
      } else {
        // 2. reject outlier jumps by clamping maximum displacement to 8% of screen per frame
        const dx = currX - prev[0];
        const dy = currY - prev[1];
        const jumpDist = Math.hypot(dx, dy);
        const maxJump = 0.08;

        if (jumpDist > maxJump) {
          currX = prev[0] + (dx / jumpDist) * maxJump;
          currY = prev[1] + (dy / jumpDist) * maxJump;
        }

        // 3. smooth temporal blending: confident detections update swiftly, low confidence smooths heavily
        const blend = Math.max(0.18, Math.min(0.70, conf));
        currX = blend * currX + (1 - blend) * prev[0];
        currY = blend * currY + (1 - blend) * prev[1];
      }
    }

    // clamp coordinates to normalized [0, 1] frame bounds
    currX = Math.max(0, Math.min(1, currX));
    currY = Math.max(0, Math.min(1, currY));

    if (side === "left") {
      this.prevAnkleL = [currX, currY];
    } else {
      this.prevAnkleR = [currX, currY];
    }

    return { x: currX, y: currY, confidence: Math.max(conf, 0.35) };
  }

  // processes 17 COCO keypoints received from YOLOv8 worker
  processKeypoints(
    keypoints: PoseKeypoints | null,
    _isFrontal?: boolean
  ): PoseState | null {
    if (!keypoints || keypoints.length < 17) {
      return null;
    }

    // map keypoints to COCO landmark indices
    const lSh = keypoints[COCO_KEYPOINTS.LEFT_SHOULDER];
    const rSh = keypoints[COCO_KEYPOINTS.RIGHT_SHOULDER];
    const lHip = keypoints[COCO_KEYPOINTS.LEFT_HIP];
    const rHip = keypoints[COCO_KEYPOINTS.RIGHT_HIP];
    const lKnee = keypoints[COCO_KEYPOINTS.LEFT_KNEE];
    const rKnee = keypoints[COCO_KEYPOINTS.RIGHT_KNEE];
    const lAnkle = keypoints[COCO_KEYPOINTS.LEFT_ANKLE];
    const rAnkle = keypoints[COCO_KEYPOINTS.RIGHT_ANKLE];

    // apply ankle stabilization to eliminate noise and hold positions during pants occlusion
    const stableAnkleL = this.stabilizeAnkle(lHip, lKnee, lAnkle, "left");
    const stableAnkleR = this.stabilizeAnkle(rHip, rKnee, rAnkle, "right");

    // convert keypoints to normalized landmarks for skeleton canvas drawing
    const normalizedLandmarks: NormalizedLandmark[] = keypoints.map((kp, idx) => {
      if (idx === COCO_KEYPOINTS.LEFT_ANKLE) {
        return {
          x: stableAnkleL.x,
          y: stableAnkleL.y,
          visibility: stableAnkleL.confidence,
        };
      }
      if (idx === COCO_KEYPOINTS.RIGHT_ANKLE) {
        return {
          x: stableAnkleR.x,
          y: stableAnkleR.y,
          visibility: stableAnkleR.confidence,
        };
      }
      return {
        x: kp.x,
        y: kp.y,
        visibility: kp.score,
      };
    });

    // verify per-leg tracking validity with stabilized joints
    const lVisible = isLegTrackingValid(lHip, lKnee, {
      x: stableAnkleL.x,
      y: stableAnkleL.y,
      score: stableAnkleL.confidence,
    });
    const rVisible = isLegTrackingValid(rHip, rKnee, {
      x: stableAnkleR.x,
      y: stableAnkleR.y,
      score: stableAnkleR.confidence,
    });

    // determine near side based on keypoint confidence & presence
    let nearSide: "left" | "right" | "unknown" = "unknown";
    if (lKnee.score > rKnee.score + 0.10) nearSide = "left";
    else if (rKnee.score > lKnee.score + 0.10) nearSide = "right";

    // compute 2D knee angles (side-on view) using stabilized ankle positions
    const rawAngleL = getAngle2d(
      [lHip.x, lHip.y],
      [lKnee.x, lKnee.y],
      [stableAnkleL.x, stableAnkleL.y]
    );
    const rawAngleR = getAngle2d(
      [rHip.x, rHip.y],
      [rKnee.x, rKnee.y],
      [stableAnkleR.x, stableAnkleR.y]
    );

    // apply EMA smoothing for joint angles
    if (lVisible) {
      this.prevL = applyEma(rawAngleL, this.prevL, this.alpha);
    }
    if (rVisible) {
      this.prevR = applyEma(rawAngleR, this.prevR, this.alpha);
    }

    const angleL = this.prevL ?? rawAngleL;
    const angleR = this.prevR ?? rawAngleR;

    // always track strictly the selected target side (no jumping between legs)
    const targetAngle = this.injuredSide === "left" ? angleL : angleR;

    // frontal plane metrics:
    // 1. weight distribution across feet
    const comX = (lSh.x + rSh.x) / 2;
    const bosWidth = Math.abs(stableAnkleR.x - stableAnkleL.x);
    const healthyAnkleX = this.injuredSide === "left" ? stableAnkleR.x : stableAnkleL.x;

    let rawW = 50;
    if (bosWidth > 0.05) {
      const distFromHealthy = Math.abs(comX - healthyAnkleX);
      rawW = Math.max(0, Math.min(100, (distFromHealthy / bosWidth) * 100));
    }
    this.prevW = applyEma(rawW, this.prevW, this.alpha);

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
