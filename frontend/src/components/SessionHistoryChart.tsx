// line chart visualizing ROM (Range of Motion) over the last 20 sessions.

import { useState } from "react";
import type { SessionRecord } from "../api/client";

interface SessionHistoryChartProps {
  sessions: SessionRecord[];
}

export default function SessionHistoryChart({ sessions }: SessionHistoryChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Take most recent 20 sessions (sessions array is newest-first, so slice 20 and reverse for chronological left-to-right)
  const recentSessions = [...sessions.slice(0, 20)].reverse();

  if (recentSessions.length === 0) {
    return null;
  }

  // Chart dimensions & layout
  const svgWidth = 800;
  const svgHeight = 170;
  const padding = { top: 20, right: 25, bottom: 35, left: 40 };
  const plotWidth = svgWidth - padding.left - padding.right;
  const plotHeight = svgHeight - padding.top - padding.bottom;

  // Determine Y-axis max value (round up to nearest 30°, min 90°)
  const maxRecorded = Math.max(
    ...recentSessions.map((s) => s.rom ?? 0),
    0
  );
  const yMax = Math.max(90, Math.ceil((maxRecorded + 15) / 30) * 30);
  const yTicks = [0, Math.round(yMax * 0.5), yMax];

  // Calculate X and Y coordinates
  const getX = (index: number) => {
    if (recentSessions.length === 1) {
      return padding.left + plotWidth / 2;
    }
    return padding.left + (index / (recentSessions.length - 1)) * plotWidth;
  };

  const getY = (val: number) => {
    const clamped = Math.max(0, Math.min(yMax, val));
    return padding.top + plotHeight - (clamped / yMax) * plotHeight;
  };

  // Build ROM line path
  const romPath = recentSessions
    .map((s, i) => {
      const x = getX(i);
      const y = getY(s.rom ?? 0);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const activeSession = hoveredIdx !== null ? recentSessions[hoveredIdx] : null;
  const activeX = hoveredIdx !== null ? getX(hoveredIdx) : null;
  const activeY = activeSession ? getY(activeSession.rom ?? 0) : null;

  // Tooltip positioning flags
  const isLeftEdge = hoveredIdx === 0 || (activeX !== null && activeX < 90);
  const isRightEdge =
    hoveredIdx === recentSessions.length - 1 ||
    (activeX !== null && activeX > svgWidth - 110);
  const isTopEdge = activeY !== null && activeY < 60;

  const transformX = isRightEdge ? "-96%" : isLeftEdge ? "-4%" : "-50%";
  const transformY = isTopEdge ? "10px" : "calc(-100% - 10px)";

  return (
    <div className="history-chart-container">
      <div className="chart-header">
        <div className="chart-title-area">
          <span className="chart-title">ROM Trend</span>
          <span className="chart-subtitle">
            {recentSessions.length} recent session{recentSessions.length > 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="chart-svg-wrapper">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="history-chart-svg"
          preserveAspectRatio="none"
          onMouseLeave={() => setHoveredIdx(null)}
        >
          {/* Horizontal Gridlines & Y-Axis Labels */}
          {yTicks.map((tick) => {
            const y = getY(tick);
            return (
              <g key={tick} className="grid-group">
                <line
                  x1={padding.left}
                  y1={y}
                  x2={svgWidth - padding.right}
                  y2={y}
                  className="chart-grid-line"
                />
                <text
                  x={padding.left - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  className="chart-axis-text"
                >
                  {tick}°
                </text>
              </g>
            );
          })}

          {/* Clean ROM Line without shading */}
          <path
            d={romPath}
            className="chart-line line-rom"
            fill="none"
          />

          {/* Hover indicator line */}
          {activeX !== null && (
            <line
              x1={activeX}
              y1={padding.top}
              x2={activeX}
              y2={padding.top + plotHeight}
              className="chart-hover-line"
            />
          )}

          {/* Data Points */}
          {recentSessions.map((s, i) => {
            const x = getX(i);
            const yRomPt = getY(s.rom ?? 0);
            const isHovered = hoveredIdx === i;

            return (
              <g key={s.id ?? i} className="data-point-group">
                {/* ROM circle */}
                <circle
                  cx={x}
                  cy={yRomPt}
                  r={isHovered ? 5 : 3.5}
                  className="chart-dot dot-rom"
                />

                {/* X-axis tick date label */}
                <text
                  x={x}
                  y={svgHeight - 10}
                  textAnchor="middle"
                  className={`chart-x-text ${isHovered ? "active" : ""}`}
                >
                  {s.date ? s.date.replace(/^\d{4}-/, "") : `#${i + 1}`}
                </text>

                {/* Invisible hover capture column */}
                <rect
                  x={x - (plotWidth / Math.max(1, recentSessions.length)) / 2}
                  y={padding.top}
                  width={plotWidth / Math.max(1, recentSessions.length)}
                  height={plotHeight + padding.bottom}
                  fill="transparent"
                  onMouseEnter={() => setHoveredIdx(i)}
                  style={{ cursor: "pointer" }}
                />
              </g>
            );
          })}
        </svg>

        {/* Floating Tooltip close to hovered point & constrained to fit */}
        {activeSession && activeX !== null && activeY !== null && (
          <div
            className="chart-tooltip"
            style={{
              left: `${(activeX / svgWidth) * 100}%`,
              top: `${(activeY / svgHeight) * 100}%`,
              transform: `translate(${transformX}, ${transformY})`,
            }}
          >
            <div className="tooltip-stats">
              <div className="tooltip-row">
                <span className="tooltip-label">ROM:</span>
                <span className="tooltip-value rom-val">{activeSession.rom ?? "--"}°</span>
              </div>
              {(activeSession.minAngle !== undefined || activeSession.maxAngle !== undefined) && (
                <div className="tooltip-row tooltip-sub">
                  <span>Range: {activeSession.minAngle ?? "--"}° – {activeSession.maxAngle ?? "--"}°</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
