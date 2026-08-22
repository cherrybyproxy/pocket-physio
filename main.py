import cv2
from calibration import poseengine
import time

def main():
    cap = cv2.VideoCapture(0)
    # downsample resolution
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    # cap the loop to 95% of the camera's reported FPS to avoid saturating the CPU (prevents freezing)
    # if the camera reports 0 or an unreasonable value, fall back to 30 FPS.
    cam_fps = cap.get(cv2.CAP_PROP_FPS)
    if cam_fps <= 0 or cam_fps > 300:
        cam_fps = 30.0
    TARGET_FPS = cam_fps * 0.95
    FRAME_TIME = 1.0 / TARGET_FPS  # seconds per frame budget

    engine = poseengine()

    min_l, max_l, min_r, max_r = 180.0, 0.0, 180.0, 0.0
    state = "mode_select"
    timeout_start = None # track failure detection
    countdown_start = None
    CALIB_DELAY = 5.0

    cv2.namedWindow("Pocket Physio")
    clicked = False
    
    def on_click(event, x, y, flags, param):
        nonlocal clicked
        if event == cv2.EVENT_LBUTTONDOWN:
            clicked = True

    cv2.setMouseCallback("Pocket Physio", on_click)

    while cap.isOpened():
        loop_start = time.time()
        ret, frame = cap.read()
        if not ret:
            if timeout_start is None:
                timeout_start = time.time()
            elif time.time() - timeout_start > 2.0:
                print("Camera timeout: No feed for 2s. Exiting...")
                break
            print ("Waiting for camera...")
            time.sleep(0.1)
            continue

        timeout_start = None # reset

        data = engine.process_frame(frame) # mediapipe processes unflipped frame

        frame = cv2.flip(frame, 1) # flip frame

        angles_valid = data is not None

        if state == "mode_select":
            cv2.putText(frame, "Press 'a' for auto-calibration or 'm' for manual calibration", (30,40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "auto_calibrate_countdown":
            elapsed = time.time() - countdown_start
            remaining = max(0, int(CALIB_DELAY - elapsed + 1))
            cv2.putText(frame, f"Face camera front/3/4. Calibration begins in {remaining}s", (30,40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)
        
        elif state == "auto_calibrate":
            if angles_valid:
                # record boundary extremums only on trusted frames
                min_l, max_l = min(min_l, data.left_knee_angle), max(max_l, data.left_knee_angle)
                min_r, max_r = min(min_r, data.right_knee_angle), max(max_r, data.right_knee_angle)

            cv2.putText(frame, "Face front/3/4. Move both legs. Click to lock ROMs.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                cv2.putText(frame, f"Left Max: {int(max_l)} | Min: {int(min_l)} | ROM: {int(max_l - min_l)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                cv2.putText(frame, f"Right Max: {int(max_r)} | Min: {int(min_r)} | ROM: {int(max_r - min_r)}", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            else:
                cv2.putText(frame, "Low confidence — hold still, ensure both legs visible", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 100, 255), 2)

        elif state == "manual_min_l":
            cv2.putText(frame, "Face front/3/4. Bend left knee. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                cv2.putText(frame, f"curr l: {int(data.left_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "manual_max_l":
            cv2.putText(frame, "Face front/3/4. Straighten left leg. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                cv2.putText(frame, f"curr l: {int(data.left_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "manual_min_r":
            cv2.putText(frame, "Face front/3/4. Bend right knee. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                cv2.putText(frame, f"curr r: {int(data.right_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "manual_max_r":
            cv2.putText(frame, "Face front/3/4. Straighten right leg. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                cv2.putText(frame, f"curr r: {int(data.right_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        
        elif state == "tracking":
            if angles_valid:
                # isolate active limb data
                val = data.left_knee_angle if engine.injured_side == "left" else data.right_knee_angle
                limit = min_l if engine.injured_side == "left" else min_r
                # evaluate threshold violation
                color = (0, 0, 255) if val < limit + 5 else (0, 255, 0)
                cv2.putText(frame, f"Side-on: tracking {engine.injured_side} leg", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                cv2.putText(frame, f"knee: {int(val)} / max flex limit: {int(limit)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
                cv2.putText(frame, f"load offloaded: {int(data.weight_dist)}%", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
                # flag compensatory trunk lean > 10 deg
                lean_col = (0, 0, 255) if data.body_lean > 10.0 else (255, 255, 0)
                cv2.putText(frame, f"trunk lean: {int(data.body_lean)} deg", (30, 160), cv2.FONT_HERSHEY_SIMPLEX, 0.6, lean_col, 2)
            else:
                cv2.putText(frame, f"Side-on: tracking {engine.injured_side} leg", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                cv2.putText(frame, "Low confidence — ensure leg is clearly visible", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 100, 255), 2)

        cv2.imshow("Pocket Physio", frame)

        # enforce frame budget (sleep the unused portion of the frame interval)
        # caps CPU usage to 95% of the camera's native FPS
        elapsed_loop = time.time() - loop_start
        sleep_time = FRAME_TIME - elapsed_loop
        if sleep_time > 0:
            time.sleep(sleep_time)

        key = cv2.waitKey(1) & 0xFF

        if state == "mode_select":
            if key == ord('a'):
                countdown_start = time.time()
                state = "auto_calibrate_countdown"
            elif key == ord('m'):
                state = "manual_min_l"

        if state == "auto_calibrate_countdown":
            if time.time() - countdown_start >= CALIB_DELAY:
                state = "auto_calibrate"
        
        if clicked:
            if state == "auto_calibrate" and angles_valid:
                rom_l, rom_r = max_l - min_l, max_r - min_r
                # lock restricted limb state
                engine.injured_side = "left" if rom_l < rom_r else "right"
                state = "tracking"
            elif state == "manual_min_l" and angles_valid:
                # lock left flexion
                min_l = data.left_knee_angle
                state = "manual_max_l"
                
            elif state == "manual_max_l" and angles_valid:
                # lock left extension
                max_l = data.left_knee_angle
                state = "manual_min_r"
            elif state == "manual_min_r" and angles_valid:
                # lock right flexion
                min_r = data.right_knee_angle
                state = "manual_max_r"
            elif state == "manual_max_r" and angles_valid:
                # lock right ext calc rom
                max_r = data.right_knee_angle
                rom_l, rom_r = max_l - min_l, max_r - min_r
                engine.injured_side = "left" if rom_l < rom_r else "right"
                state = "tracking"
            clicked = False

        elif key == ord('q'): break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()