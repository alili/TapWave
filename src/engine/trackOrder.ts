/**
 * 音轨与导入文件顺序调整工具
 */

/**
 * 将数组中 fromIndex 位置的元素移动到 toIndex 位置，返回新数组。
 * 若索引越界或相等，直接返回原数组引用。
 */
export function reorderItems<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * 解析音轨对应的源音频显示文件名。
 */
export function resolveTrackDisplayFileName(filePath?: string, fallbackName?: string): string {
  if (fallbackName && /\.[a-z0-9]{2,5}$/i.test(fallbackName)) {
    return fallbackName;
  }
  if (filePath) {
    const base = filePath.split(/[/\\]/).pop();
    if (base) return base;
  }
  return fallbackName ? `${fallbackName}.wav` : '未命名音频';
}
