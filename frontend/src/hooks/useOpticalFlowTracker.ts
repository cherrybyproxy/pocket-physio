import { useEffect, useRef, useState, useCallback } from "react";
import type { WorkerResponse, SideAnchors, SideLimbs } from "../types/opticalFlow";

export interface OpticalFlowState {
    isReady: boolean;
    isTracking: boolean;
    trackedPoints: SideAnchors;
    trackingQuality: number;
    error: string | null;
}

export function useOpticalFlowTracker() {
    const [state, setState] = useState<OpticalFlowState>({
        isReady: false,
        isTracking: false,
        trackedPoints: {},
        trackingQuality: 0,
        error: null,
    });

    const workerRef = useRef<Worker | null>(null);
    const isTrackingRef = useRef(false);

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
                        console.log("[useOpticalFlowTracker] OpenCV.js WebAssembly is READY!");
                        setState((prev) => ({ ...prev, isReady: true, error: null }));
                        break;

                    case "TRACKING_UPDATE":
                        const isStillTracking = response.status === "TRACKING";
                        isTrackingRef.current = isStillTracking;
                        setState((prev) => ({
                            ...prev,
                            isTracking: isStillTracking,
                            trackedPoints: response.points ?? {},
                            trackingQuality: response.trackingQuality,
                        }));
                        break;

                    case "ERROR":
                        console.warn("[useOpticalFlowTracker] Worker error:", response.message);
                        setState((prev) => ({ ...prev, error: response.message }));
                        break;
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
    const initAnchor = useCallback((frame: ImageBitmap, anchors: SideAnchors, limbs?: SideLimbs) => {
        if (!workerRef.current) return;
        isTrackingRef.current = true;
        // transfer ImageBitmap ownership to worker
        workerRef.current.postMessage({ type: "INIT_ANCHOR", frame, anchors, limbs }, [frame]);
    }, []);

    // dispatch next frame for Lucas-Kanade optical flow tracking
    const trackFrame = useCallback((frame: ImageBitmap) => {
        if (!workerRef.current) return;
        // transfer ImageBitmap ownership to worker
        workerRef.current.postMessage({ type: "TRACK_FRAME", frame }, [frame]);
    }, []);

    // reset optical flow tracking memory
    const resetTracker = useCallback(() => {
        if (!workerRef.current) return;
        isTrackingRef.current = false;
        workerRef.current.postMessage({ type: "RESET" });
        setState((prev) => ({
            ...prev,
            isTracking: false,
            trackedPoints: {},
            trackingQuality: 0,
        }));
    }, []);

    return {
        ...state,
        isTrackingRef,
        initAnchor,
        trackFrame,
        resetTracker,
    };
}
