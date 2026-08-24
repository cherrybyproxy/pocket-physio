// port of kinematics.py
// evaluates a pose state against calibrated rom limits and produces
// color-coded medical feedback for the hud overlay.

import type { PoseState } from "./poseEngine";

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
}

export class KinematicsTracker {
  injuredSide: "left" | "right";
  minAngle: number | null;
  maxAngle: number | null;
  rom: number;

  constructor(
    injuredSide: "left" | "right",
    minAngle: number | null = null,
    maxAngle: number | null = null
  ) {
    this.injuredSide = injuredSide;
    this.minAngle = minAngle;
    this.maxAngle = maxAngle;
    this.rom =
      minAngle !== null && maxAngle !== null ? maxAngle - minAngle : 0;
  }

  updateLimits(minAngle: number | null, maxAngle: number | null): void {
    this.minAngle = minAngle;
    this.maxAngle = maxAngle;
    this.rom =
      minAngle !== null && maxAngle !== null ? maxAngle - minAngle : 0;
  }

  // evaluate the current pose against calibrated limits.
  // mirrors kinematics.py evaluate().
  evaluate(data: PoseState): TrackingFeedback {
    // isolate active limb data
    const val =
      this.injuredSide === "left"
        ? data.leftKneeAngle
        : data.rightKneeAngle;

    // evaluate min/max threshold violation
    const isViolated =
      (this.minAngle !== null && val < this.minAngle) ||
      (this.maxAngle !== null && val > this.maxAngle);
    const angleColor = isViolated ? "#ff4444" : "#44ff44";

    // load distribution: % on injured vs % on healthy leg
    const injuredLoad = Math.round(data.weightDist);
    const healthyLoad = 100 - injuredLoad;

    // trunk lean medical evaluation:
    // - red if leaning toward injured side (> 2 deg) -> overloads damaged knee
    // - red if leaning toward healthy side exceeds clinical threshold (> 10 deg) -> lower back strain risk
    // - yellow if acceptable mild offloading compensation (<= 10 deg toward healthy side)
    // - green if upright / centered (<= 2 deg)
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
      minAngle: this.minAngle ?? 0,
      maxAngle: this.maxAngle ?? 0,
      rom: this.rom,
      isViolated,
      angleColor,
      injuredLoad,
      healthyLoad,
      leanDeg,
      leanColor,
      leanText,
    };
  }
}
