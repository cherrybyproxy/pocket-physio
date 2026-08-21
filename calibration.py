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
    
    def get_angle(self, a, b, c):
        # compute planar joint angle
        a, b, c = np.array(a), np.array(b), np.array(c)
        radians = np.arctan2(c[1] - b[1], c[0] - b[0]) - np.arctan2(a[1] - b[1], a[0] - b[0])
        angle = np.abs(radians * 180.0 / np.pi)
        return 360.0 - angle if angle > 180.0 else angle

    def process_frame(self, frame):
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.pose.process(rgb)

        if not results.pose_landmarks:
            return None

        mp_drawing.draw_landmarks(
            frame,
            results.pose_landmarks,
            mp_pose.POSE_CONNECTIONS,
            landmark_drawing_spec = mp_drawing_styles.get_default_pose_landmarks_style()
        )

        lms = results.pose_landmarks.landmark

        # map spatial coordinates
        l_hip = [lms[mp_pose.PoseLandmark.LEFT_HIP.value].x, lms[mp_pose.PoseLandmark.LEFT_HIP.value].y]
        l_knee = [lms[mp_pose.PoseLandmark.LEFT_KNEE.value].x, lms[mp_pose.PoseLandmark.LEFT_KNEE.value].y]
        l_ankle = [lms[mp_pose.PoseLandmark.LEFT_ANKLE.value].x, lms[mp_pose.PoseLandmark.LEFT_ANKLE.value].y]

        r_hip = [lms[mp_pose.PoseLandmark.RIGHT_HIP.value].x, lms[mp_pose.PoseLandmark.RIGHT_HIP.value].y]
        r_knee = [lms[mp_pose.PoseLandmark.RIGHT_KNEE.value].x, lms[mp_pose.PoseLandmark.RIGHT_KNEE.value].y]
        r_ankle = [lms[mp_pose.PoseLandmark.RIGHT_ANKLE.value].x, lms[mp_pose.PoseLandmark.RIGHT_ANKLE.value].y]
        
        # calculate bilateral angles
        l_angle = self.get_angle(l_hip, l_knee, l_ankle)
        r_angle = self.get_angle(r_hip, r_knee, r_ankle)
        target_angle = l_angle if self.injured_side == "left" else r_angle

        # calculate center of mass
        com_x = (lms[mp_pose.PoseLandmark.LEFT_SHOULDER.value].x + lms[mp_pose.PoseLandmark.RIGHT_SHOULDER.value].x) / 2.0
        bos_width = abs(r_ankle[0] - l_ankle[0])

        # calculate load distribution
        anchor_ankle = l_ankle[0] if self.injured_side == "left" else r_ankle[0]
        weight_dist = 50.0
        if bos_width > 0:
            weight_dist = abs(com_x - anchor_ankle) / bos_width * 100.0

        return posestate(
            target_knee_angle = target_angle,
            left_knee_angle = l_angle,
            right_knee_angle = r_angle,
            weight_dist = weight_dist,
            body_lean = 0.0
        )