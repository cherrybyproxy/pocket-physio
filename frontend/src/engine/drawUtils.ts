// canvas drawing helpers for pocket physio:
// focuses exclusively on torso, hips, and legs (no face or arm clutter).
// orange on left leg, teal on right leg, white on torso midline.
// clean, crisp aesthetic without neon bloom.

import type { NormalizedLandmark } from "./poseEngine";
import { COCO_KEYPOINTS } from "../types/yoloPose";

interface ConnectionSpec {
  pair: [number, number];
  color: string;
}

// focused lower-body & torso pose connections using COCO 17 keypoint indices
const LOWER_BODY_CONNECTIONS: ConnectionSpec[] = [
  // left leg (orange): hip (11) -> knee (13) -> ankle (15)
  { pair: [COCO_KEYPOINTS.LEFT_HIP, COCO_KEYPOINTS.LEFT_KNEE], color: "#AC3834" },
  { pair: [COCO_KEYPOINTS.LEFT_KNEE, COCO_KEYPOINTS.LEFT_ANKLE], color: "#AC3834" },

  // right leg (teal): hip (12) -> knee (14) -> ankle (16)
  { pair: [COCO_KEYPOINTS.RIGHT_HIP, COCO_KEYPOINTS.RIGHT_KNEE], color: "#4292C6" },
  { pair: [COCO_KEYPOINTS.RIGHT_KNEE, COCO_KEYPOINTS.RIGHT_ANKLE], color: "#4292C6" },

  // torso frame (neutral white & side bounds)
  { pair: [COCO_KEYPOINTS.LEFT_SHOULDER, COCO_KEYPOINTS.RIGHT_SHOULDER], color: "#ffffff" }, // shoulders (5, 6)
  { pair: [COCO_KEYPOINTS.LEFT_HIP, COCO_KEYPOINTS.RIGHT_HIP], color: "#ffffff" }, // hips (11, 12)
  { pair: [COCO_KEYPOINTS.LEFT_SHOULDER, COCO_KEYPOINTS.LEFT_HIP], color: "rgba(172, 56, 52, 0.7)" }, // left trunk
  { pair: [COCO_KEYPOINTS.RIGHT_SHOULDER, COCO_KEYPOINTS.RIGHT_HIP], color: "rgba(66, 146, 198, 0.7)" }, // right trunk
];

// visible joint landmark indices: shoulders (5, 6), hips (11, 12), knees (13, 14), ankles (15, 16)
const VISIBLE_JOINTS = new Set<number>([
  COCO_KEYPOINTS.LEFT_SHOULDER,
  COCO_KEYPOINTS.RIGHT_SHOULDER,
  COCO_KEYPOINTS.LEFT_HIP,
  COCO_KEYPOINTS.RIGHT_HIP,
  COCO_KEYPOINTS.LEFT_KNEE,
  COCO_KEYPOINTS.RIGHT_KNEE,
  COCO_KEYPOINTS.LEFT_ANKLE,
  COCO_KEYPOINTS.RIGHT_ANKLE,
]);

const LEFT_JOINTS = new Set<number>([
  COCO_KEYPOINTS.LEFT_HIP,
  COCO_KEYPOINTS.LEFT_KNEE,
  COCO_KEYPOINTS.LEFT_ANKLE,
]);

const RIGHT_JOINTS = new Set<number>([
  COCO_KEYPOINTS.RIGHT_HIP,
  COCO_KEYPOINTS.RIGHT_KNEE,
  COCO_KEYPOINTS.RIGHT_ANKLE,
]);

// draw the clean pose skeleton (torso + legs only, no face or arms).
// landmarks are in normalized [0,1] coordinates relative to the video frame.
// filterSide allows isolating left or right side during manual side-on calibration.
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  filterSide?: "left" | "right" | "all"
): void {
  if (!landmarks || landmarks.length === 0) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3.5;

  // draw clean bone connections
  for (const conn of LOWER_BODY_CONNECTIONS) {
    const [i, j] = conn.pair;

    if (filterSide === "left" && (!LEFT_JOINTS.has(i) || !LEFT_JOINTS.has(j))) {
      continue;
    }
    if (filterSide === "right" && (!RIGHT_JOINTS.has(i) || !RIGHT_JOINTS.has(j))) {
      continue;
    }

    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;

    const aVis = a.visibility ?? 1;
    const bVis = b.visibility ?? 1;
    if (aVis < 0.20 || bVis < 0.20) continue;

    ctx.strokeStyle = conn.color;
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    ctx.lineTo(b.x * width, b.y * height);
    ctx.stroke();
  }

  // draw joint dots only for relevant joints
  for (const i of VISIBLE_JOINTS) {
    if (filterSide === "left" && !LEFT_JOINTS.has(i)) continue;
    if (filterSide === "right" && !RIGHT_JOINTS.has(i)) continue;

    const lm = landmarks[i];
    if (!lm) continue;

    const v = lm.visibility ?? 1;
    if (v < 0.20) continue;

    const isKnee = i === COCO_KEYPOINTS.LEFT_KNEE || i === COCO_KEYPOINTS.RIGHT_KNEE;
    const isHip = i === COCO_KEYPOINTS.LEFT_HIP || i === COCO_KEYPOINTS.RIGHT_HIP;
    const isAnkle = i === COCO_KEYPOINTS.LEFT_ANKLE || i === COCO_KEYPOINTS.RIGHT_ANKLE;
    const isKeyJoint = isKnee || isHip || isAnkle;

    const radius = isKeyJoint ? 6 : 4;

    ctx.beginPath();
    ctx.arc(lm.x * width, lm.y * height, radius, 0, 2 * Math.PI);

    if (LEFT_JOINTS.has(i)) {
      // left leg: orange
      ctx.fillStyle = "#AC3834";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = isKeyJoint ? 2 : 1;
    } else if (RIGHT_JOINTS.has(i)) {
      // right leg: teal
      ctx.fillStyle = "#4292C6";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = isKeyJoint ? 2 : 1;
    } else {
      // shoulders / neutral: white
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#71717a";
      ctx.lineWidth = 1;
    }

    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

export function drawHudText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string = "#ffffff",
  fontSize: number = 18
): void {
  ctx.save();
  ctx.font = `600 ${fontSize}px 'Inter', system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = "top";

  // clean subtle background shadow for contrast
  ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);

  ctx.restore();
}

// draw real-time dynamic target ROM arc gauge overlay directly on the active knee joint
export function drawTargetArcGauge(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  injuredSide: "left" | "right",
  currentAngle: number,
  minAngle: number,
  maxAngle: number
): void {
  if (!landmarks || landmarks.length === 0) return;

  const kneeIdx = injuredSide === "left" ? COCO_KEYPOINTS.LEFT_KNEE : COCO_KEYPOINTS.RIGHT_KNEE;
  const hipIdx = injuredSide === "left" ? COCO_KEYPOINTS.LEFT_HIP : COCO_KEYPOINTS.RIGHT_HIP;
  const ankleIdx = injuredSide === "left" ? COCO_KEYPOINTS.LEFT_ANKLE : COCO_KEYPOINTS.RIGHT_ANKLE;

  const knee = landmarks[kneeIdx];
  const hip = landmarks[hipIdx];
  const ankle = landmarks[ankleIdx];

  if (!knee || !hip || !ankle) return;
  if ((knee.visibility ?? 1) < 0.35) return;

  const kx = knee.x * width;
  const ky = knee.y * height;
  const hx = hip.x * width;
  const hy = hip.y * height;

  ctx.save();

  // thigh angle reference direction (hip to knee)
  const thighAngle = Math.atan2(hy - ky, hx - kx);
  const radius = Math.max(35, Math.min(65, height * 0.07));

  // background target ROM track arc around knee (matching leg side tone)
  ctx.beginPath();
  ctx.arc(kx, ky, radius, thighAngle - Math.PI * 0.65, thighAngle + Math.PI * 0.65);
  ctx.lineWidth = 5;
  ctx.strokeStyle = injuredSide === "left" ? "#881D1D" : "#08519C";
  ctx.stroke();

  // calculate active arc fill proportional to joint angle
  const minA = minAngle !== undefined ? minAngle : 0;
  const maxA = maxAngle !== undefined ? maxAngle : 120;
  const romRange = Math.max(1, maxA - minA);
  const angleRatio = Math.max(0, Math.min(1, (currentAngle - minA) / romRange));
  const activeArcAngle = thighAngle - Math.PI * 0.6 + angleRatio * (Math.PI * 1.2);

  // active moving arc color matching the side (Orange for left, Teal for right)
  const arcColor = injuredSide === "left" ? "#AC3834" : "#4292C6";

  // draw active ROM fill arc
  ctx.beginPath();
  ctx.arc(kx, ky, radius, thighAngle - Math.PI * 0.6, activeArcAngle);
  ctx.lineWidth = 6;
  ctx.strokeStyle = arcColor;
  ctx.stroke();

  // target flexion & extension marker dots
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(
    kx + (radius + 6) * Math.cos(thighAngle - Math.PI * 0.6),
    ky + (radius + 6) * Math.sin(thighAngle - Math.PI * 0.6),
    3.5,
    0,
    2 * Math.PI
  );
  ctx.fill();

  ctx.beginPath();
  ctx.arc(
    kx + (radius + 6) * Math.cos(thighAngle + Math.PI * 0.6),
    ky + (radius + 6) * Math.sin(thighAngle + Math.PI * 0.6),
    3.5,
    0,
    2 * Math.PI
  );
  ctx.fill();

  ctx.restore();
}

// visual overlays for frontal diagnostics:
// 1. hip-to-ankle plumb line (dashed mechanical reference axis)
// 2. knee deviation vector (valgus inward collapse or varus outward bowing)
// 3. pelvic horizontal tilt line (hip drop relative to level horizontal)
export function drawFrontalDiagnostics(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  filterSide?: "left" | "right" | "all"
): void {
  if (!landmarks || landmarks.length === 0) return;

  const lHip = landmarks[COCO_KEYPOINTS.LEFT_HIP];
  const rHip = landmarks[COCO_KEYPOINTS.RIGHT_HIP];
  const lKnee = landmarks[COCO_KEYPOINTS.LEFT_KNEE];
  const rKnee = landmarks[COCO_KEYPOINTS.RIGHT_KNEE];
  const lAnkle = landmarks[COCO_KEYPOINTS.LEFT_ANKLE];
  const rAnkle = landmarks[COCO_KEYPOINTS.RIGHT_ANKLE];

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 1. pelvic horizontal tilt line (hip drop)
  const lHipVis = lHip?.visibility ?? 0;
  const rHipVis = rHip?.visibility ?? 0;

  if (lHip && rHip && lHipVis >= 0.25 && rHipVis >= 0.25) {
    const lx = lHip.x * width;
    const ly = lHip.y * height;
    const rx = rHip.x * width;
    const ry = rHip.y * height;

    const midX = (lx + rx) / 2;
    const midY = (ly + ry) / 2;
    const hipSpan = Math.hypot(rx - lx, ry - ly);

    if (hipSpan > 15) {
      // draw dashed horizontal level reference line across pelvic center
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.moveTo(midX - hipSpan * 0.65, midY);
      ctx.lineTo(midX + hipSpan * 0.65, midY);
      ctx.stroke();

      // actual pelvic tilt line connecting left and right hip
      const dropDelta = Math.abs(ly - ry);
      const isDropped = dropDelta > height * 0.015;

      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = isDropped ? "#f59e0b" : "rgba(255, 255, 255, 0.85)";
      ctx.moveTo(lx, ly);
      ctx.lineTo(rx, ry);
      ctx.stroke();

      // draw vertical drop marker from the lower hip to the horizontal reference plane
      if (isDropped) {
        const lowerY = Math.max(ly, ry);
        const lowerX = ly > ry ? lx : rx;
        ctx.beginPath();
        ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#f59e0b";
        ctx.moveTo(lowerX, midY);
        ctx.lineTo(lowerX, lowerY);
        ctx.stroke();
      }

      // pelvic midpoint dot
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.arc(midX, midY, 3, 0, 2 * Math.PI);
      ctx.fillStyle = isDropped ? "#f59e0b" : "#ffffff";
      ctx.fill();
    }
  }

  // 2. hip-to-ankle plumb line + knee deviation vector (valgus)
  const legsToProcess: Array<{
    side: "left" | "right";
    hip: NormalizedLandmark | undefined;
    knee: NormalizedLandmark | undefined;
    ankle: NormalizedLandmark | undefined;
    baseColor: string;
  }> = [];

  if (filterSide !== "right") {
    legsToProcess.push({
      side: "left",
      hip: lHip,
      knee: lKnee,
      ankle: lAnkle,
      baseColor: "#AC3834",
    });
  }

  if (filterSide !== "left") {
    legsToProcess.push({
      side: "right",
      hip: rHip,
      knee: rKnee,
      ankle: rAnkle,
      baseColor: "#4292C6",
    });
  }

  // pelvis center x for valgus vs varus lateral calculation
  const pelvisCenterX = lHip && rHip ? ((lHip.x + rHip.x) / 2) * width : width / 2;

  for (const leg of legsToProcess) {
    const { hip, knee, ankle, baseColor } = leg;
    if (!hip || !knee || !ankle) continue;
    if (
      (hip.visibility ?? 0) < 0.25 ||
      (knee.visibility ?? 0) < 0.25 ||
      (ankle.visibility ?? 0) < 0.25
    ) {
      continue;
    }

    const hx = hip.x * width;
    const hy = hip.y * height;
    const kx = knee.x * width;
    const ky = knee.y * height;
    const ax = ankle.x * width;
    const ay = ankle.y * height;

    // mechanical axis line segment from hip to ankle
    const vax = ax - hx;
    const vay = ay - hy;
    const lenSq = vax * vax + vay * vay;
    if (lenSq < 400) continue;

    // draw dashed hip-to-ankle plumb line
    ctx.beginPath();
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.moveTo(hx, hy);
    ctx.lineTo(ax, ay);
    ctx.stroke();

    // calculate orthogonal projection of knee onto the plumb line
    const t = Math.max(0, Math.min(1, ((kx - hx) * vax + (ky - hy) * vay) / lenSq));
    const px = hx + t * vax;
    const py = hy + t * vay;

    // knee deviation vector
    const devX = kx - px;
    const devY = ky - py;
    const devDist = Math.hypot(devX, devY);

    // plumb line anchor point dot
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.fill();

    // draw deviation vector line and arrow if offset exceeds threshold
    if (devDist > 3) {
      // check if knee collapsed medially toward body center line (valgus)
      const distKneeToCenter = Math.abs(kx - pelvisCenterX);
      const distPlumbToCenter = Math.abs(px - pelvisCenterX);
      const isValgus = distKneeToCenter < distPlumbToCenter;

      const isSubstantial = devDist > height * 0.02;
      const vectorColor = isSubstantial
        ? isValgus
          ? "#ef4444"
          : "#f59e0b"
        : baseColor;

      ctx.beginPath();
      ctx.lineWidth = isSubstantial ? 2.5 : 2;
      ctx.strokeStyle = vectorColor;
      ctx.moveTo(px, py);
      ctx.lineTo(kx, ky);
      ctx.stroke();

      // arrowhead at the knee joint indicating deviation pull
      const angle = Math.atan2(devY, devX);
      const headLen = Math.min(8, Math.max(4, devDist * 0.4));
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(
        kx - headLen * Math.cos(angle - Math.PI / 6),
        ky - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.moveTo(kx, ky);
      ctx.lineTo(
        kx - headLen * Math.cos(angle + Math.PI / 6),
        ky - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.stroke();

      // glowing accent ring at knee if valgus inward collapse is detected
      if (isValgus && isSubstantial) {
        ctx.beginPath();
        ctx.arc(kx, ky, 8, 0, 2 * Math.PI);
        ctx.strokeStyle = vectorColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}
