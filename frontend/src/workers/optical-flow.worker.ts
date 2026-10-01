// Dual-knee tracker: LK optical flow on knee-local points, gated by multi-scale template matching.
declare const cv: any;
declare function importScripts(...urls: string[]): void;

type Side = "left" | "right";
type Pt = { x: number; y: number };
type SideAnchors = { left?: Pt; right?: Pt };

interface SideTracker {
    prevPtsMat: any;
    templateMat: any;
    templateTextured: boolean;
    currentAnchor: Pt;
    lostFrames: number;
    syncs: number;
}

// tunables (px values are in the 640x360 frame the main thread sends)
const PATCH = 44;
const SEED_RADIUS = 30;        // corners only seeded this close to the knee
const LOCAL_RADIUS = 70;       // only LK points this close to the knee drive the anchor
const SEARCH_RADIUS = 48;      // template search half-window around the LK prediction
const MAX_JUMP_PX = 30;        // template result must agree with LK prediction
const MIN_TEMPLATE_SCORE = 0.6;
const UPDATE_SCORE = 0.85;     // only refresh template on very strong, LK-confirmed matches
const MIN_LOCAL_PTS = 4;
const MIN_KEEP_PTS = 12;       // reseed below this
const MIN_SEPARATION_PX = 40;  // two knees can't be on top of each other
const MIN_TEXTURE_STD = 12;    // flat patches are useless for template matching
const MAX_COAST_FRAMES = 20;

let isOpenCvReady = false;
let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
let prevGrayMat: any = null;
const trackers: { left?: SideTracker; right?: SideTracker } = {};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const median = (a: number[]) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[s.length >> 1];
};

function loadOpenCV() {
    try {
        importScripts("https://docs.opencv.org/4.8.0/opencv.js");
        if (typeof cv !== "undefined") {
            if (cv.Mat) {
                isOpenCvReady = true;
                self.postMessage({ type: "OPENCV_READY" });
            } else {
                cv.onRuntimeInitialized = () => {
                    isOpenCvReady = true;
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

function freeTracker(side: Side) {
    const t = trackers[side];
    if (!t) return;
    t.prevPtsMat?.delete();
    t.templateMat?.delete();
    delete trackers[side];
}

function resetMemoryState() {
    prevGrayMat?.delete();
    prevGrayMat = null;
    freeTracker("left");
    freeTracker("right");
}

function patchStd(m: any): number {
    const d: Uint8Array = m.data;
    let s = 0, s2 = 0;
    for (let i = 0; i < d.length; i++) { s += d[i]; s2 += d[i] * d[i]; }
    const mean = s / d.length;
    return Math.sqrt(Math.max(0, s2 / d.length - mean * mean));
}

// Shi-Tomasi corners in a tight circle around the knee only (no limb line -> fewer floor/wall features)
function seedPoints(gray: any, anchor: Pt, width: number, height: number): any {
    const ax = Math.round(anchor.x * width);
    const ay = Math.round(anchor.y * height);
    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
    cv.circle(mask, new cv.Point(ax, ay), SEED_RADIUS, new cv.Scalar(255), -1);
    const corners = new cv.Mat();
    cv.goodFeaturesToTrack(gray, corners, 40, 0.002, 4, mask);
    mask.delete();
    if (corners.rows > 0) return corners;
    corners.delete();
    const m = new cv.Mat(1, 1, cv.CV_32FC2);
    m.data32F[0] = ax;
    m.data32F[1] = ay;
    return m;
}

function addTracker(side: Side, anchor: Pt, gray: any, width: number, height: number) {
    const cropX = clamp(Math.round(anchor.x * width - PATCH / 2), 0, width - PATCH);
    const cropY = clamp(Math.round(anchor.y * height - PATCH / 2), 0, height - PATCH);
    const templateMat = gray.roi(new cv.Rect(cropX, cropY, PATCH, PATCH)).clone();
    trackers[side] = {
        prevPtsMat: seedPoints(gray, anchor, width, height),
        templateMat,
        templateTextured: patchStd(templateMat) >= MIN_TEXTURE_STD,
        currentAnchor: { x: anchor.x, y: anchor.y },
        lostFrames: 0,
        syncs: 0,
    };
}

function snapshot(): SideAnchors {
    const out: SideAnchors = {};
    if (trackers.left) out.left = trackers.left.currentAnchor;
    if (trackers.right) out.right = trackers.right.currentAnchor;
    return out;
}

// Advances every active tracker onto currGray. Takes ownership of currGray (becomes prevGrayMat).
function trackStep(currGray: any, width: number, height: number) {
    const winSize = new cv.Size(31, 31);
    const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 20, 0.03);
    const points: SideAnchors = {};
    let totalQuality = 0;
    let active = 0;

    const sides = (["left", "right"] as Side[]).filter((s) => trackers[s]);

    for (const side of sides) {
        const trk = trackers[side]!;
        const other = trackers[side === "left" ? "right" : "left"];
        const ax = trk.currentAnchor.x * width;
        const ay = trk.currentAnchor.y * height;

        // ---- 1. LK forward/backward, using only knee-local points for the motion estimate ----
        const nextPts = new cv.Mat(), st = new cv.Mat(), er = new cv.Mat();
        const backPts = new cv.Mat(), bst = new cv.Mat(), ber = new cv.Mat();
        cv.calcOpticalFlowPyrLK(prevGrayMat, currGray, trk.prevPtsMat, nextPts, st, er, winSize, 3, criteria);
        cv.calcOpticalFlowPyrLK(currGray, prevGrayMat, nextPts, backPts, bst, ber, winSize, 3, criteria);

        const good: number[] = [];
        const ldx: number[] = [];
        const ldy: number[] = [];
        for (let i = 0; i < nextPts.rows; i++) {
            if (st.data[i] !== 1 || bst.data[i] !== 1) continue;
            const px = trk.prevPtsMat.data32F[i * 2];
            const py = trk.prevPtsMat.data32F[i * 2 + 1];
            const fb = Math.hypot(backPts.data32F[i * 2] - px, backPts.data32F[i * 2 + 1] - py);
            if (fb > 1.5) continue;
            good.push(i);
            if (Math.hypot(px - ax, py - ay) <= LOCAL_RADIUS) {
                ldx.push(nextPts.data32F[i * 2] - px);
                ldy.push(nextPts.data32F[i * 2 + 1] - py);
            }
        }
        backPts.delete(); bst.delete(); ber.delete(); st.delete(); er.delete();

        const predicted: Pt | null =
            ldx.length >= MIN_LOCAL_PTS ? { x: ax + median(ldx), y: ay + median(ldy) } : null;

        // ---- 2. Template match: small window around the LK prediction, heavily gated ----
        let match: { x: number; y: number; score: number } | null = null;
        if (trk.templateTextured) {
            const ref = predicted ?? { x: ax, y: ay };
            const searchSize = SEARCH_RADIUS * 2 + PATCH;
            const sx = clamp(Math.round(ref.x - searchSize / 2), 0, width - searchSize);
            const sy = clamp(Math.round(ref.y - searchSize / 2), 0, height - searchSize);
            const searchMat = currGray.roi(new cv.Rect(sx, sy, searchSize, searchSize));

            let best = -1, bestLoc = { x: 0, y: 0 }, bestSize = PATCH;
            for (const s of [0.85, 1.0, 1.15]) {
                const size = Math.round(PATCH * s);
                const tpl = new cv.Mat();
                cv.resize(trk.templateMat, tpl, new cv.Size(size, size), 0, 0, cv.INTER_LINEAR);
                const res = new cv.Mat();
                cv.matchTemplate(searchMat, tpl, res, cv.TM_CCOEFF_NORMED);
                const mm = cv.minMaxLoc(res);
                if (Number.isFinite(mm.maxVal) && mm.maxVal > best) {
                    best = mm.maxVal; bestLoc = mm.maxLoc; bestSize = size;
                }
                tpl.delete(); res.delete();
            }
            searchMat.delete();

            if (best >= MIN_TEMPLATE_SCORE) {
                const mx = sx + bestLoc.x + bestSize / 2;
                const my = sy + bestLoc.y + bestSize / 2;
                const jumpOk = Math.hypot(mx - ref.x, my - ref.y) <= MAX_JUMP_PX;
                const sepOk =
                    !other ||
                    Math.hypot(mx - other.currentAnchor.x * width, my - other.currentAnchor.y * height) >= MIN_SEPARATION_PX;
                if (jumpOk && sepOk) match = { x: mx, y: my, score: best };
            }
        }

        // ---- 3. Fuse ----
        let fx: number | null = null;
        let fy = 0;
        let quality = 0;
        if (match && predicted) {
            fx = (match.x + predicted.x) / 2;
            fy = (match.y + predicted.y) / 2;
            quality = match.score;
        } else if (match) {
            fx = match.x; fy = match.y;
            quality = match.score * 0.8;
        } else if (predicted) {
            fx = predicted.x; fy = predicted.y;
            quality = Math.min(1, ldx.length / 10);
        }

        if (fx !== null) {
            trk.currentAnchor = { x: clamp(fx / width, 0, 1), y: clamp(fy / height, 0, 1) };
            trk.lostFrames = 0;

            // template refresh only when appearance AND motion agree on a strong match
            if (match && predicted && match.score >= UPDATE_SCORE) {
                const cx = clamp(Math.round(fx - PATCH / 2), 0, width - PATCH);
                const cy = clamp(Math.round(fy - PATCH / 2), 0, height - PATCH);
                const fresh = currGray.roi(new cv.Rect(cx, cy, PATCH, PATCH));
                cv.addWeighted(trk.templateMat, 0.9, fresh, 0.1, 0, trk.templateMat);
                fresh.delete();
            }
        } else {
            trk.lostFrames++;
        }

        // ---- 4. Refresh the point set (prune far-away points, reseed if it's getting thin) ----
        const apx = trk.currentAnchor.x * width;
        const apy = trk.currentAnchor.y * height;
        const keep = good.filter(
            (i) => Math.hypot(nextPts.data32F[i * 2] - apx, nextPts.data32F[i * 2 + 1] - apy) <= LOCAL_RADIUS * 1.5
        );
        let newPts: any;
        if (keep.length >= MIN_KEEP_PTS) {
            newPts = new cv.Mat(keep.length, 1, cv.CV_32FC2);
            keep.forEach((src, dst) => {
                newPts.data32F[dst * 2] = nextPts.data32F[src * 2];
                newPts.data32F[dst * 2 + 1] = nextPts.data32F[src * 2 + 1];
            });
        } else {
            newPts = seedPoints(currGray, trk.currentAnchor, width, height);
        }
        trk.prevPtsMat.delete();
        trk.prevPtsMat = newPts;
        nextPts.delete();

        // ---- 5. Report / coast / drop ----
        if (trk.lostFrames > MAX_COAST_FRAMES) {
            freeTracker(side);
        } else {
            points[side] = trk.currentAnchor; // coasting sides keep reporting their last position
            totalQuality += quality;
            active++;
        }
    }

    prevGrayMat.delete();
    prevGrayMat = currGray;

    return {
        type: "TRACKING_UPDATE",
        points,
        trackingQuality: active ? totalQuality / active : 0,
        status: active ? "TRACKING" : "LOST",
    };
}

self.onmessage = async (event: MessageEvent<any>) => {
    const message = event.data;

    if (!isOpenCvReady && typeof cv !== "undefined" && cv.Mat) isOpenCvReady = true;
    if (!isOpenCvReady) {
        // bitmaps still need closing or they leak
        if (message?.frame) message.frame.close();
        self.postMessage({ type: "ERROR", message: "OpenCV.js WebAssembly runtime is not yet initialized." });
        return;
    }

    switch (message.type) {
        case "SYNC": {
            const { frame, anchors } = message as { frame: ImageBitmap; anchors?: SideAnchors };
            try {
                const gray = bitmapToGrayscaleMat(frame);
                const width = frame.width;
                const height = frame.height;

                // advance existing trackers onto this frame (keeps LK continuous)
                if (prevGrayMat && (trackers.left || trackers.right)) {
                    trackStep(gray, width, height);
                } else {
                    prevGrayMat?.delete();
                    prevGrayMat = gray;
                }

                // snap to MediaPipe's real knee wherever it's confident
                for (const side of ["left", "right"] as Side[]) {
                    const a = anchors?.[side];
                    if (!a) continue;
                    const t = trackers[side];
                    if (!t) {
                        addTracker(side, a, prevGrayMat, width, height);
                    } else if (++t.syncs % 5 === 0) {
                        // every 5th sync: full refresh of template + feature points at the true knee
                        freeTracker(side);
                        addTracker(side, a, prevGrayMat, width, height);
                    } else {
                        t.currentAnchor = { x: a.x, y: a.y };
                        t.lostFrames = 0;
                    }
                }

                self.postMessage({
                    type: "TRACKING_UPDATE",
                    points: snapshot(),
                    trackingQuality: 1,
                    status: trackers.left || trackers.right ? "TRACKING" : "LOST",
                });
            } catch (err: any) {
                self.postMessage({ type: "ERROR", message: err?.message ?? "sync failed" });
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