// canvas drawing helpers for pocket physio:
// focuses exclusively on torso, hips, and legs (no face or arm clutter).
// orange on left leg, teal on right leg, white on torso midline.
// clean, crisp aesthetic without neon bloom.

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

interface ConnectionSpec {
  pair: [number, number];
  color: string;
}

// focused lower-body & torso pose connections (face and arms excluded)
const LOWER_BODY_CONNECTIONS: ConnectionSpec[] = [
  // left leg (orange)
  { pair: [23, 25], color: "#ff8c00" },
  { pair: [25, 27], color: "#ff8c00" },
  { pair: [27, 29], color: "#ff8c00" },
  { pair: [27, 31], color: "#ff8c00" },
  { pair: [29, 31], color: "#ff8c00" },

  // right leg (teal)
  { pair: [24, 26], color: "#00e5ff" },
  { pair: [26, 28], color: "#00e5ff" },
  { pair: [28, 30], color: "#00e5ff" },
  { pair: [28, 32], color: "#00e5ff" },
  { pair: [30, 32], color: "#00e5ff" },

  // torso frame (neutral white & side bounds)
  { pair: [11, 12], color: "#ffffff" }, // shoulders
  { pair: [23, 24], color: "#ffffff" }, // hips
  { pair: [11, 23], color: "rgba(255, 140, 0, 0.7)" }, // left trunk
  { pair: [12, 24], color: "rgba(0, 229, 255, 0.7)" }, // right trunk
];

// visible joint landmark indices: shoulders (11,12), hips (23,24), knees (25,26), ankles (27,28), feet (29,30,31,32)
const VISIBLE_JOINTS = new Set([11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
const LEFT_JOINTS = new Set([23, 25, 27, 29, 31]);
const RIGHT_JOINTS = new Set([24, 26, 28, 30, 32]);

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

  // 1. draw clean bone connections
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
    if (aVis < 0.35 || bVis < 0.35) continue;

    ctx.strokeStyle = conn.color;
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    ctx.lineTo(b.x * width, b.y * height);
    ctx.stroke();
  }

  // 2. draw joint dots only for relevant joints
  for (const i of VISIBLE_JOINTS) {
    if (filterSide === "left" && !LEFT_JOINTS.has(i)) continue;
    if (filterSide === "right" && !RIGHT_JOINTS.has(i)) continue;

    const lm = landmarks[i];
    if (!lm) continue;

    const v = lm.visibility ?? 1;
    if (v < 0.35) continue;

    const isKnee = i === 25 || i === 26;
    const isHip = i === 23 || i === 24;
    const isAnkle = i === 27 || i === 28;
    const isKeyJoint = isKnee || isHip || isAnkle;

    const radius = isKeyJoint ? 6 : 4;

    ctx.beginPath();
    ctx.arc(lm.x * width, lm.y * height, radius, 0, 2 * Math.PI);

    if (LEFT_JOINTS.has(i)) {
      // left leg: orange
      ctx.fillStyle = "#ff8c00";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = isKeyJoint ? 2 : 1;
    } else if (RIGHT_JOINTS.has(i)) {
      // right leg: teal
      ctx.fillStyle = "#00e5ff";
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

// draw a line of hud text with subtle shadow for crisp readability
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

  const kneeIdx = injuredSide === "left" ? 25 : 26;
  const hipIdx = injuredSide === "left" ? 23 : 24;
  const ankleIdx = injuredSide === "left" ? 27 : 28;

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

  // background target ROM track arc around knee (darker leg side tone)
  ctx.beginPath();
  ctx.arc(kx, ky, radius, thighAngle - Math.PI * 0.65, thighAngle + Math.PI * 0.65);
  ctx.lineWidth = 5;
  ctx.strokeStyle = injuredSide === "left" ? "rgba(180, 80, 0, 0.35)" : "rgba(0, 140, 160, 0.35)";
  ctx.stroke();

  // calculate active arc fill proportional to joint angle
  const minA = minAngle || 45;
  const maxA = maxAngle || 165;
  const romRange = Math.max(1, maxA - minA);
  const angleRatio = Math.max(0, Math.min(1, (currentAngle - minA) / romRange));
  const activeArcAngle = thighAngle - Math.PI * 0.6 + angleRatio * (Math.PI * 1.2);

  // arc color matching leg side but slightly darker
  let arcColor = injuredSide === "left" ? "#cc6600" : "#008b9b"; // darker orange or darker teal
  if (currentAngle <= minA + 10) {
    arcColor = "#00aa88"; // target flexion reached (darker emerald)
  } else if (currentAngle >= maxA - 10) {
    arcColor = "#1d4ed8"; // target extension reached (darker blue)
  }

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


