import cv2
from dataclasses import dataclass
from typing import Tuple, Optional
from calibration import posestate

@dataclass
class TrackingFeedback:
    current_angle: float
    min_angle: float
    max_angle: float
    rom: float
    is_violated: bool
    angle_color: Tuple[int, int, int]
    injured_load: int
    healthy_load: int
    lean_deg: int
    lean_color: Tuple[int, int, int]
    lean_text: str

class KinematicsTracker:
    def __init__(self, injured_side: str, min_angle: Optional[float] = None, max_angle: Optional[float] = None):
        self.injured_side = injured_side
        self.min_angle = min_angle
        self.max_angle = max_angle
        self.rom = (max_angle - min_angle) if (max_angle is not None and min_angle is not None) else 0.0

    def update_limits(self, min_angle: Optional[float], max_angle: Optional[float]):
        self.min_angle = min_angle
        self.max_angle = max_angle
        self.rom = (max_angle - min_angle) if (max_angle is not None and min_angle is not None) else 0.0

    def evaluate(self, data: posestate) -> TrackingFeedback:
        # isolate active limb data
        val = data.left_knee_angle if self.injured_side == "left" else data.right_knee_angle

        # evaluate min/max threshold violation
        is_violated = (self.min_angle is not None and val < self.min_angle) or \
                      (self.max_angle is not None and val > self.max_angle)
        angle_color = (0, 0, 255) if is_violated else (0, 255, 0)

        # load distribution: % on injured vs % on healthy leg
        injured_load = int(data.weight_dist)
        healthy_load = 100 - injured_load

        # trunk lean medical evaluation
        # - red if leaning toward injured side (> 2 deg) -> overloads damaged knee
        # - red if leaning toward healthy side exceeds clinical threshold (> 10 deg) -> lower back strain risk
        # - yellow if acceptable mild offloading compensation (<= 10 deg toward healthy side)
        # - green if upright / centered (<= 2 deg)
        lean_deg = int(data.body_lean)
        if data.lean_direction == "injured" and lean_deg >= 2:
            lean_color = (0, 0, 255) # RED
            lean_text = f"trunk lean: {lean_deg} deg toward INJURED (Alert: overload)"
        elif data.lean_direction == "healthy":
            if lean_deg > 10:
                lean_color = (0, 0, 255) # RED (exceeds medical threshold)
                lean_text = f"trunk lean: {lean_deg} deg toward healthy (>10 deg back strain risk!)"
            else:
                lean_color = (0, 255, 255) # YELLOW (mild compensation)
                lean_text = f"trunk lean: {lean_deg} deg toward healthy (mild offload)"
        else:
            lean_color = (0, 255, 0) # GREEN (centered)
            lean_text = f"trunk lean: {lean_deg} deg (centered/upright)"

        return TrackingFeedback(
            current_angle=val,
            min_angle=self.min_angle or 0.0,
            max_angle=self.max_angle or 0.0,
            rom=self.rom,
            is_violated=is_violated,
            angle_color=angle_color,
            injured_load=injured_load,
            healthy_load=healthy_load,
            lean_deg=lean_deg,
            lean_color=lean_color,
            lean_text=lean_text
        )

    def render_hud(self, frame, data, angles_valid: bool):
        # render tracking HUD on the camera frame
        cv2.putText(frame, f"Tracking {self.injured_side} leg...", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        # check per-leg visibility for the injured side specifically
        inj_visible = (data.left_visible if self.injured_side == "left" else data.right_visible) if (angles_valid and data is not None) else False

        if angles_valid and data is not None and inj_visible:
            feedback = self.evaluate(data)
            cv2.putText(frame, f"curr: {int(feedback.current_angle)} | max: {int(feedback.max_angle)} | min: {int(feedback.min_angle)} | rom: {int(feedback.rom)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, feedback.angle_color, 2)
            cv2.putText(frame, f"load: {feedback.injured_load}% on injured | {feedback.healthy_load}% on healthy", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
            cv2.putText(frame, feedback.lean_text, (30, 160), cv2.FONT_HERSHEY_SIMPLEX, 0.6, feedback.lean_color, 2)
        elif angles_valid and data is not None and not inj_visible:
            cv2.putText(frame, "Injured leg out of frame. Ensure ankle is visible.", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 100, 255), 2)
        else:
            cv2.putText(frame, "Low confidence. Ensure leg is clearly visible.", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 100, 255), 2)
