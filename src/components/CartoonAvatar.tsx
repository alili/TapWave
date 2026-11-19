import React from 'react';
import { CartoonAvatarStyle } from '../types/podcast';

export const CARTOON_AVATAR_STYLES: Array<{
  id: CartoonAvatarStyle;
  label: string;
}> = [
  { id: 'mic', label: '播客麦霸' },
  { id: 'headphones', label: '声控达人' },
  { id: 'glasses', label: '思考学者' },
  { id: 'spark', label: '灵感闪光' },
  { id: 'cat', label: '萌系猫耳' },
  { id: 'astro', label: '星际极客' },
];

export const CARTOON_AVATAR_PALETTES = [
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#ef4444',
  '#6366f1',
];

interface CartoonAvatarProps {
  name: string;
  style: CartoonAvatarStyle;
  bgColor: string;
  customAvatarUrl?: string;
  size?: number;
  className?: string;
}

export const CartoonAvatar: React.FC<CartoonAvatarProps> = ({
  name,
  style,
  bgColor,
  customAvatarUrl,
  size = 56,
  className = '',
}) => {
  if (customAvatarUrl) {
    return (
      <img
        src={customAvatarUrl}
        alt={name}
        style={{ width: size, height: size }}
        className={`rounded-full object-cover border-2 border-white/20 shadow-md shrink-0 ${className}`}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      className={`rounded-full shrink-0 shadow-md border-2 border-white/20 ${className}`}
      aria-label={`${name} 卡通头像`}
    >
      <defs>
        <linearGradient id={`bg_${style}_${bgColor.replace('#', '')}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={bgColor} />
          <stop offset="100%" stopColor="#18181b" stopOpacity="0.45" />
        </linearGradient>
      </defs>

      {/* 背景圆 */}
      <circle cx="40" cy="40" r="40" fill={bgColor} />
      <circle cx="40" cy="40" r="40" fill={`url(#bg_${style}_${bgColor.replace('#', '')})`} opacity="0.45" />
      <circle cx="24" cy="20" r="14" fill="#ffffff" opacity="0.12" />

      {/* 猫耳或宇航员头盔外框 */}
      {style === 'cat' && (
        <>
          <polygon points="18,30 22,10 35,22" fill="#fde68a" stroke="#1f2937" strokeWidth="2.2" strokeLinejoin="round" />
          <polygon points="62,30 58,10 45,22" fill="#fde68a" stroke="#1f2937" strokeWidth="2.2" strokeLinejoin="round" />
          <polygon points="21,26 24,14 31,21" fill="#fb7185" />
          <polygon points="59,26 56,14 49,21" fill="#fb7185" />
        </>
      )}

      {style === 'astro' && (
        <circle cx="40" cy="40" r="28" fill="none" stroke="#e0f2fe" strokeWidth="3.5" opacity="0.9" />
      )}

      {/* 身体肩膀 */}
      <path d="M18 76 C18 59, 62 59, 62 76" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />

      {/* 头部 */}
      <circle cx="40" cy="41" r="20" fill="#fde68a" stroke="#1f2937" strokeWidth="2.2" />

      {/* 头发/刘海 */}
      <path
        d="M20 38 C20 22, 60 22, 60 38 C55 30, 48 28, 40 28 C32 28, 25 30, 20 38 Z"
        fill="#1f2937"
      />

      {/* 眼睛 & 腮红 */}
      <circle cx="32.5" cy="41" r="2.7" fill="#1f2937" />
      <circle cx="47.5" cy="41" r="2.7" fill="#1f2937" />
      <circle cx="33.5" cy="40" r="0.9" fill="#ffffff" />
      <circle cx="48.5" cy="40" r="0.9" fill="#ffffff" />
      <ellipse cx="27" cy="46" rx="3.2" ry="1.8" fill="#fb7185" opacity="0.55" />
      <ellipse cx="53" cy="46" rx="3.2" ry="1.8" fill="#fb7185" opacity="0.55" />

      {/* 微笑嘴巴 */}
      <path d="M35 49 Q40 54 45 49" fill="none" stroke="#1f2937" strokeWidth="2.2" strokeLinecap="round" />

      {/* 风格配饰 */}
      {style === 'glasses' && (
        <g stroke="#111827" strokeWidth="2.2" fill="#ffffff" fillOpacity="0.22">
          <rect x="24.5" y="36" width="13" height="10" rx="3.5" />
          <rect x="42.5" y="36" width="13" height="10" rx="3.5" />
          <line x1="37.5" y1="40.5" x2="42.5" y2="40.5" />
        </g>
      )}

      {style === 'headphones' && (
        <g>
          <path d="M18 41 C18 22, 62 22, 62 41" fill="none" stroke="#f8fafc" strokeWidth="4.5" strokeLinecap="round" />
          <rect x="14" y="34" width="7" height="15" rx="3.5" fill="#0f172a" stroke="#f8fafc" strokeWidth="1.8" />
          <rect x="59" y="34" width="7" height="15" rx="3.5" fill="#0f172a" stroke="#f8fafc" strokeWidth="1.8" />
        </g>
      )}

      {style === 'mic' && (
        <g>
          <rect x="36" y="57" width="8" height="11" rx="4" fill="#e2e8f0" stroke="#0f172a" strokeWidth="1.8" />
          <line x1="40" y1="68" x2="40" y2="75" stroke="#94a3b8" strokeWidth="2.2" />
        </g>
      )}

      {style === 'spark' && (
        <g fill="#fef08a" stroke="#ca8a04" strokeWidth="1">
          <polygon points="62,14 64,20 70,22 64,24 62,30 60,24 54,22 60,20" />
          <circle cx="17" cy="20" r="2.2" />
        </g>
      )}
    </svg>
  );
};
