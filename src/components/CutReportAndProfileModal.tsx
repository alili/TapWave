import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  Download,
  FileJson,
  Image as ImageIcon,
  ListFilter,
  LocateFixed,
  RotateCcw,
  Scissors,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  UserCheck,
  X,
} from 'lucide-react';
import {
  buildEditingHabitProfileConfig,
  CutCategory,
  CutPointItem,
  generateCutAnalysisReport,
  PodcraftEditingHabitConfig,
} from '../engine/cutAnalysisEngine';
import { renderCutAnalysisReportImageDataUrl } from '../engine/cutAnalysisPoster';
import {
  openJsonConfigFileNative,
  savePngDataUrlFile,
  saveTextOrJsonFile,
} from '../engine/tauriBridge';
import { formatMmSs, TimelineComputation } from '../engine/timelineEngine';
import { PodcastProjectState } from '../types/podcast';

export type CutModalTab = 'cuts' | 'report' | 'profile';

interface CutReportAndProfileModalProps {
  open: boolean;
  initialTab?: CutModalTab;
  state: PodcastProjectState;
  timeline: TimelineComputation;
  cuts: CutPointItem[];
  onClose: () => void;
  onUndoCut: (cut: CutPointItem) => void;
  onSeekToSec: (sec: number) => void;
  onImportHabitConfig: (config: PodcraftEditingHabitConfig) => void;
  onNotify: (msg: string) => void;
}

const CATEGORY_BADGE_STYLE: Record<CutCategory, string> = {
  silence: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  filler: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  waveform_cut: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  manual_delete: 'bg-red-500/20 text-red-300 border-red-500/40',
  pause_tighten: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  track_mute: 'bg-zinc-700/60 text-zinc-300 border-zinc-600',
};

export const CutReportAndProfileModal: React.FC<CutReportAndProfileModalProps> = ({
  open,
  initialTab = 'cuts',
  state,
  timeline,
  cuts,
  onClose,
  onUndoCut,
  onSeekToSec,
  onImportHabitConfig,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<CutModalTab>(initialTab);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [speakerFilter, setSpeakerFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [exportingImage, setExportingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const report = useMemo(
    () => (open ? generateCutAnalysisReport(state, timeline, cuts) : null),
    [open, state, timeline, cuts]
  );

  const habitConfig = useMemo(
    () => (open ? buildEditingHabitProfileConfig(state, timeline, cuts) : null),
    [open, state, timeline, cuts]
  );

  const speakerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cuts) {
      map.set(c.speakerId, c.speakerName);
    }
    return Array.from(map.entries());
  }, [cuts]);

  const filteredCuts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return cuts.filter((c) => {
      if (categoryFilter !== 'all' && c.category !== categoryFilter) return false;
      if (speakerFilter !== 'all' && c.speakerId !== speakerFilter) return false;
      if (q) {
        const hay = `${c.summaryText} ${c.removedText} ${c.speakerName} ${c.reason} ${c.timeFormatted}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [cuts, categoryFilter, speakerFilter, searchQuery]);

  if (!open || !report || !habitConfig) return null;

  const safeProjectBase = (state.projectTitle || 'podcast')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .slice(0, 40);

  const handleExportReportImage = async () => {
    setExportingImage(true);
    try {
      const dataUrl = await renderCutAnalysisReportImageDataUrl(report);
      const saved = await savePngDataUrlFile(
        `${safeProjectBase}_剪辑分析报告.png`,
        dataUrl
      );
      if (saved) {
        onNotify(`🖼️ 已导出剪辑分析报告图片：${saved}`);
      }
    } catch (err) {
      onNotify(`导出分析图片失败：${String(err)}`);
    } finally {
      setExportingImage(false);
    }
  };

  const handleExportHabitConfig = async () => {
    try {
      const jsonStr = JSON.stringify(habitConfig, null, 2);
      const saved = await saveTextOrJsonFile(
        `${safeProjectBase}_剪辑习惯配置.podcraft-style.json`,
        jsonStr,
        'TapWave 剪辑习惯配置文件',
        ['json']
      );
      if (saved) {
        onNotify(`📄 已导出脱敏剪辑习惯配置文件：${saved}`);
      }
    } catch (err) {
      onNotify(`导出剪辑习惯配置失败：${String(err)}`);
    }
  };

  const handleParseAndApplyConfig = (rawJson: string) => {
    try {
      const parsed = JSON.parse(rawJson) as PodcraftEditingHabitConfig;
      onImportHabitConfig(parsed);
      onNotify(`✨ 已加载剪辑习惯配置「${parsed.profileName || '自定义风格'}」并应用自动化参数`);
    } catch (err) {
      onNotify(`加载剪辑习惯配置失败：${String(err)}`);
    }
  };

  const handleClickImportConfig = async () => {
    try {
      const nativeContent = await openJsonConfigFileNative();
      if (nativeContent !== null) {
        handleParseAndApplyConfig(nativeContent);
        return;
      }
    } catch (err) {
      onNotify(`读取配置文件失败：${String(err)}`);
      return;
    }
    fileInputRef.current?.click();
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl rounded-2xl border border-zinc-700/80 bg-zinc-900 shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-zinc-800 bg-zinc-950 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/35 flex items-center justify-center text-emerald-300">
              <Scissors className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <span>剪辑处总览 · 分析报告与习惯配置</span>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                  共 {cuts.length} 处 · 省 {report.savedDurationSec.toFixed(1)}s
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400">
                统一查看/撤销所有剪辑处，生成剪辑分析与嘉宾表达建议，导出报告图及脱敏剪辑习惯配置
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="px-5 pt-2.5 bg-zinc-950/60 border-b border-zinc-800 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('cuts')}
            className={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 cursor-pointer transition ${
              activeTab === 'cuts'
                ? 'border-emerald-400 text-emerald-300'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <ListFilter className="w-3.5 h-3.5" />
            <span>全部剪辑处 ({cuts.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('report')}
            className={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 cursor-pointer transition ${
              activeTab === 'report'
                ? 'border-blue-400 text-blue-300'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>剪辑分析报告 & 嘉宾表达建议</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 cursor-pointer transition ${
              activeTab === 'profile'
                ? 'border-purple-400 text-purple-300'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileJson className="w-3.5 h-3.5" />
            <span>剪辑习惯配置文件 (脱敏)</span>
          </button>
        </div>

        {/* Tab 1: All Cut Points */}
        {activeTab === 'cuts' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-5 py-3 border-b border-zinc-800 bg-zinc-900/70 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'all', label: `全部 (${cuts.length})` },
                  { id: 'silence', label: '空白切除' },
                  { id: 'filler', label: '口癖/卡壳' },
                  { id: 'pause_tighten', label: '停顿收紧' },
                  { id: 'waveform_cut', label: '波形精剪' },
                  { id: 'manual_delete', label: '文稿切除' },
                  { id: 'track_mute', label: '单轨静音' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setCategoryFilter(opt.id)}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer transition ${
                      categoryFilter === opt.id
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-zinc-800/80 text-zinc-400 border border-zinc-700/70 hover:text-zinc-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {speakerOptions.length > 1 && (
                  <select
                    value={speakerFilter}
                    onChange={(e) => setSpeakerFilter(e.target.value)}
                    className="px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-700 text-xs text-zinc-200"
                  >
                    <option value="all">全部发言人</option>
                    {speakerOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索去掉的文字/依据…"
                    className="pl-7 pr-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-700 text-xs text-zinc-200 w-44 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {filteredCuts.length === 0 ? (
                <div className="py-16 text-center text-xs text-zinc-500">
                  {cuts.length === 0
                    ? '当前工程暂无剪辑处记录'
                    : '当前筛选条件下没有匹配的剪辑处'}
                </div>
              ) : (
                filteredCuts.map((cut) => (
                  <div
                    key={cut.id}
                    className="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800 hover:border-zinc-700 transition flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => {
                            onSeekToSec(cut.editedSec);
                            onClose();
                          }}
                          className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-mono text-[11px] cursor-pointer"
                          title="点击跳转到此时间点"
                        >
                          {cut.timeFormatted}
                        </button>
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[10px] border ${
                            CATEGORY_BADGE_STYLE[cut.category]
                          }`}
                        >
                          {cut.categoryLabel}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-300 font-medium">
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: cut.speakerColor }}
                          />
                          {cut.speakerName}
                        </span>
                        <span className="text-[11px] font-mono text-emerald-300">
                          {cut.category === 'track_mute'
                            ? `静音 ${cut.removedDurationSec.toFixed(2)}s`
                            : `-${cut.removedDurationSec.toFixed(2)}s`}
                        </span>
                      </div>

                      <div className="text-xs text-zinc-200 break-words">
                        <span className="text-zinc-500 mr-1.5">去掉内容：</span>
                        <span className="text-red-200/95">{cut.summaryText}</span>
                      </div>

                      <div className="text-[11px] text-zinc-400">
                        <span className="text-zinc-500 mr-1">依据：</span>
                        {cut.reason}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          onSeekToSec(cut.editedSec);
                          onClose();
                        }}
                        className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] flex items-center gap-1 cursor-pointer"
                      >
                        <LocateFixed className="w-3 h-3" />
                        <span>定位</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onUndoCut(cut)}
                        className="px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 border border-emerald-500/40 text-[11px] font-medium flex items-center gap-1 cursor-pointer transition"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>撤销</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Analysis Report & Guest Expression Suggestions */}
        {activeTab === 'report' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* KPI Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <div className="text-[11px] text-zinc-400">原始总时长</div>
                  <div className="text-lg font-bold font-mono text-zinc-100 mt-1">
                    {formatMmSs(report.originalDurationSec)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <div className="text-[11px] text-zinc-400">精剪成片时长</div>
                  <div className="text-lg font-bold font-mono text-emerald-300 mt-1">
                    {formatMmSs(report.editedDurationSec)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <div className="text-[11px] text-zinc-400">累计精简时长</div>
                  <div className="text-lg font-bold font-mono text-blue-300 mt-1">
                    {report.savedDurationSec.toFixed(1)}s
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <div className="text-[11px] text-zinc-400">剪辑处 / 压缩率</div>
                  <div className="text-lg font-bold font-mono text-amber-300 mt-1">
                    {report.totalCutCount} 处 · {report.compressionRatioPct}%
                  </div>
                </div>
              </div>

              {/* Category Breakdown */}
              <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2.5">
                <h3 className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Scissors className="w-3.5 h-3.5 text-emerald-400" />
                  <span>剪辑分布明细</span>
                </h3>
                {report.categoryStats.length === 0 ? (
                  <p className="text-xs text-zinc-500">暂无剪辑数据</p>
                ) : (
                  <div className="space-y-2">
                    {report.categoryStats.map((st) => {
                      const maxSaved = Math.max(
                        0.1,
                        ...report.categoryStats.map((x) => x.savedSec)
                      );
                      const pct = Math.max(6, Math.round((st.savedSec / maxSaved) * 100));
                      return (
                        <div key={st.category} className="flex items-center gap-3 text-xs">
                          <span className="w-24 text-zinc-300 shrink-0">{st.label}</span>
                          <div className="flex-1 h-2.5 rounded-full bg-zinc-800 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-blue-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-28 text-right font-mono text-[11px] text-zinc-400 shrink-0">
                            {st.count} 处 · {st.savedSec.toFixed(1)}s
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Editing style summary */}
              <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1.5">
                <h3 className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>剪辑风格与节奏总结</span>
                </h3>
                {report.editingStyleSummary.map((line, i) => (
                  <p key={i} className="text-xs text-zinc-300 leading-relaxed">
                    • {line}
                  </p>
                ))}
              </div>

              {/* Guest / Speaker Expression Suggestions */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <UserCheck className="w-3.5 h-3.5 text-blue-400" />
                  <span>嘉宾与主播表达建议</span>
                </h3>
                {report.speakerSuggestions.map((sp) => (
                  <div
                    key={sp.speakerId}
                    className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2.5"
                    style={{ borderLeftWidth: 4, borderLeftColor: sp.color }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-zinc-100">
                          {sp.speakerName}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                          {sp.roleLabel}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] font-mono">
                        <span className="px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">
                          综合 {sp.overallScore} 分
                        </span>
                        <span className="text-zinc-400">{sp.avgCpm} 字/分</span>
                        <span className="text-zinc-400">
                          剪除 {sp.cutCount} 处 ({sp.cutRatioPct}%)
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {sp.dimensions.map((d) => (
                        <span
                          key={d.key}
                          className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300"
                        >
                          {d.label} <strong className="text-zinc-100">{d.score}</strong>
                        </span>
                      ))}
                    </div>

                    <div className="space-y-1 text-xs">
                      {sp.strengths.map((st, idx) => (
                        <div key={idx} className="text-emerald-300/90 flex items-start gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{st}</span>
                        </div>
                      ))}
                      {sp.suggestions.map((sg, idx) => (
                        <div key={idx} className="text-amber-200/90 flex items-start gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                          <span>{sg}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between">
              <span className="text-[11px] text-zinc-400">
                可一键导出高清长图用于播客复盘或发送给嘉宾参考
              </span>
              <button
                type="button"
                disabled={exportingImage}
                onClick={handleExportReportImage}
                className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                <span>{exportingImage ? '正在渲染图片…' : '导出分析报告图片 (PNG)'}</span>
              </button>
            </div>
          </div>
        )}

        {/* Tab 3: Privacy-Safe Editing Habit Profile Config */}
        {activeTab === 'profile' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Privacy Shield Banner */}
              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div className="text-xs text-emerald-200/95 space-y-0.5">
                  <div className="font-semibold text-emerald-200">
                    隐私安全保障：不含任何具体节目内容与身份隐私
                  </div>
                  <p className="text-[11px] text-emerald-200/80">
                    {habitConfig.privacyNotice}
                  </p>
                </div>
              </div>

              {/* Rationale Cards */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold text-zinc-200">
                  剪辑依据与自动化风格参数（{habitConfig.profileName}）
                </h3>
                {habitConfig.editingRationale.map((item) => (
                  <div
                    key={item.ruleKey}
                    className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-zinc-100">
                        {item.ruleName}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                        {item.observedEvidence}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      {item.rationale}
                    </p>
                    <div className="text-[11px] font-mono text-zinc-500">
                      参数：{item.parameterSummary}
                    </div>
                  </div>
                ))}
              </div>

              {/* Raw JSON Preview */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-zinc-300">
                  配置文件预览（.podcraft-style.json）
                </div>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300 overflow-x-auto max-h-56">
                  {JSON.stringify(habitConfig, null, 2)}
                </pre>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950 flex flex-wrap items-center justify-between gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    if (typeof reader.result === 'string') {
                      handleParseAndApplyConfig(reader.result);
                    }
                  };
                  reader.readAsText(file, 'utf-8');
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={handleClickImportConfig}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-400" />
                <span>加载剪辑习惯配置 (.json)</span>
              </button>

              <button
                type="button"
                onClick={handleExportHabitConfig}
                className="px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>导出剪辑习惯配置文件 (.json)</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
