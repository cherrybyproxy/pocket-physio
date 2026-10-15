// Shared type definitions for Optical Flow Web Worker messages (Dual Anchor Support)

export type TrackingStatus = "TRACKING" | "UNCERTAIN" | "LOST";

export type TrackerLifecycle = "UNINITIALIZED" | "TRACKING" | "UNCERTAIN" | "LOST";

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
    sessionId?: number;
}

export interface TrackFramePayload {
    type: "TRACK_FRAME";
    frame: ImageBitmap;
    sessionId?: number;
}

export interface ResetPayload {
    type: "RESET";
    sessionId?: number;
}

export type WorkerMessage = InitAnchorPayload | TrackFramePayload | ResetPayload;

export interface TrackingSuccessResult {
    type: "TRACKING_UPDATE";
    points: SideAnchors;
    trackingQuality: number; // 0..1 ratio of valid LK tracking points
    status: TrackingStatus;
    sessionId?: number;
    debug?: any;
}

export interface OpenCVReadyResult {
    type: "OPENCV_READY";
}

export interface WorkerErrorResult {
    type: "ERROR";
    message: string;
    sessionId?: number;
}

export type WorkerResponse = TrackingSuccessResult | OpenCVReadyResult | WorkerErrorResult;
