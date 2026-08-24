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
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number
): void {
  if (!landmarks || landmarks.length === 0) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3.5;

  // 1. draw clean bone connections without heavy bloom
  for (const conn of LOWER_BODY_CONNECTIONS) {
    const [i, j] = conn.pair;
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

  // 2. draw joint dots only for torso & legs (no face or arm clutter)
  for (const i of VISIBLE_JOINTS) {
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
