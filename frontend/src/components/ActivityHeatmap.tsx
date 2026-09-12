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

  // calculate current streak and longest historical streak
  const { currentStreak, maxStreak } = useMemo(() => {
    const today = new Date();
    const formatDate = (d: Date) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const checkDate = new Date(today);
    const todayStr = formatDate(checkDate);

    // if today has no sessions yet, check if yesterday was active to keep streak alive
    if (!sessionCountsByDate.has(todayStr)) {
      checkDate.setDate(checkDate.getDate() - 1);
      const yesterdayStr = formatDate(checkDate);
      if (!sessionCountsByDate.has(yesterdayStr)) {
        // current streak is 0
      }
    }

    let curr = 0;
    const tempDate = new Date(checkDate);
    while (sessionCountsByDate.has(formatDate(tempDate))) {
      curr++;
      tempDate.setDate(tempDate.getDate() - 1);
    }

    // calculate historical max streak
    const sortedDates = Array.from(sessionCountsByDate.keys()).sort();
    let max = 0;
    let running = 0;
    let prevTime = 0;

    for (const dateStr of sortedDates) {
      const [y, m, d] = dateStr.split("-").map(Number);
      const time = new Date(y, m - 1, d).getTime();
      const oneDay = 24 * 60 * 60 * 1000;

      if (prevTime === 0 || time - prevTime === oneDay) {
        running++;
      } else if (time !== prevTime) {
        running = 1;
      }
      max = Math.max(max, running);
      prevTime = time;
    }

    return {
      currentStreak: curr,
      maxStreak: Math.max(max, curr),
    };
  }, [sessionCountsByDate]);

  const gridHeight = 7 * (CELL_SIZE + CELL_GAP);

  return (
    <div className="activity-heatmap-card split-container">
      {/* Left Half: Activity Calendar (Centered) */}
      <div className="split-half calendar-half">
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
            {/* 3 Distinct Month Clusters */}
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
      </div>

      {/* Right Half: Streak (Centered) */}
      <div className="split-half streak-half">
        <div className="streak-section-header">
          <span className="streak-title">Daily Streak</span>
        </div>

        <div className="streak-hero-display">
          <span className="streak-number">{currentStreak}</span>
          <span className="streak-unit">Day{currentStreak === 1 ? "" : "s"} Active</span>
        </div>

        <div className="streak-milestones-row">
          <span className="milestones-label">Milestones:</span>
          <div className="milestone-badges">
            {[3, 10, 30].map((days) => {
              const isUnlocked = maxStreak >= days;
              return (
                <div
                  key={days}
                  className={`streak-circle-badge ${isUnlocked ? "unlocked" : "locked"}`}
                  title={isUnlocked ? `${days}-Day Streak Unlocked!` : `${days}-Day Streak (Locked)`}
                >
                  {days}
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
