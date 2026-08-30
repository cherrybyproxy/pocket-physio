// port of kinematics.py
// evaluates a pose state against calibrated rom limits and produces
// color-coded medical feedback, repetition counting, tempo tracking, and isometric hold detection.

import type { PoseState } from "./poseEngine";

export type MovementPhase = "flexing" | "extending" | "holding" | "idle";

export interface TrackingFeedback {
  currentAngle: number;
  minAngle: number;
  maxAngle: number;
  rom: number;
  isViolated: boolean;
  // css color string for the knee angle readout
  angleColor: string;
  injuredLoad: number;
  healthyLoad: number;
  leanDeg: number;
  // css color string for the trunk lean readout
  leanColor: string;
  leanText: string;

  // repetition & tempo metrics
  repCount: number;
  movementPhase: MovementPhase;
  angularVelocity: number; // degrees per second (+ extending, - flexing)
  
  // isometric hold metrics
  isHolding: boolean;
  holdTime: number; // current hold duration in seconds
  targetHoldDuration: number; // 3.0s goal
  holdCompleted: boolean;
  totalHoldTime: number; // cumulative hold time across session
}

export class KinematicsTracker {
  injuredSide: "left" | "right";
  minAngle: number | null;
  maxAngle: number | null;
  rom: number;

  // repetition counter state
  repCount: number = 0;
  private repState: "extended" | "flexing" | "flexed" | "extending" = "extended";

  // tempo & hold state
  private lastAngle: number | null = null;
  private lastTimestampMs: number | null = null;
  private currentVelocity: number = 0;

  private holdStartTimestampMs: number | null = null;
  private currentHoldTime: number = 0;
  public totalHoldTime: number = 0;
  private holdCompletedThisRep: boolean = false;
  readonly targetHoldDuration: number = 1.0; // 1 second hold goal per rep

  constructor(
    injuredSide: "left" | "right",
    minAngle: number | null = null,
    maxAngle: number | null = null
  ) {
    this.injuredSide = injuredSide;
    this.minAngle = minAngle;
    this.maxAngle = maxAngle;
    this.rom =
      minAngle !== null && maxAngle !== null ? Math.max(0, maxAngle - minAngle) : 0;
  }

  updateLimits(minAngle: number | null, maxAngle: number | null): void {
    this.minAngle = minAngle;
    this.maxAngle = maxAngle;
    this.rom =
      minAngle !== null && maxAngle !== null ? Math.max(0, maxAngle - minAngle) : 0;
    this.resetRepStats();
  }

  resetRepStats(): void {
    this.repCount = 0;
    this.repState = "extended";
    this.lastAngle = null;
    this.lastTimestampMs = null;
    this.currentVelocity = 0;
    this.holdStartTimestampMs = null;
    this.currentHoldTime = 0;
    this.totalHoldTime = 0;
    this.holdCompletedThisRep = false;
  }

  // evaluate the current pose against calibrated limits & calculate tempo / reps.
  evaluate(data: PoseState, timestampMs: number = performance.now()): TrackingFeedback {
    // isolate active limb data
    const val =
      this.injuredSide === "left"
        ? data.leftKneeAngle
        : data.rightKneeAngle;

    const minA = this.minAngle ?? 45;
    const maxA = this.maxAngle ?? 160;
    const currentRom = Math.max(10, maxA - minA);

    // target zones (within 15% or 12 degrees of calibrated boundaries)
    const flexThreshold = minA + Math.min(15, currentRom * 0.2);
    const extThreshold = maxA - Math.min(15, currentRom * 0.2);

    const isInFlexionTarget = val <= flexThreshold;
    const isInExtensionTarget = val >= extThreshold;

    // evaluate min/max threshold violation
    const isViolated =
      (this.minAngle !== null && val < this.minAngle) ||
      (this.maxAngle !== null && val > this.maxAngle);
    const angleColor = isViolated ? "#ff4444" : "#44ff44";

    // 1. calculate angular velocity (°/sec)
    if (this.lastAngle !== null && this.lastTimestampMs !== null) {
      const dt = (timestampMs - this.lastTimestampMs) / 1000;
      if (dt > 0.005 && dt < 1.0) {
        const rawVel = (val - this.lastAngle) / dt;
        // EMA smooth velocity
        this.currentVelocity = 0.3 * rawVel + 0.7 * this.currentVelocity;
      }
    }
    this.lastAngle = val;
    this.lastTimestampMs = timestampMs;

    // 2. isometric hold detection at target flexion
    let isHolding = false;
    if (isInFlexionTarget && Math.abs(this.currentVelocity) < 25) {
      isHolding = true;
      if (this.holdStartTimestampMs === null) {
        this.holdStartTimestampMs = timestampMs;
      }
      const newHoldTime = (timestampMs - this.holdStartTimestampMs) / 1000;
      const dtHold = newHoldTime - this.currentHoldTime;
      if (dtHold > 0 && dtHold < 1.0) {
        this.totalHoldTime += dtHold;
      }
      this.currentHoldTime = newHoldTime;

      if (this.currentHoldTime >= this.targetHoldDuration) {
        this.holdCompletedThisRep = true;
      }
    } else {
      this.holdStartTimestampMs = null;
      this.currentHoldTime = 0;
    }

    // 3. repetition counter state machine
    if (this.repState === "extended" && isInFlexionTarget) {
      this.repState = "flexed";
    } else if (this.repState === "flexed" && isInExtensionTarget) {
      this.repState = "extended";
      this.repCount += 1;
      this.holdCompletedThisRep = false;
    }

    // determine movement phase text
    let movementPhase: MovementPhase = "idle";
    if (isHolding) {
      movementPhase = "holding";
    } else if (this.currentVelocity < -15) {
      movementPhase = "flexing";
    } else if (this.currentVelocity > 15) {
      movementPhase = "extending";
    }

    // load distribution: % on injured vs % on healthy leg
    const injuredLoad = Math.round(data.weightDist);
    const healthyLoad = 100 - injuredLoad;

    // trunk lean medical evaluation
    const leanDeg = Math.round(data.bodyLean);
    let leanColor: string;
    let leanText: string;

    if (data.leanDirection === "injured" && leanDeg >= 2) {
      leanColor = "#ff4444";
      leanText = `trunk lean: ${leanDeg}° toward injured (alert: overload)`;
    } else if (data.leanDirection === "healthy") {
      if (leanDeg > 10) {
        leanColor = "#ff4444";
        leanText = `trunk lean: ${leanDeg}° toward healthy (>10° back strain risk!)`;
      } else {
        leanColor = "#ffdd44";
        leanText = `trunk lean: ${leanDeg}° toward healthy (mild offload)`;
      }
    } else {
      leanColor = "#44ff44";
      leanText = `trunk lean: ${leanDeg}° (centered/upright)`;
    }

    return {
      currentAngle: val,
      minAngle: minA,
      maxAngle: maxA,
      rom: this.rom,
      isViolated,
      angleColor,
      injuredLoad,
      healthyLoad,
      leanDeg,
      leanColor,
      leanText,

      repCount: this.repCount,
      movementPhase,
      angularVelocity: Math.round(this.currentVelocity),
      isHolding,
      holdTime: Math.min(this.targetHoldDuration, Number(this.currentHoldTime.toFixed(1))),
      targetHoldDuration: this.targetHoldDuration,
      holdCompleted: this.holdCompletedThisRep,
      totalHoldTime: Number(this.totalHoldTime.toFixed(1)),
    };
  }
}

