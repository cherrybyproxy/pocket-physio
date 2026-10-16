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

    // Guard against uninitialized video element
    if (!videoElement || videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        return { triggered: false, joint: defaultJointName, confidence: 0 };
    }

    // Guard against missing landmarks array (no pose detected in frame)
    if (!landmarks || landmarks.length === 0) {
        return { triggered: true, joint: "both legs", sidesToTrack: ["left", "right"], confidence: 0 };
    }

    const LEFT_KNEE = 25;
    const RIGHT_KNEE = 26;
    const LEFT_HIP = 23;
    const RIGHT_HIP = 24;

    let lowestLeftConf = 1.0;
    let lowestRightConf = 1.0;
    let hasLeftFailure = false;
    let hasRightFailure = false;

    // evaluate confidence: optical-flow fallback is reserved for knee occlusion/loss
    for (const idx of indices) {
        const targetLm = landmarks[idx] as (NormalizedLandmark & { presence?: number }) | undefined;
        if (!targetLm) {
            if (idx === LEFT_KNEE || idx === LEFT_HIP) {
                hasLeftFailure = true;
                lowestLeftConf = 0;
            }
            if (idx === RIGHT_KNEE || idx === RIGHT_HIP) {
                hasRightFailure = true;
                lowestRightConf = 0;
            }
            continue;
        }

        const visibility = targetLm.visibility !== undefined ? targetLm.visibility : 1.0;
        const presence = targetLm.presence !== undefined ? targetLm.presence : visibility;
        const confidence = Math.min(visibility, presence);

        if (idx === LEFT_KNEE) {
            lowestLeftConf = Math.min(lowestLeftConf, confidence);
            if (confidence < VISIBILITY_THRESHOLD) hasLeftFailure = true;
        } else if (idx === LEFT_HIP) {
            lowestLeftConf = Math.min(lowestLeftConf, confidence);
            if (confidence < 0.3) hasLeftFailure = true;
        }

        if (idx === RIGHT_KNEE) {
            lowestRightConf = Math.min(lowestRightConf, confidence);
            if (confidence < VISIBILITY_THRESHOLD) hasRightFailure = true;
        } else if (idx === RIGHT_HIP) {
            lowestRightConf = Math.min(lowestRightConf, confidence);
            if (confidence < 0.3) hasRightFailure = true;
        }
    }

    const lowestConfidence = Math.min(lowestLeftConf, lowestRightConf);

    // Trigger fallback if any target joint drops below threshold (0.6)
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
            // create zero-copy transferable frame from video DOM element preserving natural aspect ratio
            const resizeWidth = 640;
            const resizeHeight = videoElement.videoWidth > 0
                ? Math.round((videoElement.videoHeight / videoElement.videoWidth) * resizeWidth)
                : 360;

            const imageBitmap = await createImageBitmap(videoElement, {
                resizeWidth,
                resizeHeight,
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