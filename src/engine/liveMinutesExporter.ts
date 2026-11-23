import { LiveScenario, LiveSessionSnapshot } from '../types/liveSession';

export function formatLiveMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function scenarioMinutesTitle(scenario: LiveScenario): string {
  if (scenario === 'chat') return '聊天讨论纪要';
  if (scenario === 'sales') return '销售拜访纪要';
  if (scenario === 'dialogue') return '对谈纪要';
  if (scenario === 'listen') return '讲座/分享笔记';
  return '采访纪要';
}

function outlineStatusLabel(status: 'not_started' | 'partial' | 'covered'): string {
  if (status === 'covered') return '已覆盖';
  if (status === 'partial') return '部分提及';
  return '未提及';
}

export function buildLiveSessionMarkdown(snap: LiveSessionSnapshot): string {
  const speakerNameMap = new Map<string, string>();
  for (const s of snap.speakers) {
    speakerNameMap.set(s.id, s.name);
  }
  const lines: string[] = [];
  const docTitle = snap.title.trim() || '未命名录制';
  const engineLabel =
    snap.asrEngine === 'local_sensevoice'
      ? '本地离线识别 (SenseVoice + Silero VAD)'
      : snap.asrEngine === 'volcengine_sauc_bigmodel'
        ? '火山引擎流式语音识别'
        : snap.asrEngine || '未知';

  lines.push(`# ${scenarioMinutesTitle(snap.scenario)}：${docTitle}`, '');

  // 1. 基本信息
  lines.push('## 基本信息');
  lines.push(`- **日期**：${new Date().toLocaleDateString('zh-CN')}`);
  lines.push(`- **时长**：${formatLiveMmSs(snap.elapsedMs)}`);
  lines.push(
    `- **参与人**：${
      snap.speakers
        .map((s) => (s.inferredIdentity ? `${s.name}（${s.inferredIdentity}）` : s.name))
        .join('、') || '未设定'
    }`
  );
  lines.push(`- **话题**：${snap.prep?.topic?.trim() || '未填写'}`);
  lines.push(`- **识别引擎**：${engineLabel}`);
  if (snap.wavPath) {
    lines.push(`- **录音文件**：\`${snap.wavPath}\``);
  }
  lines.push('');

  // 2. 全场总结
  if (snap.finalSummary?.overview) {
    lines.push('## 全场总结', '', snap.finalSummary.overview, '');
  }

  // 3. 对方画像 / 讲者与内容提炼
  const isListen = snap.scenario === 'listen';
  lines.push(isListen ? '## 讲者与核心内容提炼' : '## 对方画像', '');
  lines.push(isListen ? '### 讲者与主题背景' : '### 背景');
  if (snap.profile.background.length > 0) {
    for (const item of snap.profile.background) {
      lines.push(`- [${formatLiveMmSs(item.evidenceMs)}] ${item.text}`);
    }
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  lines.push('### 故事与案例');
  if (snap.profile.stories.length > 0) {
    for (const item of snap.profile.stories) {
      lines.push(`- [${formatLiveMmSs(item.evidenceMs)}] **${item.title}**：${item.gist}`);
    }
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  lines.push('### 核心观点');
  if (snap.profile.viewpoints.length > 0) {
    for (const item of snap.profile.viewpoints) {
      const sup = item.support ? `（依据：${item.support}）` : '';
      lines.push(`- [${formatLiveMmSs(item.evidenceMs)}] ${item.claim}${sup}`);
    }
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  if (snap.scenario === 'sales' && snap.profile.sales) {
    const s = snap.profile.sales;
    lines.push('### 销售洞察');
    if (s.painPoints.length > 0) {
      lines.push('- **痛点**：' + s.painPoints.join('；'));
    }
    if (s.needs.length > 0) {
      lines.push('- **需求**：' + s.needs.join('；'));
    }
    if (s.objections.length > 0) {
      for (const obj of s.objections) {
        lines.push(
          `- **异议** [${formatLiveMmSs(obj.evidenceMs)}]：${obj.text}（${obj.handled ? '已化解' : '待处理'}）`
        );
      }
    }
    if (s.decisionSignals.length > 0) {
      for (const sig of s.decisionSignals) {
        lines.push(
          `- **决策信号 (${sig.polarity === 'positive' ? '正向' : '负向'})** [${formatLiveMmSs(sig.evidenceMs)}]：${sig.text}`
        );
      }
    }
    lines.push('');
  }

  if (snap.targetFields && snap.targetFields.length > 0) {
    lines.push('## 目标字段采集结果');
    for (const tf of snap.targetFields) {
      const stLabel =
        tf.status === 'captured' ? '已获取' : tf.status === 'partial' ? '部分提及' : '未获取';
      const valText = tf.value ? `：${tf.value}` : '';
      const tsText =
        typeof tf.evidenceMs === 'number' && tf.evidenceMs > 0
          ? ` [${formatLiveMmSs(tf.evidenceMs)}]`
          : '';
      lines.push(`- **${tf.label}**（${stLabel}）${valText}${tsText}`);
    }
    lines.push('');
  }

  if (snap.topicFlow && snap.topicFlow.length > 0) {
    lines.push('## 议题流转与相关性');
    for (const tf of snap.topicFlow) {
      const relLabel =
        tf.relevance === 'high'
          ? '高度相关'
          : tf.relevance === 'off_topic'
            ? '偏离主线'
            : '延伸相关';
      const statusLabel = tf.status === 'active' ? '当前议题' : '已聊过';
      const fromText = tf.transitionFrom ? `（接续自：${tf.transitionFrom}）` : '';
      const noteText = tf.relevanceNote ? ` — ${tf.relevanceNote}` : '';
      lines.push(
        `- [${formatLiveMmSs(tf.startMs)}] **${tf.topic}** [${statusLabel} · ${relLabel}]${fromText}${noteText}`
      );
    }
    lines.push('');
  }

  // 4. 关键要点
  lines.push('## 关键要点');
  const takeaways =
    snap.finalSummary?.keyTakeaways && snap.finalSummary.keyTakeaways.length > 0
      ? snap.finalSummary.keyTakeaways
      : snap.keyPoints;
  if (takeaways.length > 0) {
    for (const kp of takeaways) {
      lines.push(`- ${kp}`);
    }
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  // 5. 提纲覆盖情况
  lines.push('## 提纲覆盖情况');
  if (snap.outline.length > 0) {
    for (const item of snap.outline) {
      const note = item.note ? ` — ${item.note}` : '';
      lines.push(`- [${outlineStatusLabel(item.status)}] ${item.text}${note}`);
    }
  } else {
    lines.push('- 无预设提纲');
  }
  lines.push('');

  // 6. 已采纳的提问
  const adopted = snap.questions.filter((q) => q.status === 'adopted');
  lines.push(isListen ? '## 已记录/采纳的提问' : '## 已采纳的提问');
  if (adopted.length > 0) {
    for (const q of adopted) {
      lines.push(`- ${q.text}${q.why ? `（${q.why}）` : ''}`);
    }
  } else {
    lines.push('- 无');
  }
  lines.push('');

  // 7. 下一步行动
  lines.push(isListen ? '## 延伸思考与后续行动' : '## 下一步行动');
  if (snap.finalSummary?.nextSteps && snap.finalSummary.nextSteps.length > 0) {
    for (const step of snap.finalSummary.nextSteps) {
      lines.push(`- ${step}`);
    }
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  // 8. 分段发言总结
  lines.push('## 分段发言总结');
  if (snap.turnSummaries.length > 0) {
    for (const ts of snap.turnSummaries) {
      const spkName = speakerNameMap.get(ts.speakerId) ?? '发言人';
      lines.push(`- [${formatLiveMmSs(ts.startMs)}] **${spkName}**：${ts.summary}`);
    }
  } else {
    lines.push('- 暂无');
  }
  lines.push('');

  // 9. 完整逐字稿
  lines.push('## 完整逐字稿', '');
  if (snap.utterances.length > 0) {
    for (const u of snap.utterances) {
      const spkName = speakerNameMap.get(u.speakerId) ?? '发言人';
      lines.push(`[${formatLiveMmSs(u.startMs)}] **${spkName}**：${u.text}`, '');
    }
  } else {
    lines.push('（无转写内容）', '');
  }

  return lines.join('\n');
}
