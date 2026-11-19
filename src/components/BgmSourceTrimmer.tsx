import React, { useEffect, useRef, useState } from 'react';
import { Scissors } from 'lucide-react';
import { BgmTrackAsset } from '../types/podcast';

interface BgmSourceTrimmerProps {
  label: string;
  accentColor?: 'cyan' | 'emerald';
  asset: BgmTrackAsset | null | undefined;
  resolvedDurationSec?: number;
  durationMultiplier?: number;
  onChangeSlice: (patch: { sourceStartSec: number; sourceEndSec: number }) => void;
  onApplyDuration?: (targetDurSec: number) => void;
}

export const BgmSourceTrimmer: React.FC<BgmSourceTrimmerProps> = ({
  label,
  accentColor = 'cyan',
  asset,
  resolvedDurationSec,
  durationMultiplier = 1,
  onChangeSlice,
  onApplyDuration,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dragMode, setDragMode] = useState<
    null | { kind: 'left' | 'right' | 'window'; startX: number; origStart: number; origEnd: number }
  >(null);

  const totalDurSec = Math.max(
    1,
    resolvedDurationSec && resolvedDurationSec > 0
      ? resolvedDurationSec
      : asset?.durationSec && asset.durationSec > 0
      ? asset.durationSec
      : 30
  );
  const sliceStart = Math.max(0, Math.min(totalDurSec - 0.5, asset?.sourceStartSec ?? 0));
  const sliceEnd = Math.max(
    sliceStart + 0.5,
    Math.min(totalDurSec, asset?.sourceEndSec ?? totalDurSec)
  );
  const sliceDur = Math.max(0.5, sliceEnd - sliceStart);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const peaks = asset?.peaks ?? [];
    const yMid = H / 2;
    const maxAmp = Math.max(3, H * 0.42);
    const baseHex = accentColor === 'emerald' ? 'rgba(52, 211, 153, 0.55)' : 'rgba(34, 211, 238, 0.55)';
    ctx.strokeStyle = baseHex;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x += 2) {
      const ratio = x / W;
      let amp = 0.25;
      if (peaks.length > 0) {
        const idx = Math.min(peaks.length - 1, Math.floor(ratio * peaks.length));
        amp = Math.max(0.06, Math.min(1, peaks[idx] ?? 0.2));
      } else {
        amp = 0.28 + 0.22 * Math.abs(Math.sin(ratio * 28));
      }
      const px = amp * maxAmp;
      ctx.moveTo(x + 0.5, yMid - px);
      ctx.lineTo(x + 0.5, yMid + px);
    }
    ctx.stroke();
    ctx.restore();
  }, [asset?.peaks, accentColor, sliceStart, sliceEnd]);

  useEffect(() => {
    if (!dragMode) return;
    const onMove = (e: PointerEvent) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dxSec = ((e.clientX - dragMode.startX) / Math.max(1, rect.width)) * totalDurSec;
      if (dragMode.kind === 'left') {
        const nextStart = Math.max(
          0,
          Math.min(dragMode.origEnd - 0.5, Number((dragMode.origStart + dxSec).toFixed(1)))
        );
        onChangeSlice({ sourceStartSec: nextStart, sourceEndSec: dragMode.origEnd });
      } else if (dragMode.kind === 'right') {
        const nextEnd = Math.min(
          totalDurSec,
          Math.max(dragMode.origStart + 0.5, Number((dragMode.origEnd + dxSec).toFixed(1)))
        );
        onChangeSlice({ sourceStartSec: dragMode.origStart, sourceEndSec: nextEnd });
      } else {
        const span = dragMode.origEnd - dragMode.origStart;
        let nextStart = Number((dragMode.origStart + dxSec).toFixed(1));
        nextStart = Math.max(0, Math.min(totalDurSec - span, nextStart));
        onChangeSlice({
          sourceStartSec: nextStart,
          sourceEndSec: Number((nextStart + span).toFixed(1)),
        });
      }
    };
    const onUp = () => setDragMode(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragMode, totalDurSec, onChangeSlice]);

  if (!asset?.enabled || (!asset.filePath && !asset.audioUrl && !asset.fileName)) {
    return null;
  }

  const leftPct = (sliceStart / totalDurSec) * 100;
  const widthPct = Math.max(2, ((sliceEnd - sliceStart) / totalDurSec) * 100);
  const borderClass =
    accentColor === 'emerald' ? 'border-emerald-500/45 bg-emerald-500/15' : 'border-cyan-500/45 bg-cyan-500/15';
  const handleClass =
    accentColor === 'emerald' ? 'bg-emerald-400 hover:bg-emerald-300' : 'bg-cyan-400 hover:bg-cyan-300';

  return (
    <div className="shrink-0 rounded-xl border border-zinc-800/90 bg-zinc-900/60 px-3 py-2 flex flex-wrap items-center gap-3 text-[11px]">
      <div className="flex items-center gap-1.5 text-zinc-300 font-medium shrink-0">
        <Scissors className={`w-3.5 h-3.5 ${accentColor === 'emerald' ? 'text-emerald-400' : 'text-cyan-400'}`} />
        <span>{label}文件截取</span>
        <span className="text-[10px] text-zinc-500 truncate max-w-[140px]" title={asset.fileName}>
          ({asset.fileName})
        </span>
      </div>

      {/* Interactive full-file waveform slice bar */}
      <div
        ref={trackRef}
        className="relative flex-1 min-w-[200px] h-7 rounded-md bg-zinc-950 border border-zinc-800 overflow-hidden select-none"
        title="左右拖动边缘手柄截取 BGM 片段，或拖动选区平移"
      >
        <canvas ref={canvasRef} className="w-full h-full block pointer-events-none opacity-65" />
        {/* Dimmed unselected regions */}
        <div
          style={{ width: `${leftPct}%` }}
          className="absolute inset-y-0 left-0 bg-zinc-950/75 pointer-events-none"
        />
        <div
          style={{ left: `${leftPct + widthPct}%`, right: 0 }}
          className="absolute inset-y-0 bg-zinc-950/75 pointer-events-none"
        />
        {/* Active slice window */}
        <div
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            setDragMode({ kind: 'window', startX: e.clientX, origStart: sliceStart, origEnd: sliceEnd });
          }}
          className={`absolute inset-y-0 border-y border-x rounded-sm cursor-grab active:cursor-grabbing ${borderClass}`}
        >
          <div
            onPointerDown={(e) => {
              e.stopPropagation();
              setDragMode({ kind: 'left', startX: e.clientX, origStart: sliceStart, origEnd: sliceEnd });
            }}
            title="拖动调整 BGM 截取开始位置"
            className={`absolute left-0 inset-y-0 w-1.5 cursor-ew-resize ${handleClass}`}
          />
          <div
            onPointerDown={(e) => {
              e.stopPropagation();
              setDragMode({ kind: 'right', startX: e.clientX, origStart: sliceStart, origEnd: sliceEnd });
            }}
            title="拖动调整 BGM 截取结束位置"
            className={`absolute right-0 inset-y-0 w-1.5 cursor-ew-resize ${handleClass}`}
          />
        </div>
      </div>

      {/* Numeric Start / End editors */}
      <div className="flex items-center gap-2 shrink-0 text-[10.5px] font-mono">
        <label className="flex items-center gap-1 text-zinc-400">
          <span>开始</span>
          <input
            type="number"
            min={0}
            max={Number((sliceEnd - 0.5).toFixed(1))}
            step={0.1}
            value={Number(sliceStart.toFixed(1))}
            onChange={(e) => {
              const v = Math.max(0, Math.min(sliceEnd - 0.5, Number(e.target.value) || 0));
              onChangeSlice({ sourceStartSec: Number(v.toFixed(1)), sourceEndSec: sliceEnd });
            }}
            className="w-14 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-700 text-zinc-100 text-right"
          />
          <span>s</span>
        </label>
        <label className="flex items-center gap-1 text-zinc-400">
          <span>结束</span>
          <input
            type="number"
            min={Number((sliceStart + 0.5).toFixed(1))}
            max={Number(totalDurSec.toFixed(1))}
            step={0.1}
            value={Number(sliceEnd.toFixed(1))}
            onChange={(e) => {
              const v = Math.min(totalDurSec, Math.max(sliceStart + 0.5, Number(e.target.value) || totalDurSec));
              onChangeSlice({ sourceStartSec: sliceStart, sourceEndSec: Number(v.toFixed(1)) });
            }}
            className="w-14 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-700 text-zinc-100 text-right"
          />
          <span>s</span>
        </label>
        <span className="text-zinc-500">截取 {sliceDur.toFixed(1)}s</span>
        {onApplyDuration && (
          <button
            type="button"
            onClick={() => onApplyDuration(Number((sliceDur * durationMultiplier).toFixed(1)))}
            title={
              durationMultiplier !== 1
                ? `将 BGM 播放时长同步为截取长度的 ${durationMultiplier} 倍`
                : '将 BGM 播放时长同步为当前截取长度'
            }
            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer"
          >
            {durationMultiplier !== 1 ? `同步 ${durationMultiplier}x 时长` : '同步时长'}
          </button>
        )}
      </div>
    </div>
  );
};
