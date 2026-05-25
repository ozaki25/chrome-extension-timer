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
    scale: 1,
    opacity: 0.95,
    minimized: false
  };

  let visible = false;
  let root = null;
  let display = null;
  let startBtn = null;
  let minBtn = null;
  let scaleInput = null;
  let opacityInput = null;
  let rafId = null;

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
    display.textContent = formatTime(remaining);
    display.classList.toggle('ot-finished', remaining <= 0 && !isRunning() && shared.endTimestamp == null && shared.pausedRemaining === 0);
    startBtn.textContent = isRunning() ? '一時停止' : '開始';
    root.classList.toggle('ot-minimized', ui.minimized);
    minBtn.textContent = ui.minimized ? '▢' : '_';
    minBtn.title = ui.minimized ? '展開' : '最小化';
    root.style.transform = `scale(${ui.scale})`;
    root.style.opacity = String(ui.opacity);
    if (scaleInput && document.activeElement !== scaleInput) scaleInput.value = String(ui.scale);
    if (opacityInput && document.activeElement !== opacityInput) opacityInput.value = String(ui.opacity);
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
    } else {
      const newInitial = Math.max(0, shared.initialSeconds + deltaSeconds);
      shared.initialSeconds = newInitial;
      shared.pausedRemaining = newInitial;
    }
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
      const playChirp = (when, freq, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        const start = ctx.currentTime + when;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.4, start + 0.03);
        gain.gain.setValueAtTime(0.4, start + duration - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + duration + 0.05);
      };

      // 8秒間、はっきりとしたパターンで鳴らす
      const pattern = [
        [0.0, 880, 0.25],
        [0.35, 1175, 0.25],
        [0.7, 880, 0.25],
        [1.05, 1175, 0.6],
        [1.9, 880, 0.25],
        [2.25, 1175, 0.25],
        [2.6, 880, 0.25],
        [2.95, 1175, 0.6],
        [3.8, 880, 0.25],
        [4.15, 1175, 0.25],
        [4.5, 880, 0.25],
        [4.85, 1175, 0.6],
        [5.7, 880, 0.25],
        [6.05, 1175, 0.25],
        [6.4, 880, 0.25],
        [6.75, 1175, 0.6]
      ];
      pattern.forEach(([when, freq, dur]) => playChirp(when, freq, dur));

      // 8秒経過後に自動停止
      const id = setTimeout(stopBeep, 8000);
      beepTimers.push(id);
    } catch (e) {}
  }

  function onFinish() {
    if (root) {
      root.classList.add('ot-finished-state');
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
      const w = root.offsetWidth * ui.scale;
      const h = root.offsetHeight * ui.scale;
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

  function makeBtn(label, cls, onClick, title) {
    const b = document.createElement('button');
    b.className = 'ot-btn ' + (cls || '');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function build() {
    root = document.createElement('div');
    root.id = 'overlay-timer-root';
    root.style.left = ui.position.x + 'px';
    root.style.top = ui.position.y + 'px';
    root.style.transformOrigin = 'top left';

    const header = document.createElement('div');
    header.className = 'ot-header';
    const title = document.createElement('div');
    title.className = 'ot-title';
    title.textContent = '⏱ Timer';

    const headerBtns = document.createElement('div');
    headerBtns.className = 'ot-header-btns';
    minBtn = document.createElement('button');
    minBtn.className = 'ot-icon-btn';
    minBtn.textContent = '_';
    minBtn.addEventListener('click', () => {
      ui.minimized = !ui.minimized;
      saveUi();
      render();
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ot-icon-btn';
    closeBtn.textContent = '×';
    closeBtn.title = '閉じる';
    closeBtn.addEventListener('click', () => hide());
    headerBtns.appendChild(minBtn);
    headerBtns.appendChild(closeBtn);

    header.appendChild(title);
    header.appendChild(headerBtns);

    display = document.createElement('div');
    display.className = 'ot-display';
    display.addEventListener('click', () => {
      if (ui.minimized) {
        ui.minimized = false;
        saveUi();
        render();
      }
    });

    const adjusters = document.createElement('div');
    adjusters.className = 'ot-adjusters';
    adjusters.appendChild(makeBtn('-1分', 'ot-adj', () => adjust(-60)));
    adjusters.appendChild(makeBtn('-10秒', 'ot-adj', () => adjust(-10)));
    adjusters.appendChild(makeBtn('+10秒', 'ot-adj', () => adjust(10)));
    adjusters.appendChild(makeBtn('+1分', 'ot-adj', () => adjust(60)));

    const controls = document.createElement('div');
    controls.className = 'ot-controls';
    startBtn = makeBtn('開始', 'ot-primary', () => (isRunning() ? pause() : start()));
    controls.appendChild(startBtn);
    controls.appendChild(makeBtn('リセット', '', reset));

    const sliders = document.createElement('div');
    sliders.className = 'ot-sliders';
    const scaleWrap = document.createElement('label');
    scaleWrap.className = 'ot-slider';
    scaleWrap.innerHTML = '<span>サイズ</span>';
    scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = '0.5';
    scaleInput.max = '2';
    scaleInput.step = '0.1';
    scaleInput.value = String(ui.scale);
    scaleInput.addEventListener('input', () => {
      ui.scale = parseFloat(scaleInput.value);
      saveUi();
      render();
    });
    scaleWrap.appendChild(scaleInput);

    const opWrap = document.createElement('label');
    opWrap.className = 'ot-slider';
    opWrap.innerHTML = '<span>透明度</span>';
    opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0.2';
    opacityInput.max = '1';
    opacityInput.step = '0.05';
    opacityInput.value = String(ui.opacity);
    opacityInput.addEventListener('input', () => {
      ui.opacity = parseFloat(opacityInput.value);
      saveUi();
      render();
    });
    opWrap.appendChild(opacityInput);

    sliders.appendChild(scaleWrap);
    sliders.appendChild(opWrap);

    root.appendChild(header);
    root.appendChild(display);
    root.appendChild(adjusters);
    root.appendChild(controls);
    root.appendChild(sliders);
    document.documentElement.appendChild(root);

    makeDraggable(header);
    makeDraggable(display);
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
        render();
      }
    }
  });

  loadAll();
})();
