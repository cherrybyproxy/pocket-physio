// Web Worker for Dual Optical Flow Tracking via OpenCV.js WebAssembly

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
        delete trackers.left;
    }
    if (trackers.right) {
        if (trackers.right.prevPtsMat) trackers.right.prevPtsMat.delete();
        delete trackers.right;
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

                    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
                    const pts = limb && limb.length > 0 ? limb : [anchor];

                    for (let i = 0; i < pts.length - 1; i++) {
                        if (pts[i] && pts[i + 1]) {
                            cv.line(mask, P(pts[i]), P(pts[i + 1]), new cv.Scalar(255), 40);
                        }
                    }
                    cv.circle(mask, P(anchor), 25, new cv.Scalar(255), -1);

                    const corners = new cv.Mat();
                    cv.goodFeaturesToTrack(grayMat, corners, 40, 0.002, 4, mask);
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
                let totalQuality = 0;
                let activeCount = 0;

                const sides: ("left" | "right")[] = [];
                if (trackers.left) sides.push("left");
                if (trackers.right) sides.push("right");

                for (const side of sides) {
                    const trk = trackers[side]!;
                    const nextPtsMat = new cv.Mat();
                    const statusMat = new cv.Mat();
                    const errMat = new cv.Mat();

                    // Forward LK
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

                    // Backward LK
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
                    const goodIndices: number[] = [];

                    const numPoints = nextPtsMat.rows;
                    for (let i = 0; i < numPoints; i++) {
                        if (statusMat.data[i] !== 1 || backStatusMat.data[i] !== 1) continue;

                        const prevX = trk.prevPtsMat.data32F[i * 2];
                        const prevY = trk.prevPtsMat.data32F[i * 2 + 1];
                        const backX = backPtsMat.data32F[i * 2];
                        const backY = backPtsMat.data32F[i * 2 + 1];

                        if (Math.hypot(backX - prevX, backY - prevY) > 1.5) continue;

                        const nextX = nextPtsMat.data32F[i * 2];
                        const nextY = nextPtsMat.data32F[i * 2 + 1];

                        dxs.push(nextX - prevX);
                        dys.push(nextY - prevY);
                        goodIndices.push(i);
                    }

                    backPtsMat.delete();
                    backStatusMat.delete();
                    backErrMat.delete();

                    if (goodIndices.length >= 5) {
                        const medianDeltaX = getMedian(dxs) / width;
                        const medianDeltaY = getMedian(dys) / height;

                        trk.currentAnchor = {
                            x: Math.max(0, Math.min(1, trk.currentAnchor.x + medianDeltaX)),
                            y: Math.max(0, Math.min(1, trk.currentAnchor.y + medianDeltaY)),
                        };

                        const validPtsMat = new cv.Mat(goodIndices.length, 1, cv.CV_32FC2);
                        for (let idx = 0; idx < goodIndices.length; idx++) {
                            const origIdx = goodIndices[idx];
                            validPtsMat.data32F[idx * 2] = nextPtsMat.data32F[origIdx * 2];
                            validPtsMat.data32F[idx * 2 + 1] = nextPtsMat.data32F[origIdx * 2 + 1];
                        }

                        trk.prevPtsMat.delete();
                        trk.prevPtsMat = validPtsMat;
                        resultPoints[side] = trk.currentAnchor;
                        totalQuality += numPoints > 0 ? goodIndices.length / numPoints : 0;
                        activeCount++;
                    } else {
                        trk.prevPtsMat.delete();
                        delete trackers[side];
                    }

                    nextPtsMat.delete();
                    statusMat.delete();
                    errMat.delete();
                }

                prevGrayMat.delete();
                prevGrayMat = currGrayMat;

                if (activeCount > 0) {
                    self.postMessage({
                        type: "TRACKING_UPDATE",
                        points: resultPoints,
                        trackingQuality: totalQuality / activeCount,
                        status: "TRACKING",
                    });
                } else {
                    self.postMessage({
                        type: "TRACKING_UPDATE",
                        points: {},
                        trackingQuality: 0,
                        status: "LOST",
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
