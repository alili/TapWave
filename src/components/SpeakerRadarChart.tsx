import React, { useState } from 'react';
import { RadarDimensionScore } from '../engine/speakerRadarEngine';

interface SpeakerRadarChartProps {
  speakerName: string;
  color: string;
  overallScore: number;
  dimensions: RadarDimensionScore[];
  teamAverageScores?: number[];
}

const CX = 160;
const CY = 128;
const RADIUS = 76;
const GRID_LEVELS = [0.25, 0.5, 0.75, 1];

function polarToCartesian(angleDeg: number, r: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

export const SpeakerRadarChart: React.FC<SpeakerRadarChartProps> = ({
  speakerName,
  color,
  overallScore,
  dimensions,
  teamAverageScores,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [lockedIdx, setLockedIdx] = useState<number | null>(null);

  const count = dimensions.length;
  if (count === 0) return null;

  const angles = dimensions.map((_, i) => (360 / count) * i);

  const buildPolygonPoints = (ratios: number[]) =>
    ratios
      .map((ratio, i) => {
        const [x, y] = polarToCartesian(angles[i], RADIUS * Math.max(0.05, Math.min(1, ratio)));
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const speakerRatios = dimensions.map((d) => d.score / 100);
  const speakerPoints = buildPolygonPoints(speakerRatios);
  const avgPoints =
    teamAverageScores && teamAverageScores.length === count
      ? buildPolygonPoints(teamAverageScores.map((s) => s / 100))
      : null;

  const currentIdx = lockedIdx !== null ? lockedIdx : hoveredIdx;
  const activeDim = currentIdx !== null ? dimensions[currentIdx] : null;

  return (
    <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-100">五维语言习惯健康度雷达</span>
          <span className="px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-500/35 text-blue-300 font-mono text-[10px]">
            综合 {overallScore} 分
          </span>
        </div>
        {avgPoints && (
          <div className="flex items-center gap-2 text-[10px] text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <span
                className="w-2.5 h-0.5 rounded-full inline-block"
                style={{ backgroundColor: color }}
              />
              {speakerName}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-0 border-t border-dashed border-zinc-400 inline-block" />
              全员均值
            </span>
          </div>
        )}
      </div>

      <svg
        viewBox="0 0 320 256"
        className="w-full max-w-[320px] mx-auto block select-none overflow-visible"
      >
        {/* Concentric pentagon grid */}
        {GRID_LEVELS.map((lvl) => (
          <polygon
            key={lvl}
            points={buildPolygonPoints(angles.map(() => lvl))}
            fill="none"
            stroke="#27272a"
            strokeWidth={1}
          />
        ))}

        {/* Radial axes */}
        {angles.map((angle, i) => {
          const [x, y] = polarToCartesian(angle, RADIUS);
          return (
            <line
              key={dimensions[i].key}
              x1={CX}
              y1={CY}
              x2={x}
              y2={y}
              stroke="#3f3f46"
              strokeWidth={0.9}
              strokeDasharray="2 2"
            />
          );
        })}

        {/* Team average comparison polygon */}
        {avgPoints && (
          <polygon
            points={avgPoints}
            fill="none"
            stroke="#a1a1aa"
            strokeWidth={1.2}
            strokeDasharray="4 3"
            opacity={0.7}
          />
        )}

        {/* Active speaker polygon */}
        <polygon
          points={speakerPoints}
          fill={color}
          fillOpacity={0.26}
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* Vertex dots */}
        {dimensions.map((d, i) => {
          const [vx, vy] = polarToCartesian(angles[i], RADIUS * (d.score / 100));
          const isHov = currentIdx === i;
          return (
            <circle
              key={d.key}
              cx={vx}
              cy={vy}
              r={isHov ? 4.5 : 3.2}
              fill={color}
              stroke="#09090b"
              strokeWidth={1.2}
              className="cursor-pointer transition-all"
              onClick={() => setLockedIdx(lockedIdx === i ? null : i)}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          );
        })}

        {/* Axis labels + scores */}
        {dimensions.map((d, i) => {
          const angle = angles[i];
          const [lx, ly] = polarToCartesian(angle, RADIUS + 24);
          const textAnchor =
            Math.abs(lx - CX) < 12 ? 'middle' : lx > CX ? 'start' : 'end';
          const dyBase = ly < CY - 20 ? -2 : ly > CY + 20 ? 8 : 2;
          const isHov = currentIdx === i;

          return (
            <g
              key={d.key}
              className="cursor-pointer"
              onClick={() => setLockedIdx(lockedIdx === i ? null : i)}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <text
                x={lx}
                y={ly + dyBase}
                textAnchor={textAnchor}
                fontSize={10.5}
                fontWeight={isHov ? 700 : 500}
                fill={isHov ? '#f4f4f5' : '#a1a1aa'}
              >
                {d.label}
              </text>
              <text
                x={lx}
                y={ly + dyBase + 13}
                textAnchor={textAnchor}
                fontSize={10.5}
                fontWeight={700}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fill={isHov ? color : '#e4e4e7'}
              >
                {d.score}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Dimension breakdown pills */}
      <div className="grid grid-cols-5 gap-1 pt-1 border-t border-zinc-800/80">
        {dimensions.map((d, i) => (
          <div
            key={d.key}
            onClick={() => setLockedIdx(lockedIdx === i ? null : i)}
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
            title={d.detail}
            className={`px-1.5 py-1 rounded-md text-center cursor-pointer transition ${
              currentIdx === i ? 'bg-zinc-800 ring-1 ring-zinc-700' : 'bg-zinc-950/60 hover:bg-zinc-800/60'
            }`}
          >
            <div className="text-[10px] text-zinc-400 truncate">{d.label}</div>
            <div className="text-xs font-mono font-bold text-zinc-100">{d.score}</div>
          </div>
        ))}
      </div>

      {activeDim && (
        <div className="px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-300 flex items-center justify-between gap-2">
          <span className="font-semibold text-zinc-100">{activeDim.label}</span>
          <span className="text-zinc-400">{activeDim.detail}</span>
        </div>
      )}
    </div>
  );
};
