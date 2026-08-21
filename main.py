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
    state = "auto_calibrate"
    timeout_start = None # track failure detection

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

        data = engine.process_frame(frame)
        if not data: continue

        if state == "auto_calibrate":
            # record boundary extremums
            min_l, max_l = min(min_l, data.left_knee_angle), max(max_l, data.left_knee_angle)
            min_r, max_r = min(min_r, data.right_knee_angle), max(max_r, data.right_knee_angle)

            cv2.putText(frame, "flex both legs. press 'c' to lock", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(frame, f"l_rom: {int(max_l - min_l)} | r_rom: {int(max_r - min_r)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        elif state == "tracking":
            # isolate active limb data
            val = data.left_knee_angle if engine.injured_side == "left" else data.right_knee_angle
            limit = min_l if engine.injured_side == "left" else min_r

            # evaluate threshold violation
            color = (0, 0, 255) if val < limit + 5 else (0, 255, 0)
            cv2.putText(frame, f"tracking {engine.injured_side} leg", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
            cv2.putText(frame, f"knee: {int(val)} / max flex limit: {int(limit)}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            cv2.putText(frame, f"load offloaded: {int(data.weight_dist)}%", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)

        cv2.imshow("pocket-physio", frame)
        key = cv2.waitKey(10) & 0xFF
        
        if key == ord('c') and state == "auto_calibrate":
            rom_l = max_l - min_l
            rom_r = max_r - min_r

            # lock restricted limb state
            engine.injured_side = "left" if rom_l < rom_r else "right"
            state = "tracking"

        elif key == ord('q'): break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()