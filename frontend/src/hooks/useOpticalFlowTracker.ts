import { useEffect, useRef, useState, useCallback } from "react";
import type {
    WorkerResponse,
    SideAnchors,
    SideLimbs,
    TrackingStatus,
    TrackerLifecycle,
} from "../types/opticalFlow";

export interface OpticalFlowState {
    isReady: boolean;
    lifecycle: TrackerLifecycle;
    isTracking: boolean; // true when motion is actively accepted
    status: TrackingStatus | null;
    trackedPoints: SideAnchors;
    trackingQuality: number;
    error: string | null;
}

const logLifecycleTransition = (from: TrackerLifecycle, to: TrackerLifecycle) => {
    if (from !== to) {
        console.log(`[useOpticalFlowTracker] Lifecycle transition: ${from} → ${to}`);
    }
};

export function useOpticalFlowTracker() {
    const [state, setState] = useState<OpticalFlowState>({
        isReady: false,
        lifecycle: "UNINITIALIZED",
        isTracking: false,
        status: null,
        trackedPoints: {},
        trackingQuality: 0,
        error: null,
    });

    const workerRef = useRef<Worker | null>(null);
    const lifecycleRef = useRef<TrackerLifecycle>("UNINITIALIZED");
    const isInitPendingRef = useRef(false);
    const isTrackingRef = useRef(false);
    const sessionIdRef = useRef(0);

    // Returns whether an active tracker exists or is currently initializing
    const hasActiveTracker = useCallback(() => {
        return (
            lifecycleRef.current === "TRACKING" ||
            lifecycleRef.current === "UNCERTAIN" ||
            isInitPendingRef.current
        );
    }, []);

    // instantiate dedicated Web Worker on mount
    useEffect(() => {
        let worker: Worker | null = null;
        try {
            worker = new Worker(
                new URL("../workers/optical-flow.worker.ts", import.meta.url)
            );

            worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                const response = event.data;
                switch (response.type) {
                    case "OPENCV_READY":
                        console.log("[useOpticalFlowTracker] OpenCV.js is ready");
                        setState((prev) => ({ ...prev, isReady: true, error: null }));
                        break;

                    case "TRACKING_UPDATE": {
                        // Drop delayed messages from previous sessions
                        if (
                            typeof response.sessionId === "number" &&
                            response.sessionId !== sessionIdRef.current
                        ) {
                            return;
                        }

                        isInitPendingRef.current = false;

                        const newStatus: TrackingStatus = response.status;
                        const prevLifecycle = lifecycleRef.current;
                        const nextLifecycle: TrackerLifecycle = newStatus;

                        logLifecycleTransition(prevLifecycle, nextLifecycle);

                        lifecycleRef.current = nextLifecycle;
                        const isMotionAccepted = nextLifecycle === "TRACKING";
                        isTrackingRef.current = isMotionAccepted;

                        setState((prev) => ({
                            ...prev,
                            lifecycle: nextLifecycle,
                            status: newStatus,
                            isTracking: isMotionAccepted,
                            trackedPoints: response.points ?? {},
                            trackingQuality: response.trackingQuality,
                            error: null,
                        }));
                        break;
                    }

                    case "ERROR": {
                        if (
                            typeof response.sessionId === "number" &&
                            response.sessionId !== sessionIdRef.current
                        ) {
                            return;
                        }

                        isInitPendingRef.current = false;
                        const prevLifecycle = lifecycleRef.current;
                        if (prevLifecycle !== "LOST" && prevLifecycle !== "UNINITIALIZED") {
                            logLifecycleTransition(prevLifecycle, "LOST");
                            lifecycleRef.current = "LOST";
                        }
                        isTrackingRef.current = false;

                        console.warn("[useOpticalFlowTracker] Worker error:", response.message);
                        setState((prev) => ({
                            ...prev,
                            lifecycle: lifecycleRef.current,
                            isTracking: false,
                            error: response.message,
                        }));
                        break;
                    }
                }
            };

            workerRef.current = worker;
        } catch (err) {
            console.error("[useOpticalFlowTracker] Failed to instantiate Web Worker:", err);
            setState((prev) => ({
                ...prev,
                error: "Failed to initialize Optical Flow Web Worker",
            }));
        }

        return () => {
            if (worker) {
                worker.terminate();
                workerRef.current = null;
            }
        };
    }, []);

    // initialize anchors for left and/or right leg
    const initAnchor = useCallback((frame: ImageBitmap, anchors: SideAnchors, limbs?: SideLimbs): boolean => {
        if (!workerRef.current) return false;

        // Prevent duplicate initialization messages while initialization is pending
        if (isInitPendingRef.current) {
            console.warn("[useOpticalFlowTracker] Initialization skipped: already pending");
            return false;
        }

        // Start new tracking session
        sessionIdRef.current += 1;
        const currentSession = sessionIdRef.current;
        isInitPendingRef.current = true;

        console.log(`[useOpticalFlowTracker] Anchor initialization requested (session ${currentSession})`, { anchors });

        try {
            // transfer ImageBitmap ownership to worker
            workerRef.current.postMessage(
                { type: "INIT_ANCHOR", frame, anchors, limbs, sessionId: currentSession },
                [frame]
            );
            return true;
        } catch (err) {
            console.error("[useOpticalFlowTracker] Failed to post INIT_ANCHOR:", err);
            isInitPendingRef.current = false;
            return false;
        }
    }, []);

    // dispatch next frame for Lucas-Kanade optical flow tracking
    const trackFrame = useCallback((frame: ImageBitmap): boolean => {
        if (!workerRef.current) return false;
        try {
            // transfer ImageBitmap ownership to worker
            workerRef.current.postMessage(
                { type: "TRACK_FRAME", frame, sessionId: sessionIdRef.current },
                [frame]
            );
            return true;
        } catch (err) {
            console.error("[useOpticalFlowTracker] Failed to post TRACK_FRAME:", err);
            return false;
        }
    }, []);

    // reset optical flow tracking memory
    const resetTracker = useCallback(() => {
        // Increment session ID to invalidate any queued or in-flight messages from worker
        sessionIdRef.current += 1;
        const currentSession = sessionIdRef.current;

        const prevLifecycle = lifecycleRef.current;
        if (prevLifecycle !== "UNINITIALIZED") {
            logLifecycleTransition(prevLifecycle, "UNINITIALIZED");
        }

        lifecycleRef.current = "UNINITIALIZED";
        isInitPendingRef.current = false;
        isTrackingRef.current = false;

        if (workerRef.current) {
            workerRef.current.postMessage({ type: "RESET", sessionId: currentSession });
        }

        setState((prev) => ({
            ...prev,
            lifecycle: "UNINITIALIZED",
            status: null,
            isTracking: false,
            trackedPoints: {},
            trackingQuality: 0,
            error: null,
        }));
    }, []);

    return {
        ...state,
        lifecycleRef,
        isInitPendingRef,
        isTrackingRef,
        hasActiveTracker,
        initAnchor,
        trackFrame,
        resetTracker,
    };
}

