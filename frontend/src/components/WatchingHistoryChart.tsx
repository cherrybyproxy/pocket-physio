// line chart visualizing Trunk Lean and Load distribution over past sessions.

import { useState } from "react";
import type { SessionRecord } from "../api/client";

interface WatchingHistoryChartProps {
  sessions: SessionRecord[];
}

export default function WatchingHistoryChart({ sessions }: WatchingHistoryChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Take most recent 20 sessions (sessions array is newest-first, slice & reverse for left-to-right)
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

  // Determine Y-axis max value based on max lean and load (min 60)
  const maxRecorded = Math.max(
    ...recentSessions.map((s) => Math.max(s.bodyLeanMax ?? 0, s.maxLoad ?? 0)),
    0
  );
  const yMax = Math.max(60, Math.ceil((maxRecorded + 10) / 20) * 20);
  const yTicks = [0, Math.round(yMax * 0.5), yMax];

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

  // Build Trunk Lean line path
  const leanPath = recentSessions
    .map((s, i) => {
      const x = getX(i);
      const y = getY(s.bodyLeanMax ?? 0);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  // Build Max Load line path
  const loadPath = recentSessions
    .map((s, i) => {
      const x = getX(i);
      const y = getY(s.maxLoad ?? 0);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const activeSession = hoveredIdx !== null ? recentSessions[hoveredIdx] : null;
  const activeX = hoveredIdx !== null ? getX(hoveredIdx) : null;
  const activeY = activeSession ? getY(activeSession.bodyLeanMax ?? 0) : null;

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
          <span className="chart-title">Watching Metrics Trend</span>
          <span className="chart-subtitle">
            {recentSessions.length} session{recentSessions.length > 1 ? "s" : ""}
          </span>
        </div>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-dot dot-lean" /> Trunk Lean (°)
          </span>
          <span className="legend-item">
            <span className="legend-dot dot-load" /> Max Load (%)
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
                  {tick}
                </text>
              </g>
            );
          })}

          {/* Max Load line */}
          <path d={loadPath} className="chart-line line-load" fill="none" />

          {/* Trunk Lean line */}
          <path d={leanPath} className="chart-line line-lean" fill="none" />

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
            const yLeanPt = getY(s.bodyLeanMax ?? 0);
            const yLoadPt = getY(s.maxLoad ?? 0);
            const isHovered = hoveredIdx === i;

            return (
              <g key={s.id ?? i} className="data-point-group">
                <circle
                  cx={x}
                  cy={yLeanPt}
                  r={isHovered ? 5 : 3.5}
                  className="chart-dot dot-lean"
                />
                <circle
                  cx={x}
                  cy={yLoadPt}
                  r={isHovered ? 5 : 3.5}
                  className="chart-dot dot-load"
                />

                <text
                  x={x}
                  y={svgHeight - 10}
                  textAnchor="middle"
                  className={`chart-x-text ${isHovered ? "active" : ""}`}
                >
                  {s.date ? s.date.replace(/^\d{4}-/, "") : `#${i + 1}`}
                </text>

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

        {/* Tooltip */}
        {activeSession && activeX !== null && (
          <div
            className="chart-tooltip"
            style={{
              left: `${(activeX / svgWidth) * 100}%`,
              top: `${((activeY ?? padding.top) / svgHeight) * 100}%`,
              transform: `translate(${transformX}, ${transformY})`,
            }}
          >
            <div className="tooltip-stats">
              <div className="tooltip-row">
                <span className="tooltip-label">Trunk Lean:</span>
                <span className="tooltip-value lean-val">{activeSession.bodyLeanMax ?? 0}°</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Max Load:</span>
                <span className="tooltip-value load-val">{activeSession.maxLoad ?? 0}%</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
