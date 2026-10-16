// worker for tracking knee motion using optical flow

declare const cv: any;
declare function importScripts(...urls: string[]): void;

interface SideAnchors {
    left?: { x: number; y: number };
    right?: { x: number; y: number };
}

interface WorkerErrorResult {
    type: "ERROR";
    message: string;
}

let isOpenCvReady = false;
let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

interface SideTracker {
    prevPtsMat: any;
    templateMat: any;
    patchSize: number;
    trustedAnchor: { x: number; y: number };
    uncertainFrames: number;
    state: "TRACKING" | "UNCERTAIN" | "LOST";
    lastDeltaX: number;
    lastDeltaY: number;
}

let prevGrayMat: any = null;
const trackers: { left?: SideTracker; right?: SideTracker } = {};

function loadOpenCV() {
    try {
        console.log("[OpticalFlowWorker] loading opencv.js...");
        importScripts("https://docs.opencv.org/4.8.0/opencv.js");

        if (typeof cv !== "undefined") {
            if (cv.Mat) {
                isOpenCvReady = true;
                console.log("[OpticalFlowWorker] opencv.js initialized");
                self.postMessage({ type: "OPENCV_READY" });
            } else {
                cv.onRuntimeInitialized = () => {
                    isOpenCvReady = true;
                    console.log("[OpticalFlowWorker] opencv.js initialized");
                    self.postMessage({ type: "OPENCV_READY" });
                };
            }
        }
    } catch (err) {
        console.warn("[OpticalFlowWorker] opencv.js failed to load:", err);
    }
}

function bitmapToGrayscaleMat(frame: ImageBitmap): any {
    if (!offscreenCanvas || offscreenCanvas.width !== frame.width || offscreenCanvas.height !== frame.height) {
        offscreenCanvas = new OffscreenCanvas(frame.width, frame.height);
        offscreenCtx = offscreenCanvas.getContext("2d", { willReadFrequently: true });
    }

    if (!offscreenCtx) throw new Error("failed to get 2d context from offscreen canvas");

    offscreenCtx.drawImage(frame, 0, 0);
    const imageData = offscreenCtx.getImageData(0, 0, frame.width, frame.height);
    const srcMat = cv.matFromImageData(imageData);
    const grayMat = new cv.Mat();
    cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY);
    srcMat.delete();
    return grayMat;
}

function resetMemoryState() {
    if (prevGrayMat) {
        prevGrayMat.delete();
        prevGrayMat = null;
    }
    if (trackers.left) {
        if (trackers.left.prevPtsMat) trackers.left.prevPtsMat.delete();
        if (trackers.left.templateMat) trackers.left.templateMat.delete();
        delete trackers.left;
    }
    if (trackers.right) {
        if (trackers.right.prevPtsMat) trackers.right.prevPtsMat.delete();
        if (trackers.right.templateMat) trackers.right.templateMat.delete();
        delete trackers.right;
    }
}

function extractFeaturesLocal(
    grayMat: any,
    anchor: { x: number; y: number },
    width: number,
    height: number
): any {
    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);

    const P = new cv.Point(
        Math.round(anchor.x * width),
        Math.round(anchor.y * height)
    );

    // Strict knee-centered ROI
    cv.circle(
        mask,
        P,
        35,
        new cv.Scalar(255),
        -1
    );

    const corners = new cv.Mat();

    cv.goodFeaturesToTrack(
        grayMat,
        corners,
        50,
        0.01,
        5,
        mask
    );

    mask.delete();

    if (corners.rows > 0) {
        return corners;
    }

    // Return an empty Mat when no points are found so optical-flow functions receive a valid structure.
    corners.delete();

    return new cv.Mat(0, 1, cv.CV_32FC2);
}

const getMedian = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
};

let currentSessionId = 0;

self.onmessage = async (event: MessageEvent<any>) => {
    const message = event.data;

    if (!isOpenCvReady && typeof cv !== "undefined" && cv.Mat) {
        isOpenCvReady = true;
    }

    if (!isOpenCvReady) {
        self.postMessage({
            type: "ERROR",
            message: "opencv.js is not yet initialized",
            sessionId: message?.sessionId ?? currentSessionId,
        } as WorkerErrorResult);
        return;
    }

    switch (message.type) {
        case "INIT_ANCHOR": {
            const { frame, anchors, sessionId } = message as { frame: ImageBitmap; anchors: SideAnchors; sessionId?: number };
            if (typeof sessionId === "number") {
                currentSessionId = sessionId;
            }
            try {
                resetMemoryState();

                const grayMat = bitmapToGrayscaleMat(frame);
                const width = frame.width;
                const height = frame.height;

                const sides: ("left" | "right")[] = [];
                if (anchors?.left) sides.push("left");
                if (anchors?.right) sides.push("right");

                const resultPoints: SideAnchors = {};

                for (const side of sides) {
                    const anchor = anchors[side]!;

                    // extract a visual template patch of the knee region
                    const patchSize = 44;
                    const halfPatch = patchSize / 2;
                    const cropX = Math.max(0, Math.min(width - patchSize, Math.round(anchor.x * width - halfPatch)));
                    const cropY = Math.max(0, Math.min(height - patchSize, Math.round(anchor.y * height - halfPatch)));
                    const rect = new cv.Rect(cropX, cropY, patchSize, patchSize);
                    const templateMat = grayMat.roi(rect).clone();

                    const ptsMat = extractFeaturesLocal(grayMat, anchor, width, height);

                    trackers[side] = {
                        prevPtsMat: ptsMat,
                        templateMat,
                        patchSize,
                        trustedAnchor: { x: anchor.x, y: anchor.y },
                        uncertainFrames: 0,
                        state: "TRACKING",
                        lastDeltaX: 0,
                        lastDeltaY: 0
                    };
                    resultPoints[side] = { x: anchor.x, y: anchor.y };
                }

                prevGrayMat = grayMat;

                self.postMessage({
                    type: "TRACKING_UPDATE",
                    points: resultPoints,
                    trackingQuality: 1.0,
                    status: "TRACKING",
                    sessionId: currentSessionId,
                });
            } catch (err: any) {
                console.error("[OpticalFlowWorker] failed to initialize anchor:", err);
                self.postMessage({
                    type: "ERROR",
                    message: err?.message ?? "failed to initialize tracking anchor",
                    sessionId: currentSessionId,
                } as WorkerErrorResult);
            } finally {
                frame.close();
            }
            break;
        }

        case "TRACK_FRAME": {
            const { frame, sessionId } = message;
            if (typeof sessionId === "number" && sessionId !== currentSessionId) {
                // Obsolete frame from previous session
                frame.close();
                return;
            }
            try {
                if (!prevGrayMat || (!trackers.left && !trackers.right)) {
                    self.postMessage({
                        type: "TRACKING_UPDATE",
                        points: {},
                        trackingQuality: 0,
                        status: "LOST",
                        sessionId: currentSessionId,
                    });
                    return;
                }

                const currGrayMat = bitmapToGrayscaleMat(frame);
                const width = frame.width;
                const height = frame.height;

                const winSize = new cv.Size(31, 31);
                const maxLevel = 3;
                const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 20, 0.03);

                const resultPoints: SideAnchors = {};
                const debugLogs: any = {};

                let hasTracking = false;
                let hasUncertain = false;

                const sides: ("left" | "right")[] = [];
                if (trackers.left) sides.push("left");
                if (trackers.right) sides.push("right");

                for (const side of sides) {
                    const trk = trackers[side]!;

                    const trustedPx = trk.trustedAnchor.x * width;
                    const trustedPy = trk.trustedAnchor.y * height;

                    // calculate bounded predicted search center for recovery
                    let predDeltaX = 0;
                    let predDeltaY = 0;

                    // limit prediction to the first 3 uncertain frames and bound to 25px per-frame movement
                    if (trk.uncertainFrames > 0 && trk.uncertainFrames <= 3) {
                        const mag = Math.hypot(trk.lastDeltaX, trk.lastDeltaY);
                        if (mag > 0) {
                            const step = Math.min(mag, 25);
                            predDeltaX = (trk.lastDeltaX / mag) * step;
                            predDeltaY = (trk.lastDeltaY / mag) * step;
                        }
                    }

                    const predictedPx = Math.max(0, Math.min(width, trustedPx + predDeltaX));
                    const predictedPy = Math.max(0, Math.min(height, trustedPy + predDeltaY));

                    // empty-feature recovery branch
                    if (!trk.prevPtsMat || trk.prevPtsMat.rows === 0) {
                        trk.state = "UNCERTAIN";
                        trk.uncertainFrames++;

                        if (trk.uncertainFrames > 15) {
                            trk.state = "LOST";
                        }

                        if (trk.state === "LOST") {
                            debugLogs[side] = {
                                trustedAnchor: { x: trustedPx, y: trustedPy },
                                candidateAnchor: { x: trustedPx, y: trustedPy },
                                finalAnchor: { x: trustedPx, y: trustedPy },
                                predictedAnchor: { x: predictedPx, y: predictedPy },
                                totalLKPoints: 0,
                                localLKPoints: 0,
                                rejectedFarPoints: 0,
                                templateScore: "0.00",
                                templateDisplacement: "0.0",
                                state: "LOST",
                                rejectionReason: "NO_FEATURES",
                                recoveryAttempted: false,
                                recoveryFeatureCount: 0,
                                recoveryAccepted: false,
                                uncertainFrames: trk.uncertainFrames
                            };

                            if (trk.prevPtsMat) trk.prevPtsMat.delete();
                            if (trk.templateMat) trk.templateMat.delete();
                            delete trackers[side];
                            continue;
                        }

                        // Remain uncertain and hold last trusted anchor
                        resultPoints[side] = trk.trustedAnchor;
                        hasUncertain = true;

                        // attempt local feature redetection around predicted location
                        const recoveryCenter = { x: predictedPx / width, y: predictedPy / height };
                        const newPtsMat = extractFeaturesLocal(currGrayMat, recoveryCenter, width, height);
                        const recoveryFeatureCount = newPtsMat.rows;

                        if (trk.prevPtsMat) trk.prevPtsMat.delete();
                        trk.prevPtsMat = newPtsMat;

                        debugLogs[side] = {
                            trustedAnchor: { x: trustedPx, y: trustedPy },
                            candidateAnchor: { x: trustedPx, y: trustedPy },
                            finalAnchor: { x: trustedPx, y: trustedPy },
                            predictedAnchor: { x: predictedPx, y: predictedPy },
                            totalLKPoints: 0,
                            localLKPoints: 0,
                            rejectedFarPoints: 0,
                            templateScore: "0.00",
                            templateDisplacement: "0.0",
                            state: trk.state,
                            rejectionReason: "NO_FEATURES",
                            recoveryAttempted: true,
                            recoveryFeatureCount,
                            recoveryAccepted: false,
                            uncertainFrames: trk.uncertainFrames
                        };

                        continue;
                    }

                    // lucas-kanade motion tracking mats allocated after zero-feature check
                    const nextPtsMat = new cv.Mat();
                    const statusMat = new cv.Mat();
                    const errMat = new cv.Mat();

                    const wasUncertain = trk.state === "UNCERTAIN" || trk.uncertainFrames > 0;

                    cv.calcOpticalFlowPyrLK(prevGrayMat, currGrayMat, trk.prevPtsMat, nextPtsMat, statusMat, errMat, winSize, maxLevel, criteria);

                    const backPtsMat = new cv.Mat();
                    const backStatusMat = new cv.Mat();
                    const backErrMat = new cv.Mat();

                    cv.calcOpticalFlowPyrLK(currGrayMat, prevGrayMat, nextPtsMat, backPtsMat, backStatusMat, backErrMat, winSize, maxLevel, criteria);

                    const dxs: number[] = [];
                    const dys: number[] = [];
                    const goodIndices: number[] = [];

                    let rejectedFarPoints = 0;
                    let localLKPoints = 0;

                    const numPoints = nextPtsMat.rows;
                    const kneeSearchRadiusPx = 40;

                    for (let i = 0; i < numPoints; i++) {
                        if (statusMat.data[i] !== 1 || backStatusMat.data[i] !== 1) continue;

                        const prevX = trk.prevPtsMat.data32F[i * 2];
                        const prevY = trk.prevPtsMat.data32F[i * 2 + 1];
                        const backX = backPtsMat.data32F[i * 2];
                        const backY = backPtsMat.data32F[i * 2 + 1];

                        if (Math.hypot(backX - prevX, backY - prevY) > 1.5) continue;

                        const distFromKnee = Math.hypot(prevX - trustedPx, prevY - trustedPy);

                        // reject points outside the local knee support radius
                        if (distFromKnee > kneeSearchRadiusPx) {
                            rejectedFarPoints++;
                            continue;
                        }

                        localLKPoints++;

                        const nextX = nextPtsMat.data32F[i * 2];
                        const nextY = nextPtsMat.data32F[i * 2 + 1];

                        dxs.push(nextX - prevX);
                        dys.push(nextY - prevY);
                        goodIndices.push(i);
                    }

                    backPtsMat.delete();
                    backStatusMat.delete();
                    backErrMat.delete();

                    let lkDeltaX = 0;
                    let lkDeltaY = 0;
                    if (goodIndices.length > 0) {
                        lkDeltaX = getMedian(dxs);
                        lkDeltaY = getMedian(dys);
                    }

                    const candidatePx = trustedPx + lkDeltaX;
                    const candidatePy = trustedPy + lkDeltaY;

                    // Template matching is evidence only; it cannot independently move the knee.

                    let templateScore = 0;
                    let templateDisp = 0;

                    if (trk.templateMat) {
                        const searchRadiusPx = 30;
                        const halfPatch = trk.patchSize / 2;

                        // Use the current knee as the center, but keep the search local.
                        const centerX = trk.trustedAnchor.x * width;
                        const centerY = trk.trustedAnchor.y * height;

                        const searchSize = trk.patchSize + searchRadiusPx * 2;

                        const searchX = Math.max(0, Math.min(width - searchSize, Math.round(centerX - halfPatch - searchRadiusPx)));
                        const searchY = Math.max(0, Math.min(height - searchSize, Math.round(centerY - halfPatch - searchRadiusPx)));

                        if (searchSize <= width && searchSize <= height) {
                            const searchRect = new cv.Rect(searchX, searchY, searchSize, searchSize);
                            const searchMat = currGrayMat.roi(searchRect);
                            const resMat = new cv.Mat();

                            cv.matchTemplate(searchMat, trk.templateMat, resMat, cv.TM_CCOEFF_NORMED);
                            const mm = cv.minMaxLoc(resMat);

                            templateScore = mm.maxVal;

                            const candidateX = searchX + mm.maxLoc.x + halfPatch;
                            const candidateY = searchY + mm.maxLoc.y + halfPatch;

                            templateDisp = Math.hypot(candidateX - centerX, candidateY - centerY);

                            searchMat.delete();
                            resMat.delete();
                        }
                    }

                    let rejectionReason: string | null = null;
                    const maxKneeStepPx = 25;
                    const minLocalPoints = 4;
                    const movement = Math.hypot(lkDeltaX, lkDeltaY);

                    let candidateAccepted = false;

                    // Do not require template matching for LK tracking.
                    if (localLKPoints < minLocalPoints) {
                        rejectionReason = "NO_LOCAL_LK_POINTS";
                    } else if (movement > maxKneeStepPx) {
                        rejectionReason = "EXCESSIVE_MOTION";
                    } else {
                        candidateAccepted = true;
                    }

                    let finalAnchor = { ...trk.trustedAnchor };
                    let recoveryAttempted = false;
                    let recoveryFeatureCount = 0;
                    let recoveryAccepted = false;

                    if (candidateAccepted) {
                        trk.trustedAnchor = { x: candidatePx / width, y: candidatePy / height };
                        trk.state = "TRACKING";
                        trk.uncertainFrames = 0;
                        trk.lastDeltaX = lkDeltaX;
                        trk.lastDeltaY = lkDeltaY;
                        finalAnchor = { ...trk.trustedAnchor };

                        if (wasUncertain) {
                            recoveryAccepted = true;
                        }

                        const validPtsMat = new cv.Mat(goodIndices.length, 1, cv.CV_32FC2);
                        for (let idx = 0; idx < goodIndices.length; idx++) {
                            const origIdx = goodIndices[idx];
                            validPtsMat.data32F[idx * 2] = nextPtsMat.data32F[origIdx * 2];
                            validPtsMat.data32F[idx * 2 + 1] = nextPtsMat.data32F[origIdx * 2 + 1];
                        }
                        trk.prevPtsMat.delete();
                        trk.prevPtsMat = validPtsMat;
                    } else {
                        trk.state = "UNCERTAIN";
                        trk.uncertainFrames++;
                        // Keep trusted anchor stationary when motion is rejected

                        if (localLKPoints < minLocalPoints) {
                            // Only redetect local features when the existing local feature count genuinely falls below threshold
                            recoveryAttempted = true;
                            const recoveryCenter = { x: predictedPx / width, y: predictedPy / height };
                            const newPtsMat = extractFeaturesLocal(currGrayMat, recoveryCenter, width, height);
                            recoveryFeatureCount = newPtsMat.rows;
                            trk.prevPtsMat.delete();
                            trk.prevPtsMat = newPtsMat;
                        } else {
                            // Do not continuously replace the feature set unless there is a genuine feature-loss condition.
                            // The points were rejected for excessive motion, but might be valid. Retain their previous locations.
                            const validPtsMat = new cv.Mat(goodIndices.length, 1, cv.CV_32FC2);
                            for (let idx = 0; idx < goodIndices.length; idx++) {
                                const origIdx = goodIndices[idx];
                                validPtsMat.data32F[idx * 2] = nextPtsMat.data32F[origIdx * 2];
                                validPtsMat.data32F[idx * 2 + 1] = nextPtsMat.data32F[origIdx * 2 + 1];
                            }
                            trk.prevPtsMat.delete();
                            trk.prevPtsMat = validPtsMat;
                        }

                        if (trk.uncertainFrames > 15) {
                            trk.state = "LOST";
                        }
                    }

                    if (trk.state !== "LOST") {
                        // The UI receives the trusted anchor. It can visually style it based on status if needed.
                        resultPoints[side] = trk.trustedAnchor;
                    }

                    if (trk.state === "TRACKING") hasTracking = true;
                    if (trk.state === "UNCERTAIN") hasUncertain = true;

                    debugLogs[side] = {
                        trustedAnchor: { x: trustedPx, y: trustedPy },
                        candidateAnchor: { x: candidatePx, y: candidatePy },
                        finalAnchor: { x: finalAnchor.x * width, y: finalAnchor.y * height },
                        predictedAnchor: { x: predictedPx, y: predictedPy },
                        totalLKPoints: numPoints,
                        localLKPoints,
                        rejectedFarPoints,
                        templateScore: templateScore.toFixed(2),
                        templateDisplacement: templateDisp.toFixed(1),
                        state: trk.state,
                        rejectionReason: rejectionReason || "NONE",
                        recoveryAttempted,
                        recoveryFeatureCount,
                        recoveryAccepted,
                        uncertainFrames: trk.uncertainFrames
                    };

                    if (trk.state === "LOST") {
                        trk.prevPtsMat.delete();
                        if (trk.templateMat) trk.templateMat.delete();
                        delete trackers[side];
                    }

                    nextPtsMat.delete();
                    statusMat.delete();
                    errMat.delete();
                }

                prevGrayMat.delete();
                prevGrayMat = currGrayMat;

                // An uncertain state should not be counted as active tracking
                let globalStatus = "LOST";
                if (hasTracking) globalStatus = "TRACKING";
                else if (hasUncertain) globalStatus = "UNCERTAIN";

                self.postMessage({
                    type: "TRACKING_UPDATE",
                    points: resultPoints,
                    trackingQuality: hasTracking ? 1.0 : 0.0,
                    status: globalStatus,
                    sessionId: currentSessionId,
                    debug: debugLogs
                });
            } catch (err: any) {
                console.error("[OpticalFlowWorker] tracking failed:", err);
                self.postMessage({
                    type: "ERROR",
                    message: err?.message ?? "optical flow frame tracking failed",
                    sessionId: currentSessionId,
                } as WorkerErrorResult);
            } finally {
                frame.close();
            }
            break;
        }

        case "RESET": {
            const { sessionId } = message;
            if (typeof sessionId === "number") {
                currentSessionId = sessionId;
            } else {
                currentSessionId++;
            }
            resetMemoryState();
            break;
        }
    }
};

loadOpenCV();
