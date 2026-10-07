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

function extractFeaturesLocal(grayMat: any, anchor: { x: number; y: number }, width: number, height: number): any {
    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
    const P = new cv.Point(Math.round(anchor.x * width), Math.round(anchor.y * height));

    // initialize Shi-Tomasi features inside a strict knee-centered ROI
    cv.circle(mask, P, 35, new cv.Scalar(255), -1);

    const corners = new cv.Mat();
    cv.goodFeaturesToTrack(grayMat, corners, 50, 0.01, 5, mask);
    mask.delete();

    if (corners.rows > 0) {
        return corners;
    } else {
        corners.delete();
        const fallback = new cv.Mat(1, 1, cv.CV_32FC2);
        fallback.data32F[0] = Math.round(anchor.x * width);
        fallback.data32F[1] = Math.round(anchor.y * height);
        return fallback;
    }
}

const getMedian = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
};

self.onmessage = async (event: MessageEvent<any>) => {
    const message = event.data;

    if (!isOpenCvReady && typeof cv !== "undefined" && cv.Mat) {
        isOpenCvReady = true;
    }

    if (!isOpenCvReady) {
        self.postMessage({
            type: "ERROR",
            message: "opencv.js is not yet initialized",
        } as WorkerErrorResult);
        return;
    }

    switch (message.type) {
        case "INIT_ANCHOR": {
            const { frame, anchors } = message as { frame: ImageBitmap; anchors: SideAnchors };
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
                        state: "TRACKING"
                    };
                    resultPoints[side] = { x: anchor.x, y: anchor.y };
                }

                prevGrayMat = grayMat;

                self.postMessage({
                    type: "TRACKING_UPDATE",
                    points: resultPoints,
                    trackingQuality: 1.0,
                    status: "TRACKING",
                });
            } catch (err: any) {
                console.error("[OpticalFlowWorker] failed to initialize anchor:", err);
                self.postMessage({
                    type: "ERROR",
                    message: err?.message ?? "failed to initialize tracking anchor",
                } as WorkerErrorResult);
            } finally {
                frame.close();
            }
            break;
        }

        case "TRACK_FRAME": {
            const { frame } = message;
            try {
                if (!prevGrayMat || (!trackers.left && !trackers.right)) {
                    self.postMessage({
                        type: "TRACKING_UPDATE",
                        points: {},
                        trackingQuality: 0,
                        status: "LOST",
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

                    // lucas-kanade motion tracking
                    const nextPtsMat = new cv.Mat();
                    const statusMat = new cv.Mat();
                    const errMat = new cv.Mat();

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

                    // appearance-based template matching
                    // IMPORTANT: template matching is evidence only.
                    // It cannot independently move the knee.

                    let templateScore = 0;
                    let templateDisp = 0;

                    if (trk.templateMat) {
                        const searchRadiusPx = 30;
                        const halfPatch = trk.patchSize / 2;

                        // Use the current knee as the center, but keep the search LOCAL.
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

                    if (candidateAccepted) {
                        trk.trustedAnchor = { x: candidatePx / width, y: candidatePy / height };
                        trk.state = "TRACKING";
                        trk.uncertainFrames = 0;
                        finalAnchor = { ...trk.trustedAnchor };

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
                        // DO NOT move trusted anchor

                        if (localLKPoints < minLocalPoints) {
                            // Only redetect local features when the existing local feature count genuinely falls below threshold
                            trk.prevPtsMat.delete();
                            trk.prevPtsMat = extractFeaturesLocal(currGrayMat, trk.trustedAnchor, width, height);
                        } else {
                            // Do not continuously replace the feature set unless there is a genuine feature-loss condition.
                            // The points were rejected for excessive motion, but might be valid. Retain their previous locations.
                            const validPtsMat = new cv.Mat(goodIndices.length, 1, cv.CV_32FC2);
                            for (let idx = 0; idx < goodIndices.length; idx++) {
                                const origIdx = goodIndices[idx];
                                validPtsMat.data32F[idx * 2] = trk.prevPtsMat.data32F[origIdx * 2];
                                validPtsMat.data32F[idx * 2 + 1] = trk.prevPtsMat.data32F[origIdx * 2 + 1];
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
                        totalLKPoints: numPoints,
                        localLKPoints,
                        rejectedFarPoints,
                        templateScore: templateScore.toFixed(2),
                        templateDisplacement: templateDisp.toFixed(1),
                        state: trk.state,
                        rejectionReason: rejectionReason || "NONE"
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

                console.log("[OpticalFlowWorker]", debugLogs);

                // UNCERTAIN should not be counted as successful TRACKING
                let globalStatus = "LOST";
                if (hasTracking) globalStatus = "TRACKING";
                else if (hasUncertain) globalStatus = "UNCERTAIN";

                self.postMessage({
                    type: "TRACKING_UPDATE",
                    points: resultPoints,
                    trackingQuality: hasTracking ? 1.0 : 0.0,
                    status: globalStatus,
                    debug: debugLogs
                });
            } catch (err: any) {
                console.error("[OpticalFlowWorker] tracking failed:", err);
                self.postMessage({
                    type: "ERROR",
                    message: err?.message ?? "optical flow frame tracking failed",
                } as WorkerErrorResult);
            } finally {
                frame.close();
            }
            break;
        }

        case "RESET": {
            resetMemoryState();
            break;
        }
    }
};

loadOpenCV();
