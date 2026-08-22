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
    weight_dist: float
    body_lean: float
    # leg physically closer to the camera, determined by knee z-depth
    # 'left', 'right', or 'unknown' when both knees are roughly equidistant (frontal stance)
    near_side: str

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
        # lower alpha = smoother (higher latency)
        # 25% trust in curr frame
        self.alpha = 0.25

    def _landmarks_visible(self, *lms) -> bool:
        # true only if every supplied landmark meets VISIBILITY_THRESHOLD
        return all(lm.visibility >= VISIBILITY_THRESHOLD for lm in lms)

    
    def get_angle(self, a, b, c):
        # 2d planar angle (x, y)
        a, b, c = np.array(a[:2]), np.array(b[:2]), np.array(c[:2])
        ba = a - b
        bc = c - b
        cosine_angle = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc))
        return np.degrees(np.arccos(np.clip(cosine_angle, -1.0, 1.0)))

    # apply EMA filtering
    def apply_ema(self, curr, prev):
        if prev is None:
            return curr
        return (self.alpha * curr) + ((1.0 - self.alpha) * prev) # blended val

    def process_frame(self, frame):
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

        # per-leg visibility gate: each side updates its own EMA independently
        # (eg. low-confidence right ankle won’t block the left-leg display)
        if self._landmarks_visible(lm_l_hip, lm_l_knee, lm_l_ankle):
            self.prev_l = self.apply_ema(self.get_angle(l_hip, l_knee, l_ankle), self.prev_l)
        if self._landmarks_visible(lm_r_hip, lm_r_knee, lm_r_ankle):
            self.prev_r = self.apply_ema(self.get_angle(r_hip, r_knee, r_ankle), self.prev_r)

        # if neither leg has a trusted reading yet, return nothing
        if self.prev_l is None and self.prev_r is None:
            return None

        target_angle = (self.prev_l or 0.0) if self.injured_side == "left" else (self.prev_r or 0.0)

        # calculate center of mass
        l_sh_x = wlms[mp_pose.PoseLandmark.LEFT_SHOULDER.value].x
        r_sh_x = wlms[mp_pose.PoseLandmark.RIGHT_SHOULDER.value].x
        com_x = (l_sh_x + r_sh_x) / 2.0
        bos_width = abs(r_ankle[0] - l_ankle[0])

        # calculate load distribution & smooth it
        anchor_ankle = l_ankle[0] if self.injured_side == "left" else r_ankle[0]
        raw_w = 50.0
        if bos_width > 0:
            raw_w = abs(com_x - anchor_ankle) / bos_width * 100.0

        # blend weight dist
        self.prev_w = self.apply_ema(raw_w, self.prev_w)

        # determine which leg is closer to the camera using knee z-depth (smaller z = nearer)
        # require > 5cm spread to avoid noise in frontal stance
        knee_z_diff = lm_l_knee.z - lm_r_knee.z  # negative = left is nearer
        if knee_z_diff < -0.05:
            near_side = "left"
        elif knee_z_diff > 0.05:
            near_side = "right"
        else:
            near_side = "unknown"  # roughly frontal

        return posestate(
            target_knee_angle = target_angle,
            left_knee_angle = self.prev_l or 0.0,
            right_knee_angle = self.prev_r or 0.0,
            weight_dist = self.prev_w,
            body_lean = 0.0,
            near_side = near_side
        )