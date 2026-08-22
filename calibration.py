import cv2
import numpy as np
import mediapipe as mp
from dataclasses import dataclass
from typing import Literal

mp_pose = mp.solutions.pose
mp_drawing = mp.solutions.drawing_utils
mp_drawing_styles = mp.solutions.drawing_styles

@dataclass
class posestate:
    target_knee_angle: float
    left_knee_angle: float
    right_knee_angle: float
    weight_dist: float
    body_lean: float

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

    
    def get_angle(self, a, b, c):
        # compute planar joint angle
        a, b, c = np.array(a), np.array(b), np.array(c)
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

        l_hip = [wlms[mp_pose.PoseLandmark.LEFT_HIP.value].x, wlms[mp_pose.PoseLandmark.LEFT_HIP.value].y, wlms[mp_pose.PoseLandmark.LEFT_HIP.value].z]
        l_knee = [wlms[mp_pose.PoseLandmark.LEFT_KNEE.value].x, wlms[mp_pose.PoseLandmark.LEFT_KNEE.value].y, wlms[mp_pose.PoseLandmark.LEFT_KNEE.value].z]
        l_ankle = [wlms[mp_pose.PoseLandmark.LEFT_ANKLE.value].x, wlms[mp_pose.PoseLandmark.LEFT_ANKLE.value].y, wlms[mp_pose.PoseLandmark.LEFT_ANKLE.value].z]

        r_hip = [wlms[mp_pose.PoseLandmark.RIGHT_HIP.value].x, wlms[mp_pose.PoseLandmark.RIGHT_HIP.value].y, wlms[mp_pose.PoseLandmark.RIGHT_HIP.value].z]
        r_knee = [wlms[mp_pose.PoseLandmark.RIGHT_KNEE.value].x, wlms[mp_pose.PoseLandmark.RIGHT_KNEE.value].y, wlms[mp_pose.PoseLandmark.RIGHT_KNEE.value].z]
        r_ankle = [wlms[mp_pose.PoseLandmark.RIGHT_ANKLE.value].x, wlms[mp_pose.PoseLandmark.RIGHT_ANKLE.value].y, wlms[mp_pose.PoseLandmark.RIGHT_ANKLE.value].z]
        
        # calculate instantaneous bilateral angles
        raw_l = self.get_angle(l_hip, l_knee, l_ankle)
        raw_r = self.get_angle(r_hip, r_knee, r_ankle)
        
        self.prev_l = self.apply_ema(raw_l, self.prev_l)
        self.prev_r = self.apply_ema(raw_r, self.prev_r)

        target_angle = self.prev_l if self.injured_side == "left" else self.prev_r

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

        return posestate(
            target_knee_angle = target_angle,
            left_knee_angle = self.prev_l,
            right_knee_angle = self.prev_r,
            weight_dist = self.prev_w,
            body_lean = 0.0
        )