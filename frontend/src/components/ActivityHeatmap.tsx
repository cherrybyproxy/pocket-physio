// github / leetcode / neetcode style activity heatmap calendar.
// displays 4 distinct separated months with purple intensity shades for sessions.

import { useState, useMemo } from "react";
import type { SessionRecord } from "../api/client";

interface ActivityHeatmapProps {
  sessions: SessionRecord[];
}

interface DayCell {
  date: Date;
  dateStr: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3;
}

interface MonthGroup {
  name: string;
  year: number;
  monthIndex: number;
  weeks: (DayCell | null)[][];
}

const CELL_SIZE = 12;
const CELL_GAP = 3;

export default function ActivityHeatmap({ sessions }: ActivityHeatmapProps) {
  const [hoveredCell, setHoveredCell] = useState<{
    cell: DayCell;
    x: number;
    y: number;
  } | null>(null);

  // aggregate daily qualifying sessions (at least 1 rep or baseline calibration)
  const sessionCountsByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      const isQualifying =
        (s.flexReps !== undefined && s.flexReps > 0) ||
        (s.extReps !== undefined && s.extReps > 0) ||
        (s.rom !== undefined && s.rom > 0);

      if (isQualifying && s.date) {
        map.set(s.date, (map.get(s.date) || 0) + 1);
      }
    }
    return map;
  }, [sessions]);

  // generate 3 distinct separated month blocks (past 2 months + current month)
  const { monthGroups, totalQualifyingSessions } = useMemo(() => {
    const today = new Date();
    const currYear = today.getFullYear();
    const currMonth = today.getMonth();

    const groups: MonthGroup[] = [];
    let totalCount = 0;

    for (let offset = 2; offset >= 0; offset--) {
      const targetDate = new Date(currYear, currMonth - offset, 1);
      const year = targetDate.getFullYear();
      const monthIndex = targetDate.getMonth();
      const monthName = targetDate.toLocaleDateString("en-US", { month: "short" });

      const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
      const maxDay = offset === 0 ? Math.min(daysInMonth, today.getDate()) : daysInMonth;
      const firstDay = new Date(year, monthIndex, 1);
      // Sunday = 0, Monday = 1, ... Saturday = 6
      const startDow = firstDay.getDay();

      const weeks: (DayCell | null)[][] = [];
      let currentWeek: (DayCell | null)[] = [];

      // empty slots before day 1
      for (let d = 0; d < startDow; d++) {
        currentWeek.push(null);
      }

      for (let day = 1; day <= maxDay; day++) {
        const date = new Date(year, monthIndex, day);
        const yyyy = year;
        const mm = String(monthIndex + 1).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        const dateStr = `${yyyy}-${mm}-${dd}`;

        const count = sessionCountsByDate.get(dateStr) || 0;
        totalCount += count;

        let level: 0 | 1 | 2 | 3 = 0;
        if (count >= 3) level = 3;
        else if (count === 2) level = 2;
        else if (count === 1) level = 1;

        currentWeek.push({
          date,
          dateStr,
          count,
          level,
        });

        if (currentWeek.length === 7) {
          weeks.push(currentWeek);
          currentWeek = [];
        }
      }

      // fill remaining slots in the last week column
      if (currentWeek.length > 0) {
        while (currentWeek.length < 7) {
          currentWeek.push(null);
        }
        weeks.push(currentWeek);
      }

      groups.push({
        name: monthName,
        year,
        monthIndex,
        weeks,
      });
    }

    return {
      monthGroups: groups,
      totalQualifyingSessions: totalCount,
    };
  }, [sessionCountsByDate]);

  const gridHeight = 7 * (CELL_SIZE + CELL_GAP);

  return (
    <div className="activity-heatmap-card">
      <div className="heatmap-header">
        <div className="heatmap-title-group">
          <span className="heatmap-title">Activity Calendar</span>
          <span className="heatmap-subtitle">
            {totalQualifyingSessions} session{totalQualifyingSessions === 1 ? "" : "s"} in past 3 months
          </span>
        </div>
      </div>

      <div className="heatmap-scroll-wrapper">
        <div className="heatmap-separated-container">
          {/* 4 Distinct Month Clusters */}
          <div className="heatmap-months-cluster">
            {monthGroups.map((group) => {
              const monthWidth = group.weeks.length * (CELL_SIZE + CELL_GAP);
              return (
                <div key={`${group.year}-${group.monthIndex}`} className="heatmap-month-block">
                  <div className="heatmap-month-title">{group.name}</div>
                  <svg width={monthWidth} height={gridHeight} className="heatmap-svg">
                    {group.weeks.map((week, wIdx) =>
                      week.map((dayCell, dIdx) => {
                        if (!dayCell) return null;
                        const x = wIdx * (CELL_SIZE + CELL_GAP);
                        const y = dIdx * (CELL_SIZE + CELL_GAP);
                        return (
                          <rect
                            key={dayCell.dateStr}
                            x={x}
                            y={y}
                            width={CELL_SIZE}
                            height={CELL_SIZE}
                            rx={2}
                            ry={2}
                            className={`heatmap-cell level-${dayCell.level}`}
                            onMouseEnter={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setHoveredCell({
                                cell: dayCell,
                                x: rect.left + rect.width / 2,
                                y: rect.top - 8,
                              });
                            }}
                            onMouseLeave={() => setHoveredCell(null)}
                          />
                        );
                      })
                    )}
                  </svg>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Floating Tooltip */}
      {hoveredCell && (
        <div
          className="heatmap-tooltip"
          style={{
            left: hoveredCell.x,
            top: hoveredCell.y,
            transform: "translate(-50%, -100%)",
          }}
        >
          <strong>
            {hoveredCell.cell.count === 0
              ? "No sessions"
              : `${hoveredCell.cell.count} session${hoveredCell.cell.count === 1 ? "" : "s"}`}
          </strong>{" "}
          on{" "}
          {hoveredCell.cell.date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </div>
      )}
    </div>
  );
}
