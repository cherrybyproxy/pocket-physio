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
  flexRepCount: number; // completed knee bends
  extRepCount: number; // completed leg straightenings
  movementPhase: MovementPhase;
  angularVelocity: number; // degrees per second (+ extending, - flexing)

  // isometric hold metrics
  isHolding: boolean;
  holdTime: number; // current hold duration in seconds
  targetHoldDuration: number; // 1.0s goal
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
  flexRepCount: number = 0;
  extRepCount: number = 0;
  private flexLocked: boolean = false;
  private extLocked: boolean = false;

  // tempo & hold state
  private lastAngle: number | null = null;
  private lastTimestampMs: number | null = null;
  private currentVelocity: number = 0;

  private holdStartTimestampMs: number | null = null;
  private currentHoldTime: number = 0;
  public totalHoldTime: number = 0;
  private holdCompletedThisRep: boolean = false;
  public targetHoldDuration: number = 1.0; // default 1 second hold goal per rep
  public allowedMovement: "both" | "flexion" | "extension" = "both";

  setTargetHoldDuration(durationSeconds: number): void {
    const rounded = Math.round(durationSeconds * 10) / 10;
    this.targetHoldDuration = Math.max(0.1, Math.min(30.0, rounded));
  }

  resetPlannedStats(): void {
    this.flexRepCount = 0;
    this.extRepCount = 0;
    this.repCount = 0;
    this.flexLocked = false;
    this.extLocked = false;
    this.holdStartTimestampMs = null;
    this.currentHoldTime = 0;
  }

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
    this.flexRepCount = 0;
    this.extRepCount = 0;
    this.flexLocked = false;
    this.extLocked = false;
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

    const minA = this.minAngle ?? 0;
    const maxA = this.maxAngle ?? 120;
    const romRange = Math.max(10, maxA - minA);
    const romMidpoint = minA + romRange * 0.5;

    // target zones (within 5 degrees of calibrated boundaries, or going above and beyond)
    const flexThreshold = maxA - 5;
    const extThreshold = minA + 5;

    const isInFlexionTarget = val >= flexThreshold;
    const isInExtensionTarget = val <= extThreshold;

    // unlock reps when returning past 50% ROM midpoint
    if (val <= romMidpoint) {
      this.flexLocked = false; // knee straightened past midpoint -> unlocks next flexion rep
    }
    if (val >= romMidpoint) {
      this.extLocked = false; // knee flexed past midpoint -> unlocks next extension rep
    }

    // evaluate min/max threshold violation
    const isViolated =
      (this.minAngle !== null && val < this.minAngle) ||
      (this.maxAngle !== null && val > this.maxAngle);
    const angleColor = isViolated ? "#d21404" : "#028a0f";

    // 1. calculate angular velocity (°/sec) (+ flexing, - extending)
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

    // isometric hold detection at target flexion or extension
    let isHolding = false;
    if (isInFlexionTarget || isInExtensionTarget) {
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

        // Count rep upon hold completion if movement allowed and not locked
        if (
          isInFlexionTarget &&
          (this.allowedMovement === "both" || this.allowedMovement === "flexion") &&
          !this.flexLocked
        ) {
          this.flexRepCount += 1;
          this.flexLocked = true;
        } else if (
          isInExtensionTarget &&
          (this.allowedMovement === "both" || this.allowedMovement === "extension") &&
          !this.extLocked
        ) {
          this.extRepCount += 1;
          this.repCount += 1;
          this.extLocked = true;
        }
      }
    } else {
      this.holdStartTimestampMs = null;
      this.currentHoldTime = 0;
    }

    // determine movement phase text
    let movementPhase: MovementPhase = "idle";
    if (isHolding) {
      movementPhase = "holding";
    } else if (this.currentVelocity > 15) {
      movementPhase = "flexing";
    } else if (this.currentVelocity < -15) {
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
      leanColor = "#d21404";
      leanText = `trunk lean: ${leanDeg}° toward injured (alert: overload)`;
    } else if (data.leanDirection === "healthy") {
      if (leanDeg > 10) {
        leanColor = "#d21404";
        leanText = `trunk lean: ${leanDeg}° toward healthy (>10° back strain risk!)`;
      } else {
        leanColor = "#ffdd44";
        leanText = `trunk lean: ${leanDeg}° toward healthy (mild offload)`;
      }
    } else {
      leanColor = "#028a0f";
      leanText = `trunk lean: ${leanDeg}° (centered/upright)`;
    }

    return {
      currentAngle: val ?? 0,
      minAngle: minA ?? 0,
      maxAngle: maxA ?? 0,
      rom: this.rom ?? 0,
      isViolated,
      angleColor,
      injuredLoad: injuredLoad ?? 0,
      healthyLoad: healthyLoad ?? 0,
      leanDeg: leanDeg ?? 0,
      leanColor,
      leanText,

      repCount: this.repCount ?? 0,
      flexRepCount: this.flexRepCount ?? 0,
      extRepCount: this.extRepCount ?? 0,
      movementPhase,
      angularVelocity: Math.round(this.currentVelocity ?? 0),
      isHolding,
      holdTime: Math.min(this.targetHoldDuration, Number((this.currentHoldTime ?? 0).toFixed(1))),
      targetHoldDuration: this.targetHoldDuration,
      holdCompleted: this.holdCompletedThisRep,
      totalHoldTime: Number((this.totalHoldTime ?? 0).toFixed(1)),
    };
  }
}

