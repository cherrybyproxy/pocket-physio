import cv2
import numpy as np
import mediapipe as mp
from dataclasses import dataclass
from typing import Literal

mp_pose = mp.solutions.pose
mp_drawing = mp.solutions.drawing_utils
mp_drawing_styles = mp.solutions.drawing_styles

# min per-landmark confidence to trust a frame's angle data
# frames where any key landmark falls below this are skipped
VISIBILITY_THRESHOLD = 0.6

@dataclass
class posestate:
    target_knee_angle: float
    left_knee_angle: float
    right_knee_angle: float
    # Estimated load bearing on injured leg (50% = symmetrical, <50% = offloaded to healthy side, >50% = overloaded)
    weight_dist: float
    # Trunk lean magnitude in degrees relative to vertical
    body_lean: float
    # Direction of trunk lean relative to injury: "injured", "healthy", or "centered"
    lean_direction: str
    # Leg physically closer to the camera, determined by knee z-depth ('left', 'right', 'unknown')
    near_side: str
    # per-leg confidence: False when any key landmark (hip/knee/ankle) falls below VISIBILITY_THRESHOLD
    # when False, knee_angle for that leg is a stale frozen EMA value, do not use for calibration
    left_visible: bool
    right_visible: bool

class poseengine:
    def __init__(self, injured_side: Literal["left", "right"] = "left"):
        # init tracking model
        self.pose = mp_pose.Pose(
            static_image_mode = False,
            min_detection_confidence = 0.5,
            min_tracking_confidence = 0.5
        )
        self.injured_side = injured_side

        # init temporal memory for EMA
        self.prev_l = None
        self.prev_r = None
        self.prev_w = None
        self.prev_lean = None
        # lower alpha = smoother (higher latency)
        # 25% trust in curr frame
        self.alpha = 0.25

    # reset temporal EMA filters when switching states
    def reset_filters(self):
        self.prev_l = None
        self.prev_r = None
        self.prev_w = None
        self.prev_lean = None

    def _landmarks_visible(self, *lms) -> bool:
        # true only if every supplied landmark meets VISIBILITY_THRESHOLD
        return all(lm.visibility >= VISIBILITY_THRESHOLD for lm in lms)

    # 3D Euclidean joint angle from (x, y, z) coords for auto-calibration
    def get_angle_3d(self, a, b, c):
        a, b, c = np.array(a), np.array(b), np.array(c)
        ba = a - b
        bc = c - b
        cosine_angle = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc))
        return float(np.degrees(np.arccos(np.clip(cosine_angle, -1.0, 1.0))))

    # 2D planar angle from (x, y) coords for manual calibration
    def get_angle_2d(self, a, b, c):
        a, b, c = np.array(a[:2]), np.array(b[:2]), np.array(c[:2])
        ba = a - b
        bc = c - b
        cosine_angle = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc))
        return float(np.degrees(np.arccos(np.clip(cosine_angle, -1.0, 1.0))))

    def get_angle(self, a, b, c, is_frontal=False):
        if is_frontal:
            return self.get_angle_3d(a, b, c)
        return self.get_angle_2d(a, b, c)

    # apply EMA filtering
    def apply_ema(self, curr, prev):
        if prev is None:
            return curr
        return (self.alpha * curr) + ((1.0 - self.alpha) * prev) # blended val

    def process_frame(self, frame, is_frontal: bool = None):
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.pose.process(rgb)

        if not results.pose_landmarks:
            return None

        # draw 2d skeleton on screen
        mp_drawing.draw_landmarks(
            frame,
            results.pose_landmarks,
            mp_pose.POSE_CONNECTIONS,
            landmark_drawing_spec = mp_drawing_styles.get_default_pose_landmarks_style()
        )

        # use world landmarks for metric 3d math
        wlms = results.pose_world_landmarks.landmark

        # convenience refs for the six key landmarks
        lm_l_hip = wlms[mp_pose.PoseLandmark.LEFT_HIP.value]
        lm_l_knee = wlms[mp_pose.PoseLandmark.LEFT_KNEE.value]
        lm_l_ankle = wlms[mp_pose.PoseLandmark.LEFT_ANKLE.value]
        lm_r_hip = wlms[mp_pose.PoseLandmark.RIGHT_HIP.value]
        lm_r_knee = wlms[mp_pose.PoseLandmark.RIGHT_KNEE.value]
        lm_r_ankle = wlms[mp_pose.PoseLandmark.RIGHT_ANKLE.value]

        # always extract coords (best estimate regardless of per-landmark confidence)
        l_hip = [lm_l_hip.x, lm_l_hip.y, lm_l_hip.z]
        l_knee = [lm_l_knee.x, lm_l_knee.y, lm_l_knee.z]
        l_ankle = [lm_l_ankle.x, lm_l_ankle.y, lm_l_ankle.z]
        r_hip = [lm_r_hip.x, lm_r_hip.y, lm_r_hip.z]
        r_knee = [lm_r_knee.x, lm_r_knee.y, lm_r_knee.z]
        r_ankle = [lm_r_ankle.x, lm_r_ankle.y, lm_r_ankle.z]

        # determine which leg is closer to the camera using knee z-depth (smaller z = nearer)
        # require > 5cm spread to avoid noise in frontal stance
        knee_z_diff = lm_l_knee.z - lm_r_knee.z  # negative = left is nearer
        if knee_z_diff < -0.05:
            near_side = "left"
        elif knee_z_diff > 0.05:
            near_side = "right"
        else:
            near_side = "unknown"  # roughly frontal

        # auto-detect frontal mode if not explicitly passed
        if is_frontal is None:
            is_frontal = (near_side == "unknown")

        # per-leg visibility gate: each side updates its own EMA independently
        # uses 3D angles when in frontal view for true sagittal flexion, and 2D when side-on
        l_visible = self._landmarks_visible(lm_l_hip, lm_l_knee, lm_l_ankle)
        r_visible = self._landmarks_visible(lm_r_hip, lm_r_knee, lm_r_ankle)
        if l_visible:
            angle_l = self.get_angle(l_hip, l_knee, l_ankle, is_frontal=is_frontal)
            self.prev_l = self.apply_ema(angle_l, self.prev_l)
        if r_visible:
            angle_r = self.get_angle(r_hip, r_knee, r_ankle, is_frontal=is_frontal)
            self.prev_r = self.apply_ema(angle_r, self.prev_r)

        # if neither leg has a trusted reading yet, return nothing
        if self.prev_l is None and self.prev_r is None:
            return None

        target_angle = (self.prev_l or 0.0) if self.injured_side == "left" else (self.prev_r or 0.0)

        # BOS is the lateral dist btwn left & right ankles
        # COM is lateral mid of the shoulders
        l_sh = wlms[mp_pose.PoseLandmark.LEFT_SHOULDER.value]
        r_sh = wlms[mp_pose.PoseLandmark.RIGHT_SHOULDER.value]
        com_x = (l_sh.x + r_sh.x) / 2.0
        bos_width = abs(r_ankle[0] - l_ankle[0])

        healthy_ankle_x = r_ankle[0] if self.injured_side == "left" else l_ankle[0]

        raw_w = 50.0 # default neutral 50/50
        if bos_width > 0.05: # require feet to be separated by at least 5cm laterally
            dist_from_healthy = abs(com_x - healthy_ankle_x)
            raw_w = float(np.clip((dist_from_healthy / bos_width) * 100.0, 0.0, 100.0))

        # blend weight distribution with EMA
        self.prev_w = self.apply_ema(raw_w, self.prev_w)

        mid_sh = np.array([(l_sh.x + r_sh.x) / 2.0, (l_sh.y + r_sh.y) / 2.0])
        mid_hip = np.array([(l_hip[0] + r_hip[0]) / 2.0, (l_hip[1] + r_hip[1]) / 2.0])
        trunk_vec = mid_sh - mid_hip
        vertical = np.array([0.0, -1.0])
        norm = np.linalg.norm(trunk_vec)
        raw_body_lean = float(np.degrees(np.arccos(np.clip(np.dot(trunk_vec, vertical) / norm, -1.0, 1.0)))) if norm > 0 else 0.0

        # determine lean direction relative to injured side
        lateral_shift = trunk_vec[0] # positive = subject's left, negative = subject's right
        if abs(lateral_shift) < 0.015 or raw_body_lean < 2.0:
            lean_direction = "centered"
        else:
            leaning_side = "left" if lateral_shift > 0 else "right"
            lean_direction = "injured" if leaning_side == self.injured_side else "healthy"

        self.prev_lean = self.apply_ema(raw_body_lean, self.prev_lean)

        return posestate(
            target_knee_angle = target_angle,
            left_knee_angle = self.prev_l or 0.0,
            right_knee_angle = self.prev_r or 0.0,
            weight_dist = self.prev_w,
            body_lean = self.prev_lean if self.prev_lean is not None else 0.0,
            lean_direction = lean_direction,
            near_side = near_side,
            left_visible = l_visible,
            right_visible = r_visible
        )