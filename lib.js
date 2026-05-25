// Pure helpers and state transitions for Overlay Timer.
// 単体テスト可能な関数だけを集めたモジュール。content.js から globalThis.OverlayTimerLib として使用。

;(function (globalScope) {
  'use strict';

  // ============================================================
  // 表示ユーティリティ
  // ============================================================
  function formatTime(totalSeconds) {
    const pad = (n) => String(n).padStart(2, '0');
    const s = Math.max(0, Math.ceil(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
    return `${pad(m)}:${pad(sec)}`;
  }

  // ============================================================
  // state クエリ (pure)
  //   state shape: { initialSeconds, endTimestamp, pausedRemaining }
  // ============================================================
  function getRemaining(state, now) {
    if (state.endTimestamp) {
      return Math.max(0, (state.endTimestamp - now) / 1000);
    }
    return state.pausedRemaining;
  }

  function isRunning(state, now) {
    return state.endTimestamp != null && state.endTimestamp > now;
  }

  function isFinished(state, now) {
    return !isRunning(state, now) && getRemaining(state, now) <= 0 && state.initialSeconds > 0;
  }

  // ============================================================
  // state 遷移 (immutable; 変更がなければ同じ参照を返す)
  // ============================================================
  function transitionStart(state, now) {
    let secs = state.pausedRemaining;
    if (secs <= 0) secs = state.initialSeconds;
    if (secs <= 0) return state;
    return {
      ...state,
      endTimestamp: now + secs * 1000,
      pausedRemaining: secs
    };
  }

  function transitionPause(state, now) {
    if (!isRunning(state, now)) return state;
    return {
      ...state,
      pausedRemaining: Math.max(0, (state.endTimestamp - now) / 1000),
      endTimestamp: null
    };
  }

  function transitionReset(state) {
    return {
      ...state,
      endTimestamp: null,
      pausedRemaining: state.initialSeconds
    };
  }

  function transitionRestart(state, seconds, now) {
    if (seconds <= 0) return state;
    return {
      ...state,
      initialSeconds: seconds,
      pausedRemaining: seconds,
      endTimestamp: now + seconds * 1000
    };
  }

  function transitionAdjust(state, delta, now) {
    if (isRunning(state, now)) {
      const newEnd = state.endTimestamp + delta * 1000;
      const remaining = (newEnd - now) / 1000;
      if (remaining < 1) return state;
      return {
        ...state,
        endTimestamp: newEnd,
        pausedRemaining: remaining
      };
    }
    if (isFinished(state, now) && delta > 0) {
      return transitionRestart(state, delta, now);
    }
    const newInitial = Math.max(0, state.initialSeconds + delta);
    return {
      ...state,
      initialSeconds: newInitial,
      pausedRemaining: newInitial
    };
  }

  function transitionDirectInput(state, minutes, seconds) {
    const m = Math.max(0, Math.min(999, parseInt(minutes, 10) || 0));
    const s = Math.max(0, Math.min(59, parseInt(seconds, 10) || 0));
    const total = m * 60 + s;
    return {
      ...state,
      initialSeconds: total,
      pausedRemaining: total,
      endTimestamp: null
    };
  }

  function transitionTickExpiry(state, now) {
    if (state.endTimestamp != null && state.endTimestamp <= now) {
      return {
        ...state,
        endTimestamp: null,
        pausedRemaining: 0
      };
    }
    return state;
  }

  // ============================================================
  // レイアウト計算 (pure)
  // ============================================================
  function clampSize(width, height, bounds) {
    return {
      width: Math.max(bounds.minW, Math.min(bounds.maxW, Math.round(width))),
      height: Math.max(bounds.minH, Math.min(bounds.maxH, Math.round(height)))
    };
  }

  function computeDisplayFontSize(opts) {
    const {
      width,
      height,
      charCount,
      reservedHeight = 240,
      charWidthRatio = 0.6,
      min = 20,
      max = 140
    } = opts;
    const availableWidth = Math.max(40, width - 24);
    const availableHeight = Math.max(28, height - reservedHeight);
    const sizeByWidth = availableWidth / (charCount * charWidthRatio);
    const sizeByHeight = availableHeight * 0.95;
    return Math.max(min, Math.min(max, Math.min(sizeByWidth, sizeByHeight)));
  }

  // ============================================================
  // export
  // ============================================================
  const api = {
    formatTime,
    getRemaining,
    isRunning,
    isFinished,
    transitionStart,
    transitionPause,
    transitionReset,
    transitionRestart,
    transitionAdjust,
    transitionDirectInput,
    transitionTickExpiry,
    clampSize,
    computeDisplayFontSize
  };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (globalScope) {
    globalScope.OverlayTimerLib = api;
  }
})(
  typeof self !== 'undefined'
    ? self
    : typeof global !== 'undefined'
    ? global
    : typeof globalThis !== 'undefined'
    ? globalThis
    : this
);
