// Web Worker for Dual Optical Flow & Appearance-Based Template Matching via OpenCV.js WebAssembly

declare const cv: any;
declare function importScripts(...urls: string[]): void;

interface SideAnchors {
    left?: { x: number; y: number };
    right?: { x: number; y: number };
}

interface SideLimbs {
    left?: { x: number; y: number }[];
    right?: { x: number; y: number }[];
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
    currentAnchor: { x: number; y: number };
}

let prevGrayMat: any = null;
const trackers: { left?: SideTracker; right?: SideTracker } = {};

function loadOpenCV() {
    try {
        console.log("[OpticalFlowWorker] Loading OpenCV.js WebAssembly...");
        importScripts("https://docs.opencv.org/4.8.0/opencv.js");

        if (typeof cv !== "undefined") {
            if (cv.Mat) {
                isOpenCvReady = true;
                console.log("[OpticalFlowWorker] OpenCV.js WASM loaded & initialized!");
                self.postMessage({ type: "OPENCV_READY" });
            } else {
                cv.onRuntimeInitialized = () => {
                    isOpenCvReady = true;
                    console.log("[OpticalFlowWorker] OpenCV.js onRuntimeInitialized fired!");
                    self.postMessage({ type: "OPENCV_READY" });
                };
            }
        }
    } catch (err) {
        console.warn("[OpticalFlowWorker] OpenCV.js script loading failed:", err);
    }
}

function bitmapToGrayscaleMat(frame: ImageBitmap): any {
    if (!offscreenCanvas || offscreenCanvas.width !== frame.width || offscreenCanvas.height !== frame.height) {
        offscreenCanvas = new OffscreenCanvas(frame.width, frame.height);
        offscreenCtx = offscreenCanvas.getContext("2d", { willReadFrequently: true });
    }

    if (!offscreenCtx) throw new Error("Failed to get 2d context from OffscreenCanvas");

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

self.onmessage = async (event: MessageEvent<any>) => {
    const message = event.data;

    if (!isOpenCvReady && typeof cv !== "undefined" && cv.Mat) {
        isOpenCvReady = true;
    }

    if (!isOpenCvReady) {
        self.postMessage({
            type: "ERROR",
            message: "OpenCV.js WebAssembly runtime is not yet initialized.",
        } as WorkerErrorResult);
        return;
    }

    switch (message.type) {
        case "INIT_ANCHOR": {
            const { frame, anchors, limbs } = message as { frame: ImageBitmap; anchors: SideAnchors; limbs?: SideLimbs };
            try {
                resetMemoryState();

                const grayMat = bitmapToGrayscaleMat(frame);
                const width = frame.width;
                const height = frame.height;

                const P = (p: { x: number; y: number }) =>
                    new cv.Point(Math.round(p.x * width), Math.round(p.y * height));

                const sides: ("left" | "right")[] = [];
                if (anchors?.left) sides.push("left");
                if (anchors?.right) sides.push("right");

                const resultPoints: SideAnchors = {};

                for (const side of sides) {
                    const anchor = anchors[side]!;
                    const limb = limbs?.[side];

                    // extract visual appearance template patch of knee ROI (44x44 px)
                    const patchSize = 44;
                    const halfPatch = patchSize / 2;
                    const cropX = Math.max(0, Math.min(width - patchSize, Math.round(anchor.x * width - halfPatch)));
                    const cropY = Math.max(0, Math.min(height - patchSize, Math.round(anchor.y * height - halfPatch)));
                    const rect = new cv.Rect(cropX, cropY, patchSize, patchSize);
                    const templateMat = grayMat.roi(rect).clone();

                    // Extract Shi-Tomasi features with a priority on the KNEE, not the whole shin.
                    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
                    const pts = limb && limb.length > 0 ? limb : [anchor];

                    // Draw thin supporting line along the limb for background context
                    for (let i = 0; i < pts.length - 1; i++) {
                        if (pts[i] && pts[i + 1]) {
                            cv.line(mask, P(pts[i]), P(pts[i + 1]), new cv.Scalar(255), 10);
                        }
                    }
                    // Draw a strong 30px radius around the knee to guarantee knee features dominate
                    cv.circle(mask, P(anchor), 30, new cv.Scalar(255), -1);

                    const corners = new cv.Mat();
                    cv.goodFeaturesToTrack(grayMat, corners, 50, 0.01, 5, mask);
                    mask.delete();

                    let ptsMat: any;
                    if (corners.rows > 0) {
                        ptsMat = corners;
                    } else {
                        corners.delete();
                        ptsMat = new cv.Mat(1, 1, cv.CV_32FC2);
                        ptsMat.data32F[0] = Math.round(anchor.x * width);
                        ptsMat.data32F[1] = Math.round(anchor.y * height);
                    }

                    trackers[side] = {
                        prevPtsMat: ptsMat,
                        templateMat,
                        patchSize,
                        currentAnchor: { x: anchor.x, y: anchor.y },
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
                console.error("[OpticalFlowWorker] Failed to initialize anchor:", err);
                self.postMessage({
                    type: "ERROR",
                    message: err?.message ?? "Failed to initialize SLAM anchor",
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
                const criteria = new cv.TermCriteria(
                    cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT,
                    20,
                    0.03
                );

                const resultPoints: SideAnchors = {};
                const debugLogs: any = {};
                let totalQuality = 0;
                let activeCount = 0;

                const sides: ("left" | "right")[] = [];
                if (trackers.left) sides.push("left");
                if (trackers.right) sides.push("right");

                for (const side of sides) {
                    const trk = trackers[side]!;

                    const prevAnchorPx = trk.currentAnchor.x * width;
                    const prevAnchorPy = trk.currentAnchor.y * height;

                    // 1. Lucas-Kanade motion tracking
                    const nextPtsMat = new cv.Mat();
                    const statusMat = new cv.Mat();
                    const errMat = new cv.Mat();

                    cv.calcOpticalFlowPyrLK(
                        prevGrayMat,
                        currGrayMat,
                        trk.prevPtsMat,
                        nextPtsMat,
                        statusMat,
                        errMat,
                        winSize,
                        maxLevel,
                        criteria
                    );

                    const backPtsMat = new cv.Mat();
                    const backStatusMat = new cv.Mat();
                    const backErrMat = new cv.Mat();

                    cv.calcOpticalFlowPyrLK(
                        currGrayMat,
                        prevGrayMat,
                        nextPtsMat,
                        backPtsMat,
                        backStatusMat,
                        backErrMat,
                        winSize,
                        maxLevel,
                        criteria
                    );

                    const dxs: number[] = [];
                    const dys: number[] = [];
                    const weights: number[] = [];
                    const goodIndices: number[] = [];
                    
                    let nearKneePts = 0;
                    let farPts = 0;

                    const numPoints = nextPtsMat.rows;
                    const distanceScale = 40; // Pixels

                    for (let i = 0; i < numPoints; i++) {
                        if (statusMat.data[i] !== 1 || backStatusMat.data[i] !== 1) continue;

                        const prevX = trk.prevPtsMat.data32F[i * 2];
                        const prevY = trk.prevPtsMat.data32F[i * 2 + 1];
                        const backX = backPtsMat.data32F[i * 2];
                        const backY = backPtsMat.data32F[i * 2 + 1];

                        if (Math.hypot(backX - prevX, backY - prevY) > 1.5) continue;

                        const nextX = nextPtsMat.data32F[i * 2];
                        const nextY = nextPtsMat.data32F[i * 2 + 1];

                        const distFromKnee = Math.hypot(prevX - prevAnchorPx, prevY - prevAnchorPy);
                        // Points closer to the knee anchor have MUCH higher weight
                        const weight = 1 / (1 + distFromKnee / distanceScale);

                        if (distFromKnee < 40) nearKneePts++; else farPts++;

                        dxs.push(nextX - prevX);
                        dys.push(nextY - prevY);
                        weights.push(weight);
                        goodIndices.push(i);
                    }

                    backPtsMat.delete();
                    backStatusMat.delete();
                    backErrMat.delete();

                    // Calculate robust weighted local motion
                    let lkDeltaX = 0;
                    let lkDeltaY = 0;
                    if (goodIndices.length > 0) {
                        let sumW = 0, sumDX = 0, sumDY = 0;
                        for (let i = 0; i < dxs.length; i++) {
                            sumW += weights[i];
                            sumDX += dxs[i] * weights[i];
                            sumDY += dys[i] * weights[i];
                        }
                        lkDeltaX = sumDX / sumW;
                        lkDeltaY = sumDY / sumW;

                        // Cap maximum frame-to-frame displacement
                        const moveDist = Math.hypot(lkDeltaX, lkDeltaY);
                        if (moveDist > 25) {
                            lkDeltaX = (lkDeltaX / moveDist) * 25;
                            lkDeltaY = (lkDeltaY / moveDist) * 25;
                        }
                    }

                    const lkPredX = prevAnchorPx + lkDeltaX;
                    const lkPredY = prevAnchorPy + lkDeltaY;

                    // 2. Appearance-based template matching centered on LK prediction
                    let templateMatchPos: { x: number; y: number } | null = null;
                    let templateScore = 0;
                    let templateDisp = 0;

                    if (trk.templateMat) {
                        const searchSize = 80; // Constrained search window
                        const halfSearch = searchSize / 2;
                        const halfPatch = trk.patchSize / 2;

                        const searchX = Math.max(0, Math.min(width - searchSize, Math.round(lkPredX - halfSearch)));
                        const searchY = Math.max(0, Math.min(height - searchSize, Math.round(lkPredY - halfSearch)));
                        const searchRect = new cv.Rect(searchX, searchY, searchSize, searchSize);
                        const searchMat = currGrayMat.roi(searchRect);

                        const resMat = new cv.Mat();
                        cv.matchTemplate(searchMat, trk.templateMat, resMat, cv.TM_CCOEFF_NORMED);
                        const mm = cv.minMaxLoc(resMat);

                        templateScore = mm.maxVal;
                        
                        // Accept template only if strong score AND physically near the LK prediction
                        if (templateScore >= 0.55) {
                            const matchCenterPx = searchX + mm.maxLoc.x + halfPatch;
                            const matchCenterPy = searchY + mm.maxLoc.y + halfPatch;
                            templateDisp = Math.hypot(matchCenterPx - lkPredX, matchCenterPy - lkPredY);
                            
                            if (templateDisp < 20) {
                                templateMatchPos = {
                                    x: matchCenterPx / width,
                                    y: matchCenterPy / height,
                                };
                            }
                        }

                        searchMat.delete();
                        resMat.delete();
                    }

                    // 3. Fusion
                    let updatedAnchor: { x: number; y: number } | null = null;

                    if (templateMatchPos) {
                        updatedAnchor = templateMatchPos;
                    } else if (goodIndices.length >= 4) {
                        updatedAnchor = {
                            x: Math.max(0, Math.min(1, lkPredX / width)),
                            y: Math.max(0, Math.min(1, lkPredY / height)),
                        };
                    }

                    const finalDisp = updatedAnchor ? Math.hypot(updatedAnchor.x * width - prevAnchorPx, updatedAnchor.y * height - prevAnchorPy) : 0;

                    debugLogs[side] = {
                        lkPoints: numPoints,
                        fbValidPoints: goodIndices.length,
                        nearKneePts,
                        farPts,
                        localDx: lkDeltaX.toFixed(1),
                        localDy: lkDeltaY.toFixed(1),
                        templateScore: templateScore.toFixed(2),
                        templateDisp: templateDisp.toFixed(1),
                        finalDisp: finalDisp.toFixed(1)
                    };

                    if (updatedAnchor) {
                        trk.currentAnchor = updatedAnchor;

                        if (goodIndices.length > 0) {
                            const validPtsMat = new cv.Mat(goodIndices.length, 1, cv.CV_32FC2);
                            for (let idx = 0; idx < goodIndices.length; idx++) {
                                const origIdx = goodIndices[idx];
                                validPtsMat.data32F[idx * 2] = nextPtsMat.data32F[origIdx * 2];
                                validPtsMat.data32F[idx * 2 + 1] = nextPtsMat.data32F[origIdx * 2 + 1];
                            }
                            trk.prevPtsMat.delete();
                            trk.prevPtsMat = validPtsMat;
                        }

                        resultPoints[side] = trk.currentAnchor;
                        totalQuality += Math.max(templateScore, numPoints > 0 ? goodIndices.length / numPoints : 0);
                        activeCount++;
                    } else {
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

                if (activeCount > 0) {
                    self.postMessage({
                        type: "TRACKING_UPDATE",
                        points: resultPoints,
                        trackingQuality: totalQuality / activeCount,
                        status: "TRACKING",
                        debug: debugLogs
                    });
                } else {
                    self.postMessage({
                        type: "TRACKING_UPDATE",
                        points: {},
                        trackingQuality: 0,
                        status: "LOST",
                        debug: debugLogs
                    });
                }
            } catch (err: any) {
                console.error("[OpticalFlowWorker] Optical flow tracking failed:", err);
                self.postMessage({
                    type: "ERROR",
                    message: err?.message ?? "Optical flow frame tracking failed",
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
