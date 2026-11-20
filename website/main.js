(() => {
  // --- 1. Interactive Studio Demo Data ---
  const utterances = [
    {
      id: 'u1',
      speaker: 'host',
      name: '主持人 Alex',
      tokens: [
        { text: '欢迎来到本期节目，', type: 'normal' },
        { text: '嗯', type: 'filler', dur: 0.4, cut: false },
        { text: '我们今天请到了独立开发者德福，聊聊他做', type: 'normal' },
        { text: '博客', corrected: '播客', type: 'typo', fixed: false },
        { text: '工具的幕后故事。', type: 'normal' }
      ]
    },
    {
      id: 'u2',
      speaker: 'guest',
      name: '嘉宾 德福',
      tokens: [
        { text: '大家好！其实刚开始做的时候，', type: 'normal' },
        { text: '那个', type: 'filler', dur: 0.5, cut: false },
        { text: '最崩溃的不是写代码，而是每次录完两个小时的音频，', type: 'normal' },
        { text: '就是说', type: 'filler', dur: 0.6, cut: false },
        { text: '要对着波形图一条一条找气口。', type: 'normal' }
      ]
    },
    {
      id: 'u3',
      speaker: 'host',
      name: '主持人 Alex',
      tokens: [
        { text: '太有共鸣了！', type: 'normal' },
        { text: '啊对', type: 'filler', dur: 0.4, cut: false },
        { text: '所以点波 TapWave 直接把文稿和多轨波形锁相，删字就是删音，改字又不伤音频。', type: 'normal' }
      ]
    }
  ];

  let viewMode = 'timeline'; // 'timeline' | 'speaker'
  let isPlaying = false;
  let playTimer = null;
  let playProgress = 0;

  const transcriptEl = document.getElementById('demoTranscript');
  const cutCountEl = document.getElementById('cutCountStat');
  const savedTimeEl = document.getElementById('savedTimeStat');
  const btnRemoveFillers = document.getElementById('btnRemoveFillers');
  const btnPlayPreview = document.getElementById('btnPlayPreview');
  const playBtnText = document.getElementById('playBtnText');
  const playheadLine = document.getElementById('playheadLine');
  const playheadTime = document.getElementById('playheadTime');

  function renderTranscript() {
    if (!transcriptEl) return;
    transcriptEl.innerHTML = '';

    const list =
      viewMode === 'speaker'
        ? [...utterances].sort((a, b) => a.speaker.localeCompare(b.speaker))
        : utterances;

    list.forEach((utt, idx) => {
      const row = document.createElement('div');
      row.className = 'utterance-row';
      if (isPlaying && Math.floor((playProgress / 100) * list.length) === idx) {
        row.classList.add('playing');
      }

      const pill = document.createElement('span');
      pill.className = `speaker-pill ${utt.speaker}`;
      pill.textContent = utt.name;

      const textWrap = document.createElement('div');
      textWrap.className = 'utterance-text';

      utt.tokens.forEach((tok) => {
        if (tok.type === 'normal') {
          textWrap.appendChild(document.createTextNode(tok.text));
        } else if (tok.type === 'filler') {
          const span = document.createElement('span');
          span.className = `tok-filler${tok.cut ? ' cut' : ''}`;
          span.textContent = tok.text;
          span.title = tok.cut ? '点击恢复该口癖' : '点击切除该口癖（±20ms 过零点吸附）';
          span.addEventListener('click', () => {
            tok.cut = !tok.cut;
            updateStatsAndUI();
          });
          textWrap.appendChild(span);
        } else if (tok.type === 'typo') {
          const span = document.createElement('span');
          span.className = tok.fixed ? 'tok-corrected' : 'tok-typo';
          span.textContent = tok.fixed ? tok.corrected : tok.text;
          span.title = tok.fixed ? '已无损改字（原音频完整保留）' : '点击一键无损纠错为「播客」';
          span.addEventListener('click', () => {
            tok.fixed = !tok.fixed;
            renderTranscript();
          });
          textWrap.appendChild(span);
        }
      });

      row.appendChild(pill);
      row.appendChild(textWrap);
      transcriptEl.appendChild(row);
    });
  }

  function updateStatsAndUI() {
    let cuts = 0;
    let saved = 0;
    let totalFillers = 0;

    utterances.forEach((u) => {
      u.tokens.forEach((t) => {
        if (t.type === 'filler') {
          totalFillers += 1;
          if (t.cut) {
            cuts += 1;
            saved += t.dur || 0.4;
          }
        }
      });
    });

    if (cutCountEl) cutCountEl.textContent = `${cuts} 处`;
    if (savedTimeEl) savedTimeEl.textContent = `${saved.toFixed(1)} s`;

    if (btnRemoveFillers) {
      const allCut = cuts === totalFillers && totalFillers > 0;
      btnRemoveFillers.classList.toggle('active', allCut);
      btnRemoveFillers.innerHTML = allCut
        ? '<span class="chip-dot amber"></span> 已切除全部口癖 (点击恢复)'
        : '<span class="chip-dot amber"></span> AI 一键去口癖';
    }

    renderTranscript();
    renderWaveform(cuts);
  }

  // --- 2. Multi-Track Waveform Generator ---
  const barCount = 72;
  const hostHeights = Array.from({ length: barCount }, (_, i) =>
    i < 24 || i > 48 ? 25 + ((i * 19) % 65) : 10
  );
  const guestHeights = Array.from({ length: barCount }, (_, i) =>
    i >= 24 && i <= 48 ? 28 + ((i * 23) % 68) : 10
  );
  const bgmHeights = Array.from({ length: barCount }, (_, i) =>
    i < 8 || i > 64 ? 55 + ((i * 11) % 30) : 18 + ((i * 7) % 14)
  );

  // Indices representing filler segments on the waveform
  const fillerBarIndices = new Set([12, 13, 30, 31, 41, 42, 55, 56]);

  function renderWaveform(cutCount = 0) {
    const trackMap = {
      host: hostHeights,
      guest: guestHeights,
      bgm: bgmHeights
    };

    Object.entries(trackMap).forEach(([key, heights]) => {
      const container = document.querySelector(`.track-bars[data-track="${key}"]`);
      if (!container) return;
      container.innerHTML = '';

      heights.forEach((h, idx) => {
        const bar = document.createElement('div');
        bar.className = `w-bar ${key}`;
        const isCutSpot = key !== 'bgm' && cutCount > 0 && fillerBarIndices.has(idx);
        if (isCutSpot) {
          bar.classList.add('cut-bar');
        } else {
          bar.style.height = `${h}%`;
        }
        container.appendChild(bar);
      });
    });
  }

  // --- 3. Studio Controls ---
  document.querySelectorAll('.switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.switch-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      viewMode = btn.dataset.mode || 'timeline';
      renderTranscript();
    });
  });

  if (btnRemoveFillers) {
    btnRemoveFillers.addEventListener('click', () => {
      const allCut = utterances.every((u) =>
        u.tokens.filter((t) => t.type === 'filler').every((t) => t.cut)
      );
      utterances.forEach((u) => {
        u.tokens.forEach((t) => {
          if (t.type === 'filler') t.cut = !allCut;
        });
      });
      updateStatsAndUI();
    });
  }

  if (btnPlayPreview) {
    btnPlayPreview.addEventListener('click', () => {
      isPlaying = !isPlaying;
      btnPlayPreview.classList.toggle('active', isPlaying);
      if (playBtnText) playBtnText.textContent = isPlaying ? '暂停预览' : '试听自然衔接';
      if (playheadLine) playheadLine.classList.toggle('active', isPlaying);

      if (isPlaying) {
        playTimer = setInterval(() => {
          playProgress = (playProgress + 1.4) % 100;
          if (playheadLine) {
            const trackArea = document.querySelector('.track-bars');
            const labelOffset = trackArea ? trackArea.offsetLeft : 162;
            const width = trackArea ? trackArea.offsetWidth : 600;
            playheadLine.style.left = `${labelOffset + (width * playProgress) / 100}px`;
          }
          if (playheadTime) {
            const sec = (12.4 + (playProgress / 100) * 18.5).toFixed(2);
            playheadTime.textContent = `00:${sec.padStart(5, '0')} / 48:16.00`;
          }
          renderTranscript();
        }, 80);
      } else {
        clearInterval(playTimer);
        renderTranscript();
      }
    });
  }

  // --- 4. Workbench Tabs ---
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const panel = document.getElementById(`panel-${target}`);
      if (panel) panel.classList.add('active');
    });
  });

  // --- 5. Mobile Menu & Copy Button ---
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileDrawer = document.getElementById('mobileDrawer');
  if (mobileMenuBtn && mobileDrawer) {
    mobileMenuBtn.addEventListener('click', () => {
      const open = mobileDrawer.classList.toggle('open');
      mobileMenuBtn.setAttribute('aria-expanded', String(open));
    });
    mobileDrawer.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        mobileDrawer.classList.remove('open');
        mobileMenuBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = '已复制 ✓';
        setTimeout(() => {
          btn.textContent = orig;
        }, 1800);
      } catch {
        btn.textContent = '请手动复制';
      }
    });
  });

  // --- 6. Real Software Screenshots Tabs & Lightbox ---
  document.querySelectorAll('.shot-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.shot;
      document.querySelectorAll('.shot-tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.shot-view').forEach((v) => v.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const view = document.getElementById(`shot-${target}`);
      if (view) view.classList.add('active');
    });
  });

  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
  }

  document.querySelectorAll('.shot-frame').forEach((frame) => {
    frame.addEventListener('click', () => {
      const src = frame.dataset.lightbox;
      const caption = frame.dataset.caption || '';
      if (!lightbox || !lightboxImg || !src) return;
      lightboxImg.src = src;
      lightboxImg.alt = caption;
      if (lightboxCaption) lightboxCaption.textContent = caption;
      lightbox.classList.add('open');
      lightbox.setAttribute('aria-hidden', 'false');
    });
  });

  if (lightboxClose) {
    lightboxClose.addEventListener('click', closeLightbox);
  }
  if (lightbox) {
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  // Initial render
  updateStatsAndUI();
})();
