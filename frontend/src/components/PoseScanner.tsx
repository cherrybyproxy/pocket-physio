import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

const VISIBILITY_THRESHOLD = 0.6;

export interface FallbackTriggerEvent {
    triggered: boolean;
    joint: string;
    sidesToTrack?: ("left" | "right")[];
    confidence: number;
    imageBitmap?: ImageBitmap;
}

const JOINT_NAMES: Record<number, string> = {
    23: "left hip",
    24: "right hip",
    25: "left knee",
    26: "right knee",
    27: "left ankle",
    28: "right ankle",
};

export async function checkConfidenceAndTriggerFallback(
    landmarks: NormalizedLandmark[],
    targetJointIndex: number | number[],
    videoElement: HTMLVideoElement,
): Promise<FallbackTriggerEvent> {
    const indices = Array.isArray(targetJointIndex) ? targetJointIndex : [targetJointIndex];
    const defaultJointName = indices.map((i) => JOINT_NAMES[i] ?? `joint ${i}`).join(" & ");

    // 1. Guard against uninitialized video element
    if (!videoElement || videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        return { triggered: false, joint: defaultJointName, confidence: 0 };
    }

    // 2. Guard against missing landmarks array (no pose detected in frame)
    if (!landmarks || landmarks.length === 0) {
        return { triggered: true, joint: "both legs", sidesToTrack: ["left", "right"], confidence: 0 };
    }

    const LEFT_LEG_JOINTS = new Set([23, 25, 27]);
    const RIGHT_LEG_JOINTS = new Set([24, 26, 28]);

    let lowestLeftConf = 1.0;
    let lowestRightConf = 1.0;
    let hasLeftFailure = false;
    let hasRightFailure = false;

    // evaluate confidence across all target joints
    for (const idx of indices) {
        const targetLm = landmarks[idx] as (NormalizedLandmark & { presence?: number }) | undefined;
        if (!targetLm) {
            if (LEFT_LEG_JOINTS.has(idx)) {
                hasLeftFailure = true;
                lowestLeftConf = 0;
            }
            if (RIGHT_LEG_JOINTS.has(idx)) {
                hasRightFailure = true;
                lowestRightConf = 0;
            }
            continue;
        }

        const visibility = targetLm.visibility !== undefined ? targetLm.visibility : 1.0;
        const presence = targetLm.presence !== undefined ? targetLm.presence : visibility;
        const confidence = Math.min(visibility, presence);

        if (LEFT_LEG_JOINTS.has(idx)) {
            lowestLeftConf = Math.min(lowestLeftConf, confidence);
            if (confidence < VISIBILITY_THRESHOLD) hasLeftFailure = true;
        }
        if (RIGHT_LEG_JOINTS.has(idx)) {
            lowestRightConf = Math.min(lowestRightConf, confidence);
            if (confidence < VISIBILITY_THRESHOLD) hasRightFailure = true;
        }
    }

    const lowestConfidence = Math.min(lowestLeftConf, lowestRightConf);

    // 3. Trigger fallback if any target joint drops below threshold (0.6)
    if (hasLeftFailure || hasRightFailure) {
        const sidesToTrack: ("left" | "right")[] = [];
        if (hasLeftFailure) sidesToTrack.push("left");
        if (hasRightFailure) sidesToTrack.push("right");

        const activeSide =
            hasLeftFailure && hasRightFailure
                ? "both legs"
                : hasLeftFailure
                    ? "left leg"
                    : "right leg";

        try {
            // create zero-copy transferable frame from video DOM element
            const imageBitmap = await createImageBitmap(videoElement, {
                resizeWidth: 640,
                resizeHeight: 360,
            });

            return {
                triggered: true,
                joint: activeSide,
                sidesToTrack,
                confidence: lowestConfidence,
                imageBitmap,
            };
        } catch (err) {
            console.warn("[PoseScanner] Failed to create ImageBitmap:", err);
            return {
                triggered: true,
                joint: activeSide,
                sidesToTrack,
                confidence: lowestConfidence,
            };
        }
    }

    return {
        triggered: false,
        joint: defaultJointName,
        confidence: lowestConfidence,
    };
}