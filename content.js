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
  let opacityInput = null;
  let resizeHandle = null;
  let minutesInput = null;
  let secondsInput = null;
  let rafId = null;
  const BASE_WIDTH = 240;

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
    root.style.transform = `scale(${ui.scale})`;
    root.style.opacity = String(ui.opacity);
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
      const playBeepOnce = (when, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 1000;
        const start = ctx.currentTime + when;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.3, start + 0.01);
        gain.gain.setValueAtTime(0.3, start + duration - 0.01);
        gain.gain.linearRampToValueAtTime(0.0001, start + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + duration + 0.02);
      };

      // 一般的なキッチンタイマー風: 1kHz 短音 を 0.5 秒間隔で繰り返す
      const beepDuration = 0.2;
      const interval = 0.5;
      const totalDuration = 8;
      const count = Math.floor(totalDuration / interval);
      for (let i = 0; i < count; i++) {
        playBeepOnce(i * interval, beepDuration);
      }

      const id = setTimeout(stopBeep, totalDuration * 1000);
      beepTimers.push(id);
    } catch (e) {}
  }

  let statusEl = null;

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

  function setScale(newScale) {
    ui.scale = Math.max(0.5, Math.min(2.5, newScale));
    if (root) root.style.transform = `scale(${ui.scale})`;
  }

  function makeResizable(handle) {
    let startX = 0, startY = 0, startScale = 1, resizing = false;
    const onDown = (e) => {
      resizing = true;
      const point = e.touches ? e.touches[0] : e;
      startX = point.clientX;
      startY = point.clientY;
      startScale = ui.scale;
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e) => {
      if (!resizing) return;
      const point = e.touches ? e.touches[0] : e;
      const dx = point.clientX - startX;
      const dy = point.clientY - startY;
      const delta = (dx + dy) / 2;
      setScale(startScale + delta / BASE_WIDTH);
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
      const step = e.shiftKey ? 0.2 : 0.05;
      let changed = true;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case '+':
          setScale(ui.scale + step);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case '-':
          setScale(ui.scale - step);
          break;
        case 'Home':
          setScale(1);
          break;
        default:
          changed = false;
      }
      if (changed) {
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
    root.style.transformOrigin = 'top left';

    const header = document.createElement('div');
    header.className = 'ot-header';
    const title = document.createElement('div');
    title.className = 'ot-title';
    title.textContent = '⏱ Timer';

    const headerBtns = document.createElement('div');
    headerBtns.className = 'ot-header-btns';
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
