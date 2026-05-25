(() => {
  if (window.__overlayTimerInjected__) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'TOGGLE_TIMER') window.__overlayTimerToggle__?.();
      if (msg?.type === 'TIMER_FINISHED') window.__overlayTimerFinish__?.();
    });
    return;
  }
  window.__overlayTimerInjected__ = true;

  const STATE_KEY = 'overlayTimerState';
  const UI_KEY = 'overlayTimerUi';

  // Shared timer state across tabs
  let shared = {
    initialSeconds: 5 * 60,
    endTimestamp: null,
    pausedRemaining: 5 * 60
  };

  // Per-tab UI state (also persisted, but visibility is per-tab in memory)
  let ui = {
    position: { x: 24, y: 24 },
    width: 240,
    height: 280,
    opacity: 0.95,
    minimized: false,
    theme: 'auto'
  };

  let visible = false;
  let root = null;
  let display = null;
  let startBtn = null;
  let minBtn = null;
  let opacityInput = null;
  let resizeHandle = null;
  let minutesInput = null;
  let secondsInput = null;
  let themeBtn = null;
  let rafId = null;

  const THEME_LABELS = {
    light: { icon: '☀', name: 'ライト' },
    dark: { icon: '☽', name: 'ダーク' }
  };

  function getEffectiveTheme() {
    if (ui.theme === 'light' || ui.theme === 'dark') return ui.theme;
    // auto: OS の設定に追従
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
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 640;
  const MIN_HEIGHT = 240;
  const MAX_HEIGHT = 640;

  const pad = (n) => String(n).padStart(2, '0');

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.ceil(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
    return `${pad(m)}:${pad(sec)}`;
  }

  function getRemaining() {
    if (shared.endTimestamp) {
      return Math.max(0, (shared.endTimestamp - Date.now()) / 1000);
    }
    return shared.pausedRemaining;
  }

  function isRunning() {
    return shared.endTimestamp != null && shared.endTimestamp > Date.now();
  }

  async function saveShared() {
    try {
      await chrome.storage.local.set({ [STATE_KEY]: shared });
    } catch (e) {}
  }

  async function saveUi() {
    try {
      await chrome.storage.local.set({ [UI_KEY]: ui });
    } catch (e) {}
  }

  async function loadAll() {
    try {
      const data = await chrome.storage.local.get([STATE_KEY, UI_KEY]);
      if (data[STATE_KEY]) shared = { ...shared, ...data[STATE_KEY] };
      if (data[UI_KEY]) ui = { ...ui, ...data[UI_KEY] };
    } catch (e) {}
  }

  function render() {
    if (!root) return;
    const remaining = getRemaining();
    const formatted = formatTime(remaining);
    display.textContent = formatted;
    display.setAttribute('aria-label', `残り ${formatted}`);
    startBtn.textContent = isRunning() ? '一時停止' : '開始';
    startBtn.setAttribute('aria-pressed', isRunning() ? 'true' : 'false');
    root.classList.toggle('ot-minimized', ui.minimized);
    minBtn.textContent = ui.minimized ? '▢' : '_';
    minBtn.setAttribute('aria-label', ui.minimized ? '展開' : '最小化');
    minBtn.setAttribute('aria-expanded', ui.minimized ? 'false' : 'true');
    root.style.width = ui.width + 'px';
    root.style.height = ui.minimized ? 'auto' : ui.height + 'px';
    root.style.opacity = String(ui.opacity);
    updateDisplayFontSize();
    if (opacityInput && document.activeElement !== opacityInput) opacityInput.value = String(ui.opacity);

    const baseSeconds = isRunning() ? Math.ceil((shared.endTimestamp - Date.now()) / 1000) : shared.pausedRemaining;
    const totalSec = Math.max(0, baseSeconds);
    if (minutesInput && document.activeElement !== minutesInput) {
      minutesInput.value = String(Math.floor(totalSec / 60));
    }
    if (secondsInput && document.activeElement !== secondsInput) {
      secondsInput.value = String(totalSec % 60);
    }
  }

  function applyDirectInput() {
    const m = Math.max(0, Math.min(999, parseInt(minutesInput.value, 10) || 0));
    const s = Math.max(0, Math.min(59, parseInt(secondsInput.value, 10) || 0));
    const total = m * 60 + s;
    stopBeep();
    if (root) root.classList.remove('ot-finished-state');
    setStatus('');
    shared.initialSeconds = total;
    shared.pausedRemaining = total;
    shared.endTimestamp = null;
    saveShared();
    chrome.runtime.sendMessage({ type: 'CANCEL_FINISH' });
    render();
  }

  function startTicking() {
    cancelTicking();
    const loop = () => {
      render();
      if (isRunning()) {
        rafId = setTimeout(loop, 250);
      } else if (shared.endTimestamp != null && shared.endTimestamp <= Date.now()) {
        // Timer just finished
        shared.endTimestamp = null;
        shared.pausedRemaining = 0;
        saveShared();
        render();
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

  function start() {
    let secs = shared.pausedRemaining;
    if (secs <= 0) secs = shared.initialSeconds;
    if (secs <= 0) return;
    stopBeep();
    if (root) root.classList.remove('ot-finished-state');
    setStatus('');
    shared.endTimestamp = Date.now() + secs * 1000;
    shared.pausedRemaining = secs;
    saveShared();
    chrome.runtime.sendMessage({ type: 'SCHEDULE_FINISH', when: shared.endTimestamp });
    startTicking();
  }

  function pause() {
    if (!isRunning()) return;
    shared.pausedRemaining = Math.max(0, (shared.endTimestamp - Date.now()) / 1000);
    shared.endTimestamp = null;
    saveShared();
    chrome.runtime.sendMessage({ type: 'CANCEL_FINISH' });
    render();
  }

  function reset() {
    stopBeep();
    if (root) root.classList.remove('ot-finished-state');
    setStatus('');
    shared.endTimestamp = null;
    shared.pausedRemaining = shared.initialSeconds;
    saveShared();
    chrome.runtime.sendMessage({ type: 'CANCEL_FINISH' });
    render();
  }

  function adjust(deltaSeconds) {
    if (isRunning()) {
      const newEnd = shared.endTimestamp + deltaSeconds * 1000;
      const remaining = (newEnd - Date.now()) / 1000;
      if (remaining < 1) return;
      shared.endTimestamp = newEnd;
      shared.pausedRemaining = remaining;
      chrome.runtime.sendMessage({ type: 'SCHEDULE_FINISH', when: shared.endTimestamp });
      saveShared();
      render();
      return;
    }

    // 終了状態 (0 で停止中) のときは「延長して即再開」
    const isFinished = root?.classList.contains('ot-finished-state');
    if (isFinished && deltaSeconds > 0) {
      restartWith(deltaSeconds);
      return;
    }

    // それ以外 (一時停止中など) は通常の増減
    const newInitial = Math.max(0, shared.initialSeconds + deltaSeconds);
    shared.initialSeconds = newInitial;
    shared.pausedRemaining = newInitial;
    saveShared();
    render();
  }

  let beepCtx = null;
  let beepTimers = [];

  function stopBeep() {
    beepTimers.forEach((id) => clearTimeout(id));
    beepTimers = [];
    if (beepCtx) {
      try { beepCtx.close(); } catch (e) {}
      beepCtx = null;
    }
  }

  function playBeep() {
    stopBeep();
    try {
      beepCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = beepCtx;

      // ベル / チャイム風の音色 (倍音を重ねて減衰させる)
      const playChime = (when, freq, duration) => {
        const start = ctx.currentTime + when;
        // 鐘の倍音構成 (基音 + 整数倍音 + わずかに非整数の倍音)
        const partials = [
          { mult: 1.0, gain: 0.35, decay: 1.0 },
          { mult: 2.0, gain: 0.18, decay: 0.7 },
          { mult: 3.0, gain: 0.10, decay: 0.5 },
          { mult: 4.2, gain: 0.06, decay: 0.35 }
        ];
        partials.forEach(({ mult, gain, decay }) => {
          const osc = ctx.createOscillator();
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

      // ding-dong (C6 → G5) を 3 回繰り返す
      const C6 = 1046.5;
      const G5 = 783.99;
      const tone = 1.6;
      const cycle = 2.0;
      const cycles = 3;
      for (let i = 0; i < cycles; i++) {
        playChime(i * cycle + 0.0, C6, tone);
        playChime(i * cycle + 0.45, G5, tone);
      }

      const total = cycles * cycle + tone;
      const id = setTimeout(stopBeep, total * 1000);
      beepTimers.push(id);
    } catch (e) {}
  }

  let statusEl = null;

  function restartWith(seconds) {
    if (seconds <= 0) return;
    stopBeep();
    if (root) root.classList.remove('ot-finished-state');
    setStatus('');
    shared.initialSeconds = seconds;
    shared.pausedRemaining = seconds;
    shared.endTimestamp = Date.now() + seconds * 1000;
    saveShared();
    chrome.runtime.sendMessage({ type: 'SCHEDULE_FINISH', when: shared.endTimestamp });
    startTicking();
    render();
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function onFinish() {
    if (root) {
      root.classList.add('ot-finished-state');
      setStatus('終了');
    }
    playBeep();
  }
  window.__overlayTimerFinish__ = onFinish;

  function makeDraggable(handle) {
    let startX = 0, startY = 0, origX = 0, origY = 0, dragging = false;
    const onDown = (e) => {
      if (e.target.closest('button, input, select')) return;
      dragging = true;
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
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      const newX = Math.max(0, Math.min(window.innerWidth - w, origX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - h, origY + dy));
      root.style.left = newX + 'px';
      root.style.top = newY + 'px';
      ui.position = { x: newX, y: newY };
    };
    const onUp = () => {
      if (dragging) {
        dragging = false;
        saveUi();
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
    ui.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
    ui.height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
    if (root) {
      root.style.width = ui.width + 'px';
      if (!ui.minimized) root.style.height = ui.height + 'px';
      updateDisplayFontSize();
    }
  }

  function updateDisplayFontSize() {
    if (!display) return;
    const text = display.textContent || '00:00';
    const charCount = text.length;
    // 固定高さの要素 (ヘッダー・ステータス・入力欄・ボタン・スライダー・余白) を控除
    const reservedHeight = 240;
    const availableWidth = Math.max(40, ui.width - 24);
    const availableHeight = Math.max(28, ui.height - reservedHeight);
    // tabular-nums の数字は font-size の約 0.6 倍幅
    const sizeByWidth = availableWidth / (charCount * 0.6);
    const sizeByHeight = availableHeight * 0.95;
    const size = Math.max(20, Math.min(140, Math.min(sizeByWidth, sizeByHeight)));
    display.style.fontSize = size + 'px';
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
      const dx = point.clientX - startX;
      const dy = point.clientY - startY;
      setSize(startW + dx, startH + dy);
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
      let changed = true;
      let w = ui.width, h = ui.height;
      switch (e.key) {
        case 'ArrowRight': w += step; break;
        case 'ArrowLeft': w -= step; break;
        case 'ArrowDown': h += step; break;
        case 'ArrowUp': h -= step; break;
        case 'Home': w = 240; h = 280; break;
        default: changed = false;
      }
      if (changed) {
        setSize(w, h);
        e.preventDefault();
        saveUi();
      }
    });
  }

  function makeBtn(label, cls, onClick, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ot-btn ' + (cls || '');
    b.textContent = label;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  function build() {
    root = document.createElement('div');
    root.id = 'overlay-timer-root';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'オーバーレイタイマー');
    root.style.left = ui.position.x + 'px';
    root.style.top = ui.position.y + 'px';
    root.style.width = ui.width + 'px';
    root.style.height = ui.minimized ? 'auto' : ui.height + 'px';

    const header = document.createElement('div');
    header.className = 'ot-header';
    const title = document.createElement('div');
    title.className = 'ot-title';
    title.textContent = '⏱ Timer';

    const headerBtns = document.createElement('div');
    headerBtns.className = 'ot-header-btns';

    themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.className = 'ot-icon-btn';
    themeBtn.addEventListener('click', toggleTheme);

    minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'ot-icon-btn';
    minBtn.textContent = '_';
    minBtn.setAttribute('aria-label', '最小化');
    minBtn.addEventListener('click', () => {
      ui.minimized = !ui.minimized;
      saveUi();
      render();
    });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ot-icon-btn';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.addEventListener('click', () => hide());
    headerBtns.appendChild(themeBtn);
    headerBtns.appendChild(minBtn);
    headerBtns.appendChild(closeBtn);

    header.appendChild(title);
    header.appendChild(headerBtns);

    display = document.createElement('div');
    display.className = 'ot-display';
    display.setAttribute('role', 'timer');
    display.setAttribute('aria-live', 'off');
    display.addEventListener('click', () => {
      if (ui.minimized) {
        ui.minimized = false;
        saveUi();
        render();
      }
    });

    statusEl = document.createElement('div');
    statusEl.className = 'ot-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');

    const directWrap = document.createElement('div');
    directWrap.className = 'ot-direct';
    directWrap.setAttribute('role', 'group');
    directWrap.setAttribute('aria-label', '時間を直接入力');

    minutesInput = document.createElement('input');
    minutesInput.type = 'number';
    minutesInput.min = '0';
    minutesInput.max = '999';
    minutesInput.inputMode = 'numeric';
    minutesInput.className = 'ot-num';
    minutesInput.setAttribute('aria-label', '分');
    minutesInput.addEventListener('change', applyDirectInput);
    minutesInput.addEventListener('blur', applyDirectInput);

    secondsInput = document.createElement('input');
    secondsInput.type = 'number';
    secondsInput.min = '0';
    secondsInput.max = '59';
    secondsInput.inputMode = 'numeric';
    secondsInput.className = 'ot-num';
    secondsInput.setAttribute('aria-label', '秒');
    secondsInput.addEventListener('change', applyDirectInput);
    secondsInput.addEventListener('blur', applyDirectInput);

    [minutesInput, secondsInput].forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyDirectInput();
          inp.blur();
        }
      });
    });

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

    const adjusters = document.createElement('div');
    adjusters.className = 'ot-adjusters';
    adjusters.setAttribute('role', 'group');
    adjusters.setAttribute('aria-label', '時間を増減');
    adjusters.appendChild(makeBtn('-1分', 'ot-adj', () => adjust(-60), '1分減らす'));
    adjusters.appendChild(makeBtn('-10秒', 'ot-adj', () => adjust(-10), '10秒減らす'));
    adjusters.appendChild(makeBtn('+10秒', 'ot-adj', () => adjust(10), '10秒増やす'));
    adjusters.appendChild(makeBtn('+1分', 'ot-adj', () => adjust(60), '1分増やす'));

    const controls = document.createElement('div');
    controls.className = 'ot-controls';
    startBtn = makeBtn('開始', 'ot-primary', () => (isRunning() ? pause() : start()));
    controls.appendChild(startBtn);
    controls.appendChild(makeBtn('リセット', '', reset));

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
      // Allow other tabs' UI prefs to sync (position is shared as last edit)
      ui = { ...ui, ...changes[UI_KEY].newValue };
      if (root) {
        root.style.left = ui.position.x + 'px';
        root.style.top = ui.position.y + 'px';
        applyTheme();
        render();
      }
    }
  });

  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (ui.theme !== 'light' && ui.theme !== 'dark') applyTheme();
    });
  } catch (e) {}

  loadAll();
})();
