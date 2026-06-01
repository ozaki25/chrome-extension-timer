(() => {
  if (window.__overlayTimerInjected__) {
    // 既にこのタブで content script が走っているので何もしない
    // (chrome.runtime.onMessage のリスナーは初回実行時に登録済み)
    return;
  }
  window.__overlayTimerInjected__ = true;

  const Lib = (typeof globalThis !== 'undefined' && globalThis.OverlayTimerLib) || window.OverlayTimerLib;
  if (!Lib) {
    // lib.js が同じコンテキストに注入されていない (古いビルドの content.js だけが
    // 残っているタブなど)。エラーで埋め尽くされる前に降りる。
    // 再注入を許すため __overlayTimerInjected__ も解除しておく。
    console.warn('[Overlay Timer] lib.js が見つかりません。タブをリロードしてください。');
    delete window.__overlayTimerInjected__;
    return;
  }

  // ============================================================
  // 定数
  // ============================================================
  const STATE_KEY = 'overlayTimerState';
  const UI_KEY = 'overlayTimerUi';

  const DEFAULT_SECONDS = 5 * 60;
  const DEFAULT_WIDTH = 240;
  const DEFAULT_HEIGHT = 280;
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 640;
  const MIN_HEIGHT = 240;
  const MAX_HEIGHT = 640;
  const TICK_INTERVAL_MS = 250;
  // フォントサイズ計算用 (固定高さ要素ぶん控除)
  const FONT_RESERVED_HEIGHT = 240;
  const FONT_CHAR_WIDTH_RATIO = 0.6;
  const FONT_MIN = 20;
  const FONT_MAX = 140;

  const THEME_LABELS = {
    light: { icon: '☀', name: 'ライト' },
    dark: { icon: '☽', name: 'ダーク' }
  };

  // 終了音プリセット (key, ラベル)。再生実装は playSound 内で分岐
  const SOUND_PRESETS = [
    { key: 'chime', label: 'チャイム (やさしい)' },
    { key: 'bell', label: 'ベル (連打)' },
    { key: 'buzzer', label: 'ブザー (強め)' },
    { key: 'clap', label: '拍子木 (カンカン)' },
    { key: 'alarm', label: '目覚まし (ピピピ)' }
  ];
  const DEFAULT_SOUND = 'bell';

  // ============================================================
  // 状態
  // ============================================================
  // タブ間で共有するタイマー状態
  let shared = {
    initialSeconds: DEFAULT_SECONDS,
    endTimestamp: null,
    pausedRemaining: DEFAULT_SECONDS
  };

  // タブごとに保存される UI 設定
  let ui = {
    position: { x: 24, y: 24 },
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    opacity: 0.95,
    minimized: false,
    theme: 'auto',
    sound: DEFAULT_SOUND
  };

  // DOM 参照
  let root = null;
  let display = null;
  let statusEl = null;
  let startBtn = null;
  let minBtn = null;
  let themeBtn = null;
  let soundSelect = null;
  let opacityInput = null;
  let resizeHandle = null;
  let minutesInput = null;
  let secondsInput = null;

  // ランタイム状態
  let visible = false;
  let rafId = null;
  let audioCtx = null;       // 共有 AudioContext (ユーザージェスチャー時に生成)
  let activeOscs = [];        // 現在鳴っている oscillator 群 (早期停止用)
  let beepTimers = [];

  // ============================================================
  // 共通ユーティリティ (lib.js の純粋関数を shared/now でバインド)
  // ============================================================
  const formatTime = (s) => Lib.formatTime(s);
  const getRemaining = () => Lib.getRemaining(shared, Date.now());
  const isRunning = () => Lib.isRunning(shared, Date.now());
  const isFinished = () => Lib.isFinished(shared, Date.now());

  // ============================================================
  // ストレージ
  // ============================================================
  async function saveShared() {
    try { await chrome.storage.local.set({ [STATE_KEY]: shared }); } catch (e) {}
  }

  async function saveUi() {
    try { await chrome.storage.local.set({ [UI_KEY]: ui }); } catch (e) {}
  }

  async function loadAll() {
    try {
      const data = await chrome.storage.local.get([STATE_KEY, UI_KEY]);
      if (data[STATE_KEY]) shared = { ...shared, ...data[STATE_KEY] };
      if (data[UI_KEY]) ui = { ...ui, ...data[UI_KEY] };
    } catch (e) {}
  }

  // ============================================================
  // テーマ
  // ============================================================
  function getEffectiveTheme() {
    if (ui.theme === 'light' || ui.theme === 'dark') return ui.theme;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'dark';
    }
  }

  function applyTheme() {
    if (!root) return;
    root.classList.remove('ot-theme-auto', 'ot-theme-light', 'ot-theme-dark');
    root.classList.add('ot-theme-' + (ui.theme || 'auto'));
    if (themeBtn) {
      const eff = getEffectiveTheme();
      const cur = THEME_LABELS[eff];
      const next = eff === 'light' ? THEME_LABELS.dark : THEME_LABELS.light;
      themeBtn.textContent = cur.icon;
      themeBtn.setAttribute('aria-label', `テーマ: ${cur.name} (クリックで${next.name})`);
      themeBtn.title = `テーマ: ${cur.name} (クリックで${next.name})`;
    }
  }

  function toggleTheme() {
    const eff = getEffectiveTheme();
    ui.theme = eff === 'light' ? 'dark' : 'light';
    applyTheme();
    saveUi();
  }

  // ============================================================
  // タイマー操作 (lib の transition* で state を更新し、副作用は content.js 側)
  // ============================================================
  function commitToRunning(next) {
    stopBeep();
    shared = next;
    saveShared();
    chrome.runtime.sendMessage({ type: 'SCHEDULE_FINISH', when: shared.endTimestamp });
    startTicking();
    render();
  }

  function commitToStopped(next, { stopBeepFirst = false } = {}) {
    if (stopBeepFirst) stopBeep();
    shared = next;
    saveShared();
    chrome.runtime.sendMessage({ type: 'CANCEL_FINISH' });
    render();
  }

  function start() {
    // ユーザージェスチャーのうちに AudioContext を確保しておく
    // (終了通知は background から非同期に来るため、その時点では autoplay 制限で
    //  新規 AudioContext を生成できない)
    ensureAudioContext();
    const next = Lib.transitionStart(shared, Date.now());
    if (next === shared) return;
    commitToRunning(next);
  }

  function pause() {
    const next = Lib.transitionPause(shared, Date.now());
    if (next === shared) return;
    commitToStopped(next);
  }

  function reset() {
    const next = Lib.transitionReset(shared);
    commitToStopped(next, { stopBeepFirst: true });
  }

  function restartWith(seconds) {
    const next = Lib.transitionRestart(shared, seconds, Date.now());
    if (next === shared) return;
    commitToRunning(next);
  }

  function adjust(deltaSeconds) {
    const now = Date.now();
    const wasRunning = Lib.isRunning(shared, now);
    const wasFinished = Lib.isFinished(shared, now);
    const next = Lib.transitionAdjust(shared, deltaSeconds, now);
    if (next === shared) return;

    if (wasRunning) {
      shared = next;
      chrome.runtime.sendMessage({ type: 'SCHEDULE_FINISH', when: shared.endTimestamp });
      saveShared();
      render();
    } else if (wasFinished && deltaSeconds > 0) {
      commitToRunning(next);
    } else {
      shared = next;
      saveShared();
      render();
    }
  }

  function applyDirectInput() {
    const next = Lib.transitionDirectInput(shared, minutesInput.value, secondsInput.value);
    commitToStopped(next, { stopBeepFirst: true });
  }

  // ============================================================
  // ティック / 終了通知
  // ============================================================
  function startTicking() {
    cancelTicking();
    const loop = () => {
      render();
      if (isRunning()) {
        rafId = setTimeout(loop, TICK_INTERVAL_MS);
      } else {
        const next = Lib.transitionTickExpiry(shared, Date.now());
        if (next !== shared) {
          shared = next;
          saveShared();
          render();
        }
      }
    };
    loop();
  }

  function cancelTicking() {
    if (rafId) {
      clearTimeout(rafId);
      rafId = null;
    }
  }

  function onFinish() {
    playBeep();
    render();
  }
  window.__overlayTimerFinish__ = onFinish;

  // ============================================================
  // 音 (チャイム)
  // ============================================================
  // ユーザージェスチャー中に呼び出して AudioContext を確保 / 再開する。
  // 一度確保しておけば、後から background 経由で終了通知が来ても再生できる。
  function ensureAudioContext() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    } catch (e) {}
    return audioCtx;
  }

  function stopBeep() {
    beepTimers.forEach((id) => clearTimeout(id));
    beepTimers = [];
    activeOscs.forEach((osc) => {
      try { osc.stop(); } catch (e) {}
      try { osc.disconnect(); } catch (e) {}
    });
    activeOscs = [];
  }

  function playBeep() {
    playSound(ui.sound || DEFAULT_SOUND);
  }

  // プリセット音をその場で試聴 (現在のタイマー状態には影響しない)
  function previewSound(key) {
    playSound(key);
  }

  function playSound(key) {
    stopBeep();
    const ctx = ensureAudioContext();
    if (!ctx) return;
    // suspended のままだと無音なので resume を待ってからスケジュール
    const schedule = () => {
      try {
        const make = () => {
          const osc = ctx.createOscillator();
          activeOscs.push(osc);
          return osc;
        };
        const renderers = {
          chime: renderChime,
          bell: renderBell,
          buzzer: renderBuzzer,
          clap: renderClap,
          alarm: renderAlarm
        };
        const render = renderers[key] || renderers[DEFAULT_SOUND];
        const total = render(ctx, make);
        const id = setTimeout(stopBeep, total * 1000);
        beepTimers.push(id);
      } catch (e) {}
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(schedule).catch(() => {});
    } else {
      schedule();
    }
  }

  // --- 個別レンダラ。戻り値は鳴り終わるまでの秒数 (停止用) ---

  // やさしい ding-dong チャイム (旧デフォルト)
  function renderChime(ctx, make) {
    const partials = [
      { mult: 1.0, gain: 0.35, decay: 1.0 },
      { mult: 2.0, gain: 0.18, decay: 0.7 },
      { mult: 3.0, gain: 0.10, decay: 0.5 },
      { mult: 4.2, gain: 0.06, decay: 0.35 }
    ];
    const playChime = (when, freq, duration) => {
      const start = ctx.currentTime + when;
      partials.forEach(({ mult, gain, decay }) => {
        const osc = make();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        const tail = duration * decay;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(gain, start + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, start + tail);
        osc.connect(g).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + tail + 0.1);
      });
    };
    const C6 = 1046.5, G5 = 783.99;
    const tone = 1.6, cycle = 2.0, cycles = 3;
    for (let i = 0; i < cycles; i++) {
      playChime(i * cycle + 0.0, C6, tone);
      playChime(i * cycle + 0.45, G5, tone);
    }
    return cycles * cycle + tone;
  }

  // 金属ベル (倍音強め) を 0.18 秒間隔で連打
  function renderBell(ctx, make) {
    const partials = [
      { mult: 1.0, gain: 0.45, decay: 0.6 },
      { mult: 2.76, gain: 0.30, decay: 0.45 },
      { mult: 5.4, gain: 0.18, decay: 0.3 },
      { mult: 8.93, gain: 0.10, decay: 0.2 }
    ];
    const strike = (when, freq) => {
      const start = ctx.currentTime + when;
      partials.forEach(({ mult, gain, decay }) => {
        const osc = make();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(gain, start + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, start + decay);
        osc.connect(g).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + decay + 0.05);
      });
    };
    const freq = 880;
    const burst = 6;       // 1 セットの打数
    const sets = 3;        // セット数
    const beat = 0.18;
    const gap = 0.7;
    for (let s = 0; s < sets; s++) {
      for (let i = 0; i < burst; i++) {
        strike(s * (burst * beat + gap) + i * beat, freq);
      }
    }
    return sets * (burst * beat + gap);
  }

  // 矩形波の強めブザー (短く区切って 6 連発を 2 セット)
  function renderBuzzer(ctx, make) {
    const beep = (when, dur) => {
      const start = ctx.currentTime + when;
      const osc = make();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.35, start + 0.01);
      g.gain.setValueAtTime(0.35, start + dur - 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    };
    const dur = 0.18, gap = 0.08;
    const count = 6, sets = 2, between = 0.6;
    for (let s = 0; s < sets; s++) {
      for (let i = 0; i < count; i++) {
        beep(s * (count * (dur + gap) + between) + i * (dur + gap), dur);
      }
    }
    return sets * (count * (dur + gap) + between);
  }

  // 拍子木 / クラベス風: 高音の鋭いアタック + 短い減衰
  function renderClap(ctx, make) {
    // 主成分と倍音 (木が鳴る感じを軽く模擬)
    const partials = [
      { mult: 1.0, gain: 0.5, decay: 0.08 },
      { mult: 2.1, gain: 0.25, decay: 0.06 },
      { mult: 3.4, gain: 0.12, decay: 0.04 }
    ];
    const hit = (when) => {
      const start = ctx.currentTime + when;
      partials.forEach(({ mult, gain, decay }) => {
        const osc = make();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = 1800 * mult;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(gain, start + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, start + decay);
        osc.connect(g).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + decay + 0.02);
      });
    };
    // 三三七拍子っぽいリズムを 2 セット
    const pattern = [0.0, 0.25, 0.5, 1.0, 1.25, 1.5, 2.0, 2.2, 2.4, 2.6];
    const setLen = 3.2;
    const sets = 2;
    for (let s = 0; s < sets; s++) {
      pattern.forEach((t) => hit(s * setLen + t));
    }
    return sets * setLen;
  }

  // 目覚まし時計風: 高音ピピピ × 4 セット
  function renderAlarm(ctx, make) {
    const beep = (when, dur) => {
      const start = ctx.currentTime + when;
      const osc = make();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1760; // A6
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.4, start + 0.005);
      g.gain.setValueAtTime(0.4, start + dur - 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    };
    const dur = 0.08, gap = 0.07;
    const burst = 4, sets = 4, between = 0.45;
    for (let s = 0; s < sets; s++) {
      for (let i = 0; i < burst; i++) {
        beep(s * (burst * (dur + gap) + between) + i * (dur + gap), dur);
      }
    }
    return sets * (burst * (dur + gap) + between);
  }

  // ============================================================
  // レンダリング (state → DOM の同期は全てここで一元管理)
  // ============================================================
  function render() {
    if (!root) return;
    const remaining = getRemaining();
    const formatted = formatTime(remaining);
    const finished = isFinished();
    const running = isRunning();

    display.textContent = formatted;
    display.setAttribute('aria-label', `残り ${formatted}`);

    startBtn.textContent = running ? '一時停止' : '開始';
    startBtn.setAttribute('aria-pressed', running ? 'true' : 'false');

    root.classList.toggle('ot-minimized', ui.minimized);
    root.classList.toggle('ot-finished-state', finished);
    statusEl.textContent = finished ? '終了' : '';

    minBtn.textContent = ui.minimized ? '▢' : '_';
    minBtn.setAttribute('aria-label', ui.minimized ? '展開' : '最小化');
    minBtn.setAttribute('aria-expanded', ui.minimized ? 'false' : 'true');

    root.style.width = ui.width + 'px';
    // 最小化時は高さだけ CSS の auto に委ねる
    root.style.height = ui.minimized ? '' : ui.height + 'px';
    root.style.opacity = String(ui.opacity);
    updateDisplayFontSize();

    if (opacityInput && document.activeElement !== opacityInput) {
      opacityInput.value = String(ui.opacity);
    }
    if (soundSelect && document.activeElement !== soundSelect) {
      soundSelect.value = ui.sound || DEFAULT_SOUND;
    }

    const baseSeconds = running
      ? Math.ceil((shared.endTimestamp - Date.now()) / 1000)
      : shared.pausedRemaining;
    const totalSec = Math.max(0, baseSeconds);
    if (minutesInput && document.activeElement !== minutesInput) {
      minutesInput.value = String(Math.floor(totalSec / 60));
    }
    if (secondsInput && document.activeElement !== secondsInput) {
      secondsInput.value = String(totalSec % 60);
    }
  }

  function updateDisplayFontSize() {
    if (!display) return;
    const text = display.textContent || '00:00';
    const size = Lib.computeDisplayFontSize({
      width: ui.width,
      height: ui.height,
      charCount: text.length,
      reservedHeight: FONT_RESERVED_HEIGHT,
      charWidthRatio: FONT_CHAR_WIDTH_RATIO,
      min: FONT_MIN,
      max: FONT_MAX
    });
    display.style.fontSize = size + 'px';
  }

  // ============================================================
  // ドラッグ / リサイズ
  // ============================================================
  function makeDraggable(handle) {
    let startX = 0, startY = 0, origX = 0, origY = 0;
    let dragging = false, moved = false;

    const onDown = (e) => {
      if (e.target.closest('button, input, select')) return;
      dragging = true;
      moved = false;
      const point = e.touches ? e.touches[0] : e;
      startX = point.clientX;
      startY = point.clientY;
      const rect = root.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const point = e.touches ? e.touches[0] : e;
      const dx = point.clientX - startX;
      const dy = point.clientY - startY;
      if (!moved && dx * dx + dy * dy > 4) moved = true;
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      const newX = Math.max(0, Math.min(window.innerWidth - w, origX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - h, origY + dy));
      root.style.left = newX + 'px';
      root.style.top = newY + 'px';
      ui.position = { x: newX, y: newY };
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        saveUi();
        // ドラッグ直後の click を抑止 (展開などの誤発火対策)
        const suppress = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          handle.removeEventListener('click', suppress, true);
        };
        handle.addEventListener('click', suppress, true);
      }
    };

    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    handle.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }

  function setSize(width, height) {
    const clamped = Lib.clampSize(width, height, {
      minW: MIN_WIDTH, maxW: MAX_WIDTH,
      minH: MIN_HEIGHT, maxH: MAX_HEIGHT
    });
    ui.width = clamped.width;
    ui.height = clamped.height;
    if (root) {
      root.style.width = ui.width + 'px';
      if (!ui.minimized) root.style.height = ui.height + 'px';
      updateDisplayFontSize();
    }
  }

  function makeResizable(handle) {
    let startX = 0, startY = 0, startW = 0, startH = 0, resizing = false;
    const onDown = (e) => {
      resizing = true;
      const point = e.touches ? e.touches[0] : e;
      startX = point.clientX;
      startY = point.clientY;
      startW = ui.width;
      startH = ui.height;
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e) => {
      if (!resizing) return;
      const point = e.touches ? e.touches[0] : e;
      setSize(startW + (point.clientX - startX), startH + (point.clientY - startY));
    };
    const onUp = () => {
      if (resizing) {
        resizing = false;
        saveUi();
      }
    };
    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    handle.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      let w = ui.width, h = ui.height;
      let changed = true;
      switch (e.key) {
        case 'ArrowRight': w += step; break;
        case 'ArrowLeft': w -= step; break;
        case 'ArrowDown': h += step; break;
        case 'ArrowUp': h -= step; break;
        case 'Home': w = DEFAULT_WIDTH; h = DEFAULT_HEIGHT; break;
        default: changed = false;
      }
      if (changed) {
        setSize(w, h);
        e.preventDefault();
        saveUi();
      }
    });
  }

  // ============================================================
  // DOM ビルド
  // ============================================================
  function makeBtn(label, cls, onClick, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ot-btn ' + (cls || '');
    b.textContent = label;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  function makeIconBtn(label, ariaLabel, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ot-icon-btn';
    b.textContent = label;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  function makeNumberInput(max, ariaLabel) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '0';
    inp.max = String(max);
    inp.inputMode = 'numeric';
    inp.className = 'ot-num';
    inp.setAttribute('aria-label', ariaLabel);
    inp.addEventListener('change', applyDirectInput);
    inp.addEventListener('blur', applyDirectInput);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyDirectInput();
        inp.blur();
      }
    });
    return inp;
  }

  function build() {
    root = document.createElement('div');
    root.id = 'overlay-timer-root';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'オーバーレイタイマー');
    root.style.left = ui.position.x + 'px';
    root.style.top = ui.position.y + 'px';
    root.style.width = ui.width + 'px';
    if (!ui.minimized) {
      root.style.height = ui.height + 'px';
    }

    // ヘッダー
    const header = document.createElement('div');
    header.className = 'ot-header';
    const title = document.createElement('div');
    title.className = 'ot-title';
    title.textContent = '⏱ Timer';

    const headerBtns = document.createElement('div');
    headerBtns.className = 'ot-header-btns';
    themeBtn = makeIconBtn('', '', toggleTheme);
    minBtn = makeIconBtn('_', '最小化', () => {
      ui.minimized = !ui.minimized;
      saveUi();
      render();
    });
    const closeBtn = makeIconBtn('×', '閉じる', () => hide());
    headerBtns.appendChild(themeBtn);
    headerBtns.appendChild(minBtn);
    headerBtns.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(headerBtns);

    // 時刻表示
    display = document.createElement('div');
    display.className = 'ot-display';
    display.setAttribute('role', 'timer');
    display.setAttribute('aria-live', 'off');

    // ステータス (終了表示など)
    statusEl = document.createElement('div');
    statusEl.className = 'ot-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');

    // 直接入力欄
    const directWrap = document.createElement('div');
    directWrap.className = 'ot-direct';
    directWrap.setAttribute('role', 'group');
    directWrap.setAttribute('aria-label', '時間を直接入力');
    minutesInput = makeNumberInput(999, '分');
    secondsInput = makeNumberInput(59, '秒');
    const mLabel = document.createElement('span');
    mLabel.className = 'ot-unit';
    mLabel.textContent = '分';
    const sLabel = document.createElement('span');
    sLabel.className = 'ot-unit';
    sLabel.textContent = '秒';
    directWrap.appendChild(minutesInput);
    directWrap.appendChild(mLabel);
    directWrap.appendChild(secondsInput);
    directWrap.appendChild(sLabel);

    // ±ボタン
    const adjusters = document.createElement('div');
    adjusters.className = 'ot-adjusters';
    adjusters.setAttribute('role', 'group');
    adjusters.setAttribute('aria-label', '時間を増減');
    adjusters.appendChild(makeBtn('-1分', 'ot-adj', () => adjust(-60), '1分減らす'));
    adjusters.appendChild(makeBtn('-10秒', 'ot-adj', () => adjust(-10), '10秒減らす'));
    adjusters.appendChild(makeBtn('+10秒', 'ot-adj', () => adjust(10), '10秒増やす'));
    adjusters.appendChild(makeBtn('+1分', 'ot-adj', () => adjust(60), '1分増やす'));

    // 開始 / リセット
    const controls = document.createElement('div');
    controls.className = 'ot-controls';
    startBtn = makeBtn('開始', 'ot-primary', () => (isRunning() ? pause() : start()));
    controls.appendChild(startBtn);
    controls.appendChild(makeBtn('リセット', '', reset));

    // 透明度スライダー
    const sliders = document.createElement('div');
    sliders.className = 'ot-sliders';
    const opWrap = document.createElement('label');
    opWrap.className = 'ot-slider';
    const opLabel = document.createElement('span');
    opLabel.textContent = '透明度';
    opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0.5';
    opacityInput.max = '1';
    opacityInput.step = '0.05';
    opacityInput.value = String(ui.opacity);
    opacityInput.setAttribute('aria-label', '透明度');
    opacityInput.addEventListener('input', () => {
      ui.opacity = parseFloat(opacityInput.value);
      saveUi();
      render();
    });
    opWrap.appendChild(opLabel);
    opWrap.appendChild(opacityInput);
    sliders.appendChild(opWrap);

    // 終了音セレクタ + 試聴
    const soundWrap = document.createElement('label');
    soundWrap.className = 'ot-slider ot-sound';
    const soundLabel = document.createElement('span');
    soundLabel.textContent = '音';
    soundSelect = document.createElement('select');
    soundSelect.className = 'ot-sound-select';
    soundSelect.setAttribute('aria-label', '終了音');
    SOUND_PRESETS.forEach(({ key, label }) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      soundSelect.appendChild(opt);
    });
    soundSelect.value = ui.sound || DEFAULT_SOUND;
    soundSelect.addEventListener('change', () => {
      ui.sound = soundSelect.value;
      saveUi();
      previewSound(ui.sound);
    });
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'ot-icon-btn ot-sound-preview';
    previewBtn.textContent = '▶';
    previewBtn.setAttribute('aria-label', '音を試聴');
    previewBtn.title = '音を試聴';
    previewBtn.addEventListener('click', () => previewSound(ui.sound || DEFAULT_SOUND));
    soundWrap.appendChild(soundLabel);
    soundWrap.appendChild(soundSelect);
    soundWrap.appendChild(previewBtn);
    sliders.appendChild(soundWrap);

    // リサイズハンドル
    resizeHandle = document.createElement('div');
    resizeHandle.className = 'ot-resize';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', 'サイズを変更');
    resizeHandle.setAttribute('aria-orientation', 'horizontal');
    resizeHandle.setAttribute('tabindex', '0');
    resizeHandle.title = 'ドラッグでサイズ変更';

    root.appendChild(header);
    root.appendChild(display);
    root.appendChild(statusEl);
    root.appendChild(directWrap);
    root.appendChild(adjusters);
    root.appendChild(controls);
    root.appendChild(sliders);
    root.appendChild(resizeHandle);
    document.documentElement.appendChild(root);

    makeDraggable(header);
    makeDraggable(display);
    makeResizable(resizeHandle);
    applyTheme();
  }

  // ============================================================
  // 表示制御
  // ============================================================
  function show() {
    if (!root) build();
    visible = true;
    root.style.display = 'flex';
    render();
    startTicking();
  }

  function hide() {
    visible = false;
    if (root) root.style.display = 'none';
    cancelTicking();
  }

  async function toggle() {
    if (!root) {
      await loadAll();
      build();
    }
    if (visible) hide();
    else show();
  }
  window.__overlayTimerToggle__ = toggle;

  // ============================================================
  // メッセージ / ストレージのリスナー
  // ============================================================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'TOGGLE_TIMER') toggle();
    if (msg?.type === 'TIMER_FINISHED') onFinish();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STATE_KEY]?.newValue) {
      shared = { ...shared, ...changes[STATE_KEY].newValue };
      render();
      if (isRunning() && visible) startTicking();
    }
    if (changes[UI_KEY]?.newValue) {
      ui = { ...ui, ...changes[UI_KEY].newValue };
      if (root) {
        root.style.left = ui.position.x + 'px';
        root.style.top = ui.position.y + 'px';
        applyTheme();
        render();
      }
    }
  });

  // OS のダーク/ライト切替に追従 (auto モード時のみ表示を更新)
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (ui.theme !== 'light' && ui.theme !== 'dark') applyTheme();
    });
  } catch (e) {}

  loadAll();
})();
