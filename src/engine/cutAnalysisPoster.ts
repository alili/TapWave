import { CutAnalysisReport } from './cutAnalysisEngine';
import { formatMmSs } from './timelineEngine';

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(current);
      current = '';
      continue;
    }
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * 将「剪辑分析报告与嘉宾表达建议」渲染为高清 PNG DataURL，用于一键导出分析图片。
 */
export async function renderCutAnalysisReportImageDataUrl(
  report: CutAnalysisReport
): Promise<string> {
  const W = 1080;
  const PAD = 56;
  const CONTENT_W = W - PAD * 2;

  // Measure height first using an offscreen canvas context
  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = W;
  measureCanvas.height = 400;
  const mctx = measureCanvas.getContext('2d');
  if (!mctx) throw new Error('Canvas 2D context unavailable');

  mctx.font = '400 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';

  // Calculate dynamic height
  let totalH = 60; // top pad
  totalH += 140; // header
  totalH += 160; // 4 KPI cards
  totalH += 24;

  // Category distribution card
  const catRows = Math.max(1, report.categoryStats.length);
  totalH += 76 + catRows * 42 + 24;

  // Style summary card
  let summaryLinesCount = 0;
  for (const s of report.editingStyleSummary) {
    summaryLinesCount += wrapLines(mctx, `• ${s}`, CONTENT_W - 64).length;
  }
  totalH += 72 + Math.max(1, summaryLinesCount) * 32 + 28;

  // Speaker expression suggestion cards
  totalH += 44; // section header
  const speakerCardHeights: number[] = [];
  for (const sp of report.speakerSuggestions) {
    let ch = 148; // speaker header + metrics row + category pills
    for (const st of sp.strengths) {
      ch += wrapLines(mctx, `✓ ${st}`, CONTENT_W - 72).length * 29 + 6;
    }
    for (const sg of sp.suggestions) {
      ch += wrapLines(mctx, `→ ${sg}`, CONTENT_W - 72).length * 29 + 6;
    }
    ch += 28;
    speakerCardHeights.push(ch);
    totalH += ch + 20;
  }

  totalH += 72; // footer

  const H = Math.max(920, totalH);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#09090b');
  bg.addColorStop(0.5, '#111116');
  bg.addColorStop(1, '#09090b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle decorative glow
  const glow = ctx.createRadialGradient(W * 0.85, 110, 20, W * 0.85, 110, 420);
  glow.addColorStop(0, 'rgba(59, 130, 246, 0.16)');
  glow.addColorStop(1, 'rgba(59, 130, 246, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 540);

  let y = 60;

  // Header
  ctx.fillStyle = '#60a5fa';
  ctx.font = '600 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('TAPWAVE · 剪辑分析与嘉宾表达诊断报告', PAD, y);
  y += 42;

  ctx.fillStyle = '#fafafa';
  ctx.font = '700 36px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const titleText =
    report.projectTitle.length > 24
      ? `${report.projectTitle.slice(0, 24)}…`
      : report.projectTitle;
  ctx.fillText(titleText, PAD, y);
  y += 34;

  ctx.fillStyle = '#a1a1aa';
  ctx.font = '400 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const dateStr = new Date(report.generatedAt).toLocaleString('zh-CN', {
    hour12: false,
  });
  ctx.fillText(`生成时间：${dateStr}`, PAD, y);
  y += 42;

  // 4 KPI Cards
  const gap = 16;
  const cardW = (CONTENT_W - gap * 3) / 4;
  const kpis = [
    {
      label: '原始总时长',
      val: formatMmSs(report.originalDurationSec),
      color: '#e4e4e7',
    },
    {
      label: '精剪成片时长',
      val: formatMmSs(report.editedDurationSec),
      color: '#34d399',
    },
    {
      label: '累计精简时长',
      val: `${report.savedDurationSec.toFixed(1)}s`,
      color: '#60a5fa',
    },
    {
      label: '剪辑处 / 压缩率',
      val: `${report.totalCutCount}处 · ${report.compressionRatioPct}%`,
      color: '#fbbf24',
    },
  ];
  kpis.forEach((k, idx) => {
    const cx = PAD + idx * (cardW + gap);
    ctx.fillStyle = '#18181b';
    drawRoundRect(ctx, cx, y, cardW, 118, 16);
    ctx.fill();
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#a1a1aa';
    ctx.font = '500 17px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(k.label, cx + 20, y + 38);

    ctx.fillStyle = k.color;
    ctx.font = '700 28px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(k.val, cx + 20, y + 86);
  });
  y += 144;

  // Category Distribution Card
  const catCardH = 76 + Math.max(1, report.categoryStats.length) * 42;
  ctx.fillStyle = '#18181b';
  drawRoundRect(ctx, PAD, y, CONTENT_W, catCardH, 18);
  ctx.fill();
  ctx.strokeStyle = '#27272a';
  ctx.stroke();

  ctx.fillStyle = '#f4f4f5';
  ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('剪辑类型分布（去掉的空白 / 文字 / 静音）', PAD + 26, y + 42);

  if (report.categoryStats.length === 0) {
    ctx.fillStyle = '#71717a';
    ctx.font = '400 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('暂无剪辑处记录', PAD + 26, y + 86);
  } else {
    const maxSaved = Math.max(
      0.1,
      ...report.categoryStats.map((s) => s.savedSec)
    );
    const barColors: Record<string, string> = {
      silence: '#a855f7',
      filler: '#f59e0b',
      pause_tighten: '#06b6d4',
      waveform_cut: '#10b981',
      manual_delete: '#ef4444',
      track_mute: '#71717a',
    };
    report.categoryStats.forEach((st, idx) => {
      const ry = y + 72 + idx * 42;
      ctx.fillStyle = '#d4d4d8';
      ctx.font = '500 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(`${st.label}`, PAD + 26, ry + 18);

      const barX = PAD + 210;
      const barMaxW = CONTENT_W - 410;
      const barW = Math.max(12, (st.savedSec / maxSaved) * barMaxW);

      ctx.fillStyle = '#27272a';
      drawRoundRect(ctx, barX, ry + 4, barMaxW, 18, 9);
      ctx.fill();

      ctx.fillStyle = barColors[st.category] || '#3b82f6';
      drawRoundRect(ctx, barX, ry + 4, barW, 18, 9);
      ctx.fill();

      ctx.fillStyle = '#a1a1aa';
      ctx.font = '500 17px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(
        `${st.count} 处 · ${st.savedSec.toFixed(1)}s`,
        barX + barMaxW + 18,
        ry + 18
      );
    });
  }
  y += catCardH + 24;

  // Editing style summary
  let sumLines: string[] = [];
  ctx.font = '400 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  for (const s of report.editingStyleSummary) {
    sumLines = sumLines.concat(wrapLines(ctx, `• ${s}`, CONTENT_W - 64));
  }
  const sumCardH = 72 + Math.max(1, sumLines.length) * 32;
  ctx.fillStyle = '#18181b';
  drawRoundRect(ctx, PAD, y, CONTENT_W, sumCardH, 18);
  ctx.fill();
  ctx.strokeStyle = '#27272a';
  ctx.stroke();

  ctx.fillStyle = '#f4f4f5';
  ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('剪辑风格与节奏总结', PAD + 26, y + 42);

  ctx.fillStyle = '#d4d4d8';
  ctx.font = '400 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  sumLines.forEach((line, idx) => {
    ctx.fillText(line, PAD + 26, y + 78 + idx * 32);
  });
  y += sumCardH + 34;

  // Speaker Expression Suggestions
  ctx.fillStyle = '#f4f4f5';
  ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('嘉宾与主播表达建议', PAD, y);
  y += 22;

  report.speakerSuggestions.forEach((sp, idx) => {
    const ch = speakerCardHeights[idx] ?? 220;
    ctx.fillStyle = '#18181b';
    drawRoundRect(ctx, PAD, y, CONTENT_W, ch, 18);
    ctx.fill();
    ctx.strokeStyle = '#27272a';
    ctx.stroke();

    // Left accent bar
    ctx.fillStyle = sp.color || '#3b82f6';
    drawRoundRect(ctx, PAD, y, 8, ch, 4);
    ctx.fill();

    // Speaker header
    ctx.fillStyle = '#fafafa';
    ctx.font = '700 23px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(`${sp.speakerName}（${sp.roleLabel}）`, PAD + 28, y + 42);

    ctx.fillStyle = '#60a5fa';
    ctx.font = '600 18px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(
      `有效发言 ${formatMmSs(sp.speakingSec)} · ${sp.avgCpm}字/分 · 剪除 ${sp.cutCount}处 (${sp.cutRatioPct}%)`,
      PAD + 28,
      y + 74
    );

    // Category breakdown pills (objective data only)
    let dx = PAD + 28;
    const dy = y + 96;
    ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    sp.categoryBreakdown.forEach((b) => {
      const txt = `${b.label} ${b.count}处·${b.savedSec.toFixed(1)}s`;
      const tw = ctx.measureText(txt).width + 20;
      if (dx + tw > PAD + CONTENT_W - 20) return;
      ctx.fillStyle = '#27272a';
      drawRoundRect(ctx, dx, dy, tw, 28, 8);
      ctx.fill();
      ctx.fillStyle = '#d4d4d8';
      ctx.fillText(txt, dx + 10, dy + 19);
      dx += tw + 10;
    });

    let lineY = y + 148;
    ctx.font = '400 19px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    for (const st of sp.strengths) {
      const lines = wrapLines(ctx, `✓ ${st}`, CONTENT_W - 72);
      ctx.fillStyle = '#34d399';
      for (const l of lines) {
        ctx.fillText(l, PAD + 28, lineY);
        lineY += 29;
      }
      lineY += 6;
    }
    for (const sg of sp.suggestions) {
      const lines = wrapLines(ctx, `→ ${sg}`, CONTENT_W - 72);
      ctx.fillStyle = '#fde68a';
      for (const l of lines) {
        ctx.fillText(l, PAD + 28, lineY);
        lineY += 29;
      }
      lineY += 6;
    }

    y += ch + 20;
  });

  // Footer
  ctx.fillStyle = '#71717a';
  ctx.font = '400 16px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('Generated by 点波 TapWave · 播客精剪与表达教练', PAD, H - 32);

  return canvas.toDataURL('image/png');
}
