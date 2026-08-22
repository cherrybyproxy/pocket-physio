import cv2
from calibration import poseengine
import time

def main():
    cap = cv2.VideoCapture(0)
    # downsample resolution
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    engine = poseengine()

    min_l, max_l, min_r, max_r = 180.0, 0.0, 180.0, 0.0
    state = "alignment"
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

        data = engine.process_frame(frame) # mediapipipe prcoesses unflipped frame

        frame = cv2.flip(frame, 1) # flip frame

        if not data: continue

        if state == "alignment":
            cv2.putText(frame, "Centre your body in the frame. Click the screen to start calibration.", (30,40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "mode_select":
            cv2.putText(frame, "Press 'a' for auto-calibration or 'm' for manual calibration", (30,40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "auto_calibrate_countdown":
            elapsed = time.time() - countdown_start
            remaining = max(0, int(CALIB_DELAY - elapsed + 1))
            cv2.putText(frame, f"Step into an appropriate position. Calibration will begin in {remaining}s", (30,40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)
        
        elif state == "auto_calibrate":
            # record boundary extremums
            min_l, max_l = min(min_l, data.left_knee_angle), max(max_l, data.left_knee_angle)
            min_r, max_r = min(min_r, data.right_knee_angle), max(max_r, data.right_knee_angle)

            cv2.putText(frame, "Move both legs. Click screen to lock the ROMs.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"Left Max Angle: {int(max_l)} | Left Min Angle: {int(min_l)} | Left ROM: {int(max_l - min_l)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"Right Max Angle: {int(max_r)} | Right Min Angle: {int(min_r)} | Right ROM: {int(max_r - min_r)}", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "manual_min_l":
            cv2.putText(frame, "bend left knee. click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"curr l: {int(data.left_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "manual_max_l":
            cv2.putText(frame, "straighten left leg. click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"curr l: {int(data.left_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "manual_min_r":
            cv2.putText(frame, "bend right knee. click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"curr r: {int(data.right_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "manual_max_r":
            cv2.putText(frame, "straighten right leg. click to lock.", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"curr r: {int(data.right_knee_angle)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        
        elif state == "tracking":
            # isolate active limb data
            val = data.left_knee_angle if engine.injured_side == "left" else data.right_knee_angle
            limit = min_l if engine.injured_side == "left" else min_r
            # evaluate threshold violation
            color = (0, 0, 255) if val < limit + 5 else (0, 255, 0)
            cv2.putText(frame, f"tracking {engine.injured_side} leg", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
            cv2.putText(frame, f"knee: {int(val)} / max flex limit: {int(limit)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            cv2.putText(frame, f"load offloaded: {int(data.weight_dist)}%", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
            # flag compensatory trunk lean > 10 deg
            lean_col = (0, 0, 255) if data.body_lean > 10.0 else (255, 255, 0)
            cv2.putText(frame, f"trunk lean: {int(data.body_lean)} deg", (30, 160), cv2.FONT_HERSHEY_SIMPLEX, 0.6, lean_col, 2)

        cv2.imshow("Pocket Physio", frame)
        key = cv2.waitKey(10) & 0xFF

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
            if state == "alignment":
                state = "mode_select"
            elif state == "auto_calibrate":
                rom_l, rom_r = max_l - min_l, max_r - min_r
                # lock restricted limb state
                engine.injured_side = "left" if rom_l < rom_r else "right"
                state = "tracking"
            elif state == "manual_min_l":
                # lock left flexion
                min_l = data.left_knee_angle
                state = "manual_max_l"
                
            elif state == "manual_max_l":
                # lock left extension
                max_l = data.left_knee_angle
                state = "manual_min_r"
            elif state == "manual_min_r":
                # lock right flexion
                min_r = data.right_knee_angle
                state = "manual_max_r"
            elif state == "manual_max_r":
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