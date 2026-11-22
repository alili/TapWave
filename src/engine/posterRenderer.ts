import {
  PodcastShownotes,
  PosterTheme,
  ShownotesGuest,
} from '../types/podcast';
import { DRAW_CONDITION_LABELS } from './shownotesGenerator';

export const POSTER_THEME_OPTIONS: Array<{
  id: PosterTheme;
  label: string;
  previewBg: string;
}> = [
  { id: 'amber_studio', label: '暖金录影棚', previewBg: '#1c1917' },
  { id: 'midnight_neon', label: '午夜霓虹', previewBg: '#090d1f' },
  { id: 'emerald_fresh', label: '翡翠清新', previewBg: '#062621' },
  { id: 'editorial_cream', label: '杂志米白', previewBg: '#f6f1e7' },
];

interface ThemePalette {
  bgTop: string;
  bgBottom: string;
  cardBg: string;
  cardBorder: string;
  accent: string;
  accentSoft: string;
  textPrimary: string;
  textSecondary: string;
  badgeText: string;
  isLight: boolean;
}

const THEME_PALETTES: Record<PosterTheme, ThemePalette> = {
  amber_studio: {
    bgTop: '#1c1917',
    bgBottom: '#292018',
    cardBg: 'rgba(255,255,255,0.06)',
    cardBorder: 'rgba(245,158,11,0.32)',
    accent: '#f59e0b',
    accentSoft: 'rgba(245,158,11,0.16)',
    textPrimary: '#fafaf9',
    textSecondary: '#d6d3d1',
    badgeText: '#1c1917',
    isLight: false,
  },
  midnight_neon: {
    bgTop: '#090d1f',
    bgBottom: '#15193b',
    cardBg: 'rgba(255,255,255,0.06)',
    cardBorder: 'rgba(99,102,241,0.38)',
    accent: '#60a5fa',
    accentSoft: 'rgba(96,165,250,0.18)',
    textPrimary: '#f8fafc',
    textSecondary: '#cbd5e1',
    badgeText: '#090d1f',
    isLight: false,
  },
  emerald_fresh: {
    bgTop: '#062621',
    bgBottom: '#0b3830',
    cardBg: 'rgba(255,255,255,0.07)',
    cardBorder: 'rgba(52,211,153,0.34)',
    accent: '#34d399',
    accentSoft: 'rgba(52,211,153,0.16)',
    textPrimary: '#ecfdf5',
    textSecondary: '#a7f3d0',
    badgeText: '#062621',
    isLight: false,
  },
  editorial_cream: {
    bgTop: '#f6f1e7',
    bgBottom: '#ede4d3',
    cardBg: 'rgba(255,255,255,0.82)',
    cardBorder: 'rgba(180,83,9,0.25)',
    accent: '#c2410c',
    accentSoft: 'rgba(194,65,12,0.12)',
    textPrimary: '#1c1917',
    textSecondary: '#57534e',
    badgeText: '#ffffff',
    isLight: true,
  },
};

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text.replace(/\n+/g, ' ')) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
      if (lines.length >= maxLines) break;
    } else {
      current = test;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  } else if (lines.length === maxLines && current) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.slice(0, Math.max(1, last.length - 1)) + '…';
  }
  return lines;
}

function drawInitialAvatar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  name: string,
  bgColor: string
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = bgColor || '#3b82f6';
  ctx.fill();

  const initial = (name || '?').trim().slice(0, 1).toUpperCase();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(radius * 0.82)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initial, cx, cy + 1);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function drawGuestAvatar(
  ctx: CanvasRenderingContext2D,
  guest: ShownotesGuest,
  cx: number,
  cy: number,
  radius: number
) {
  if (guest.customAvatarUrl) {
    const img = await loadImage(guest.customAvatarUrl);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - radius, cy - radius, radius * 2, radius * 2);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
  }
  drawInitialAvatar(ctx, cx, cy, radius, guest.name, guest.avatarBgColor);
}

/**
 * 在 HTML5 Canvas 上渲染 900x1260 高清播客活动 & 抽奖海报，返回 PNG DataURL。
 */
export async function renderActivityPosterDataUrl(
  shownotes: PodcastShownotes
): Promise<string> {
  const W = 900;
  const H = 1260;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法初始化 Canvas 2D 上下文');
  }

  const palette = THEME_PALETTES[shownotes.activity.posterTheme] ?? THEME_PALETTES.amber_studio;

  // 背景渐变
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, palette.bgTop);
  grad.addColorStop(1, palette.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // 装饰光晕圆
  ctx.fillStyle = palette.accentSoft;
  ctx.beginPath();
  ctx.arc(W - 90, 120, 220, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(100, H - 140, 180, 0, Math.PI * 2);
  ctx.fill();

  const padX = 56;
  const contentW = W - padX * 2;
  let y = 56;

  // 顶部徽章
  ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const badgeText = 'PODCRAFT STUDIO · 播客特别企划';
  const badgeW = ctx.measureText(badgeText).width + 36;
  ctx.fillStyle = palette.accent;
  drawRoundRect(ctx, padX, y, badgeW, 38, 19);
  ctx.fill();
  ctx.fillStyle = palette.badgeText;
  ctx.fillText(badgeText, padX + 18, y + 26);

  y += 66;

  // 单集标题
  ctx.fillStyle = palette.textPrimary;
  ctx.font = 'bold 42px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const titleLines = wrapTextLines(ctx, shownotes.episodeTitle || '播客单集', contentW, 2);
  for (const line of titleLines) {
    ctx.fillText(line, padX, y + 36);
    y += 52;
  }

  // 海报标语
  if (shownotes.activity.posterSlogan.trim()) {
    y += 6;
    ctx.fillStyle = palette.accent;
    ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const sloganLines = wrapTextLines(ctx, shownotes.activity.posterSlogan, contentW, 2);
    for (const line of sloganLines) {
      ctx.fillText(line, padX, y + 22);
      y += 32;
    }
  }

  y += 22;

  // 嘉宾阵容卡片
  const guestsToShow = shownotes.guests.slice(0, 4);
  if (guestsToShow.length > 0) {
    const guestCardH = 168;
    ctx.fillStyle = palette.cardBg;
    ctx.strokeStyle = palette.cardBorder;
    ctx.lineWidth = 1.5;
    drawRoundRect(ctx, padX, y, contentW, guestCardH, 20);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = palette.accent;
    ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('本期主创 & 嘉宾阵容', padX + 24, y + 32);

    const colW = (contentW - 48) / guestsToShow.length;
    for (let i = 0; i < guestsToShow.length; i++) {
      const g = guestsToShow[i];
      const cx = padX + 24 + colW * i + colW / 2;
      const cy = y + 84;
      await drawGuestAvatar(ctx, g, cx, cy, 32);

      ctx.textAlign = 'center';
      ctx.fillStyle = palette.textPrimary;
      ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(g.name.slice(0, 10), cx, y + 136);

      ctx.fillStyle = palette.textSecondary;
      ctx.font = '14px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText((g.socialAccount || g.roleLabel).slice(0, 14), cx, y + 156);
    }
    ctx.textAlign = 'left';
    y += guestCardH + 22;
  }

  // 活动信息卡片
  const actCardH = 196;
  ctx.fillStyle = palette.cardBg;
  ctx.strokeStyle = palette.cardBorder;
  ctx.lineWidth = 1.5;
  drawRoundRect(ctx, padX, y, contentW, actCardH, 20);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = palette.accent;
  ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('活动信息', padX + 24, y + 34);

  ctx.fillStyle = palette.textPrimary;
  ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const actTitleLines = wrapTextLines(ctx, shownotes.activity.title, contentW - 48, 1);
  ctx.fillText(actTitleLines[0] || '', padX + 24, y + 70);

  ctx.fillStyle = palette.textSecondary;
  ctx.font = '18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const actDescLines = wrapTextLines(ctx, shownotes.activity.description, contentW - 48, 2);
  actDescLines.forEach((line, idx) => {
    ctx.fillText(line, padX + 24, y + 104 + idx * 26);
  });

  ctx.fillStyle = palette.textPrimary;
  ctx.font = '600 17px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText(
    `时间：${shownotes.activity.eventTime}   ｜   平台：${shownotes.activity.locationOrPlatform}`,
    padX + 24,
    y + 172
  );

  y += actCardH + 22;

  // 抽奖规则高亮卡片
  const lt = shownotes.activity.lottery;
  const lotteryCardH = lt.enabled ? 280 : 120;
  ctx.fillStyle = palette.accentSoft;
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  drawRoundRect(ctx, padX, y, contentW, lotteryCardH, 22);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = palette.accent;
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText(lt.enabled ? '🎁 互动抽奖规则' : '💬 互动邀请', padX + 26, y + 40);

  if (lt.enabled) {
    ctx.fillStyle = palette.textPrimary;
    ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(`奖品：${lt.prizeName}（共 ${lt.winnerCount} 名）`, padX + 26, y + 82);

    ctx.fillStyle = palette.textSecondary;
    ctx.font = '19px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(`抽奖条件：${DRAW_CONDITION_LABELS[lt.drawCondition]}`, padX + 26, y + 120);

    const methodLines = wrapTextLines(
      ctx,
      `参与方式：${lt.participationMethod}`,
      contentW - 52,
      2
    );
    methodLines.forEach((line, idx) => {
      ctx.fillText(line, padX + 26, y + 154 + idx * 28);
    });

    let ruleBottomY = y + 218;
    if (lt.drawCondition === 'keyword_reply' && lt.keyword?.trim()) {
      ctx.fillStyle = palette.accent;
      ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(`互动暗号：「${lt.keyword.trim()}」`, padX + 26, ruleBottomY);
      ruleBottomY += 30;
    }

    ctx.fillStyle = palette.textPrimary;
    ctx.font = '600 17px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(
      `开奖时间：${lt.deadline}  ·  公布：${lt.announcementChannel}`,
      padX + 26,
      Math.min(y + lotteryCardH - 22, ruleBottomY)
    );
  } else {
    ctx.fillStyle = palette.textSecondary;
    ctx.font = '19px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('欢迎订阅播客并在评论区留下你的收听感受，期待与你交流！', padX + 26, y + 80);
  }

  y += lotteryCardH + 22;

  // 听友福利摘要
  if (shownotes.benefits.length > 0 && y < H - 150) {
    const benH = 92;
    ctx.fillStyle = palette.cardBg;
    ctx.strokeStyle = palette.cardBorder;
    ctx.lineWidth = 1.5;
    drawRoundRect(ctx, padX, y, contentW, benH, 16);
    ctx.fill();
    ctx.stroke();

    const firstBen = shownotes.benefits[0];
    let textMaxW = contentW - 44;
    if (firstBen.imageUrl) {
      const benImg = await loadImage(firstBen.imageUrl);
      if (benImg) {
        const imgSize = 68;
        const imgX = padX + contentW - imgSize - 14;
        const imgY = y + (benH - imgSize) / 2;
        ctx.save();
        drawRoundRect(ctx, imgX, imgY, imgSize, imgSize, 10);
        ctx.clip();
        ctx.drawImage(benImg, imgX, imgY, imgSize, imgSize);
        ctx.restore();
        textMaxW = contentW - 44 - imgSize - 16;
      }
    }

    ctx.fillStyle = palette.accent;
    ctx.font = 'bold 17px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(`听友福利：${firstBen.title}`, padX + 22, y + 36);

    ctx.fillStyle = palette.textSecondary;
    ctx.font = '16px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const benDesc = wrapTextLines(
      ctx,
      `${firstBen.codeOrLink ? `[${firstBen.codeOrLink}] ` : ''}${firstBen.description}`,
      textMaxW,
      1
    );
    ctx.fillText(benDesc[0] || '', padX + 22, y + 68);
  }

  // 底部品牌栏
  ctx.fillStyle = palette.textSecondary;
  ctx.font = '15px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('由 点波 TapWave AI 播客工作站生成 · 收听完整节目获取更多精彩', padX, H - 36);

  return canvas.toDataURL('image/png');
}
