// Shared type definitions for Optical Flow Web Worker messages (Dual Anchor Support)

export interface SideAnchors {
    left?: { x: number; y: number };
    right?: { x: number; y: number };
}

export interface SideLimbs {
    left?: { x: number; y: number }[];
    right?: { x: number; y: number }[];
}

export interface InitAnchorPayload {
    type: "INIT_ANCHOR";
    frame: ImageBitmap;
    anchors: SideAnchors;
    limbs?: SideLimbs;
}

export interface TrackFramePayload {
    type: "TRACK_FRAME";
    frame: ImageBitmap;
}

export interface ResetPayload {
    type: "RESET";
}

export type WorkerMessage = InitAnchorPayload | TrackFramePayload | ResetPayload;

export interface TrackingSuccessResult {
    type: "TRACKING_UPDATE";
    points: SideAnchors;
    trackingQuality: number; // 0..1 ratio of valid LK tracking points
    status: "TRACKING" | "LOST";
}

export interface OpenCVReadyResult {
    type: "OPENCV_READY";
}

export interface WorkerErrorResult {
    type: "ERROR";
    message: string;
}

export type WorkerResponse = TrackingSuccessResult | OpenCVReadyResult | WorkerErrorResult;
