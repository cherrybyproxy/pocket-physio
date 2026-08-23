import cv2
from calibration import poseengine
from kinematics import KinematicsTracker
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
    tracker = KinematicsTracker(injured_side="left")

    min_l = max_l = min_r = max_r = None  # None until first valid read per side
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

        # frontal 3D angle calculation for auto-calibration; use 2D planar angle for side-on manual calibration and tracking
        is_frontal = state.startswith("auto_calibrate") or state == "mode_select"
        data = engine.process_frame(frame, is_frontal=is_frontal)

        frame = cv2.flip(frame, 1) # flip frame

        angles_valid = data is not None

        if state == "mode_select":
            cv2.putText(frame, "Press 'a' for auto-calibration (frontal) or 'm' for manual (side-on)", (30,40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "auto_calibrate_countdown":
            elapsed = time.time() - countdown_start
            remaining = max(0, int(CALIB_DELAY - elapsed + 1))
            cv2.putText(frame, f"Face camera frontal. Calibration begins in {remaining}s", (30,40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)
        
        elif state == "auto_calibrate":
            if angles_valid:
                # first valid read for each leg seeds both min and max (subsequent reads expand the bounds)
                l = data.left_knee_angle
                r = data.right_knee_angle
                if l > 10:
                    min_l = l if min_l is None else min(min_l, l)
                    max_l = l if max_l is None else max(max_l, l)
                if r > 10:
                    min_r = r if min_r is None else min(min_r, r)
                    max_r = r if max_r is None else max(max_r, r)

            cv2.putText(frame, "Face frontal. Move both legs through ROM. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            l_str = f"Max: {int(max_l)} | Min: {int(min_l)} | ROM: {int(max_l - min_l)}" if min_l is not None else "waiting..."
            r_str = f"Max: {int(max_r)} | Min: {int(min_r)} | ROM: {int(max_r - min_r)}" if min_r is not None else "waiting..."
            cv2.putText(frame, f"Left  {l_str}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"Right {r_str}", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if not angles_valid:
                cv2.putText(frame, "Low confidence — hold still, ensure both legs visible", (30, 155), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 100, 255), 1)

        elif state == "manual_min_l":
            cv2.putText(frame, "Face LEFT side toward camera. Bend left knee. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                oriented = data.near_side in ("left", "unknown")
                if oriented:
                    cv2.putText(frame, f"curr l: {int(data.left_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                else:
                    cv2.putText(frame, "Turn so left side faces camera", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)

        elif state == "manual_max_l":
            cv2.putText(frame, "Face LEFT side toward camera. Straighten left leg. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                oriented = data.near_side in ("left", "unknown")
                if oriented:
                    cv2.putText(frame, f"curr l: {int(data.left_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                else:
                    cv2.putText(frame, "Turn so left side faces camera", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)

        elif state == "manual_min_r":
            cv2.putText(frame, "Face RIGHT side toward camera. Bend right knee. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                oriented = data.near_side in ("right", "unknown")
                if oriented:
                    cv2.putText(frame, f"curr r: {int(data.right_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                else:
                    cv2.putText(frame, "Turn so right side faces camera", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)

        elif state == "manual_max_r":
            cv2.putText(frame, "Face RIGHT side toward camera. Straighten right leg. Click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            if angles_valid:
                oriented = data.near_side in ("right", "unknown")
                if oriented:
                    cv2.putText(frame, f"curr r: {int(data.right_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                else:
                    cv2.putText(frame, "Turn so right side faces camera", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)
        
        elif state == "tracking":
            # Post-calibration kinematics tracking handled in kinematics.py
            tracker.render_hud(frame, data, angles_valid)

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
                min_l = max_l = min_r = max_r = None
                engine.reset_filters()
                state = "auto_calibrate_countdown"
            elif key == ord('m'):
                min_l = max_l = min_r = max_r = None
                engine.reset_filters()
                state = "manual_min_l"

        if state == "auto_calibrate_countdown":
            if time.time() - countdown_start >= CALIB_DELAY:
                state = "auto_calibrate"
        
        if clicked:
            if state == "auto_calibrate" and angles_valid and None not in (min_l, max_l, min_r, max_r):
                rom_l, rom_r = max_l - min_l, max_r - min_r
                engine.injured_side = "left" if rom_l < rom_r else "right"
                engine.reset_filters()
                
                inj_min = min_l if engine.injured_side == "left" else min_r
                inj_max = max_l if engine.injured_side == "left" else max_r
                tracker.injured_side = engine.injured_side
                tracker.update_limits(inj_min, inj_max)
                state = "tracking"

            elif state == "manual_min_l" and angles_valid and data.near_side in ("left", "unknown"):
                min_l = data.left_knee_angle
                state = "manual_max_l"
            elif state == "manual_max_l" and angles_valid and data.near_side in ("left", "unknown"):
                max_l = data.left_knee_angle
                state = "manual_min_r"
            elif state == "manual_min_r" and angles_valid and data.near_side in ("right", "unknown"):
                min_r = data.right_knee_angle
                state = "manual_max_r"
            elif state == "manual_max_r" and angles_valid and data.near_side in ("right", "unknown"):
                max_r = data.right_knee_angle
                rom_l, rom_r = max_l - min_l, max_r - min_r
                engine.injured_side = "left" if rom_l < rom_r else "right"
                engine.reset_filters()
                
                inj_min = min_l if engine.injured_side == "left" else min_r
                inj_max = max_l if engine.injured_side == "left" else max_r
                tracker.injured_side = engine.injured_side
                tracker.update_limits(inj_min, inj_max)
                state = "tracking"

            clicked = False

        elif key == ord('q'): break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()