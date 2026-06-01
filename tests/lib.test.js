const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');

// ============================================================
// formatTime
// ============================================================
describe('formatTime', () => {
  test('0 秒 → "00:00"', () => {
    assert.equal(lib.formatTime(0), '00:00');
  });

  test('負の値は 0 にクランプ', () => {
    assert.equal(lib.formatTime(-10), '00:00');
  });

  test('1 秒未満は切り上げて "00:01"', () => {
    assert.equal(lib.formatTime(0.1), '00:01');
    assert.equal(lib.formatTime(0.9), '00:01');
  });

  test('60 秒 → "01:00"', () => {
    assert.equal(lib.formatTime(60), '01:00');
  });

  test('mm:ss フォーマット (1 時間未満)', () => {
    assert.equal(lib.formatTime(65), '01:05');
    assert.equal(lib.formatTime(599), '09:59');
  });

  test('hh:mm:ss フォーマット (1 時間以上)', () => {
    assert.equal(lib.formatTime(3600), '01:00:00');
    assert.equal(lib.formatTime(3661), '01:01:01');
    assert.equal(lib.formatTime(7325), '02:02:05');
  });
});

// ============================================================
// isRunning / getRemaining / isFinished
// ============================================================
describe('isRunning', () => {
  test('endTimestamp が null なら false', () => {
    assert.equal(lib.isRunning({ endTimestamp: null }, 1000), false);
  });

  test('endTimestamp が未来なら true', () => {
    assert.equal(lib.isRunning({ endTimestamp: 2000 }, 1000), true);
  });

  test('endTimestamp が過去なら false', () => {
    assert.equal(lib.isRunning({ endTimestamp: 500 }, 1000), false);
  });

  test('endTimestamp が現在時刻と等しいなら false', () => {
    assert.equal(lib.isRunning({ endTimestamp: 1000 }, 1000), false);
  });
});

describe('getRemaining', () => {
  test('停止中は pausedRemaining を返す', () => {
    assert.equal(lib.getRemaining({ endTimestamp: null, pausedRemaining: 60 }, 1000), 60);
  });

  test('実行中は endTimestamp から算出', () => {
    assert.equal(lib.getRemaining({ endTimestamp: 11000, pausedRemaining: 999 }, 1000), 10);
  });

  test('endTimestamp が過去なら 0 を返す (pausedRemaining は無視)', () => {
    assert.equal(lib.getRemaining({ endTimestamp: 500, pausedRemaining: 999 }, 1000), 0);
  });
});

describe('isFinished', () => {
  test('endTimestamp が過去で initialSeconds>0 なら true', () => {
    assert.equal(
      lib.isFinished({ endTimestamp: 500, pausedRemaining: 100, initialSeconds: 100 }, 1000),
      true
    );
  });

  test('pausedRemaining=0 でも initialSeconds>0 なら true', () => {
    assert.equal(
      lib.isFinished({ endTimestamp: null, pausedRemaining: 0, initialSeconds: 100 }, 1000),
      true
    );
  });

  test('実行中は false', () => {
    assert.equal(
      lib.isFinished({ endTimestamp: 2000, pausedRemaining: 1, initialSeconds: 60 }, 1000),
      false
    );
  });

  test('initialSeconds=0 のときは false (一度も時間が設定されていない)', () => {
    assert.equal(
      lib.isFinished({ endTimestamp: null, pausedRemaining: 0, initialSeconds: 0 }, 1000),
      false
    );
  });

  test('一時停止中で残り時間あり → false', () => {
    assert.equal(
      lib.isFinished({ endTimestamp: null, pausedRemaining: 30, initialSeconds: 60 }, 1000),
      false
    );
  });
});

// ============================================================
// state transitions
// ============================================================
describe('transitionStart', () => {
  test('pausedRemaining からカウントダウン開始', () => {
    const state = { endTimestamp: null, pausedRemaining: 60, initialSeconds: 300 };
    const next = lib.transitionStart(state, 1000);
    assert.equal(next.endTimestamp, 61000);
    assert.equal(next.pausedRemaining, 60);
    assert.equal(next.initialSeconds, 300);
  });

  test('pausedRemaining=0 なら initialSeconds にフォールバック', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 300 };
    const next = lib.transitionStart(state, 1000);
    assert.equal(next.endTimestamp, 301000);
    assert.equal(next.pausedRemaining, 300);
  });

  test('両方 0 なら no-op (同じ参照を返す)', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 0 };
    assert.strictEqual(lib.transitionStart(state, 1000), state);
  });
});

describe('transitionPause', () => {
  test('残り時間を保存して endTimestamp を null に', () => {
    const state = { endTimestamp: 11000, pausedRemaining: 60, initialSeconds: 60 };
    const next = lib.transitionPause(state, 1000);
    assert.equal(next.endTimestamp, null);
    assert.equal(next.pausedRemaining, 10);
  });

  test('実行中でなければ no-op', () => {
    const state = { endTimestamp: null, pausedRemaining: 60, initialSeconds: 60 };
    assert.strictEqual(lib.transitionPause(state, 1000), state);
  });
});

describe('transitionReset', () => {
  test('pausedRemaining を initialSeconds に戻して停止', () => {
    const state = { endTimestamp: 11000, pausedRemaining: 30, initialSeconds: 300 };
    const next = lib.transitionReset(state);
    assert.deepEqual(next, {
      endTimestamp: null,
      pausedRemaining: 300,
      initialSeconds: 300
    });
  });
});

describe('transitionRestart', () => {
  test('指定秒数で initialSeconds・pausedRemaining・endTimestamp を更新', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 300 };
    const next = lib.transitionRestart(state, 60, 1000);
    assert.equal(next.initialSeconds, 60);
    assert.equal(next.pausedRemaining, 60);
    assert.equal(next.endTimestamp, 61000);
  });

  test('seconds <= 0 なら no-op', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 300 };
    assert.strictEqual(lib.transitionRestart(state, 0, 1000), state);
    assert.strictEqual(lib.transitionRestart(state, -10, 1000), state);
  });
});

describe('transitionAdjust', () => {
  test('実行中: 残り時間を増やして endTimestamp を更新', () => {
    const state = { endTimestamp: 11000, pausedRemaining: 60, initialSeconds: 60 };
    const next = lib.transitionAdjust(state, 60, 1000);
    assert.equal(next.endTimestamp, 71000);
    assert.equal(next.pausedRemaining, 70);
  });

  test('実行中: 残り時間が 1 秒未満になる調整は no-op', () => {
    const state = { endTimestamp: 1500, pausedRemaining: 0.5, initialSeconds: 60 };
    assert.strictEqual(lib.transitionAdjust(state, -10, 1000), state);
  });

  test('終了状態 + delta>0: 自動再開せず、その秒数で停止状態にする', () => {
    const state = { endTimestamp: 500, pausedRemaining: 100, initialSeconds: 100 };
    const next = lib.transitionAdjust(state, 60, 1000);
    assert.equal(next.initialSeconds, 60);
    assert.equal(next.pausedRemaining, 60);
    assert.equal(next.endTimestamp, null);
  });

  test('終了状態 + delta<0 は通常の増減フォールスルー (initialSeconds 0 から負は 0)', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 100 };
    const next = lib.transitionAdjust(state, -60, 1000);
    // isFinished + delta>0 ではないので「通常の増減」分岐
    assert.equal(next.initialSeconds, 40);
    assert.equal(next.pausedRemaining, 40);
  });

  test('停止中: 設定時間を増減', () => {
    const state = { endTimestamp: null, pausedRemaining: 60, initialSeconds: 60 };
    const next = lib.transitionAdjust(state, 60, 1000);
    assert.equal(next.initialSeconds, 120);
    assert.equal(next.pausedRemaining, 120);
  });

  test('停止中: 0 未満にクランプ', () => {
    const state = { endTimestamp: null, pausedRemaining: 30, initialSeconds: 30 };
    const next = lib.transitionAdjust(state, -120, 1000);
    assert.equal(next.initialSeconds, 0);
    assert.equal(next.pausedRemaining, 0);
  });
});

describe('transitionDirectInput', () => {
  test('m と s から initialSeconds を計算し endTimestamp をクリア', () => {
    const state = { endTimestamp: 11000, pausedRemaining: 60, initialSeconds: 60 };
    const next = lib.transitionDirectInput(state, 5, 30);
    assert.equal(next.initialSeconds, 330);
    assert.equal(next.pausedRemaining, 330);
    assert.equal(next.endTimestamp, null);
  });

  test('分を 0-999 にクランプ', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 0 };
    const next = lib.transitionDirectInput(state, 1000, 0);
    assert.equal(next.initialSeconds, 999 * 60);
  });

  test('秒を 0-59 にクランプ', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 0 };
    const next = lib.transitionDirectInput(state, 0, 70);
    assert.equal(next.initialSeconds, 59);
  });

  test('文字列入力も数値として処理', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 0 };
    const next = lib.transitionDirectInput(state, '3', '15');
    assert.equal(next.initialSeconds, 195);
  });

  test('NaN / 不正値は 0 として扱う', () => {
    const state = { endTimestamp: null, pausedRemaining: 0, initialSeconds: 0 };
    const next = lib.transitionDirectInput(state, 'abc', null);
    assert.equal(next.initialSeconds, 0);
  });
});

describe('transitionTickExpiry', () => {
  test('endTimestamp が過去なら終了状態に遷移', () => {
    const state = { endTimestamp: 500, pausedRemaining: 100, initialSeconds: 100 };
    const next = lib.transitionTickExpiry(state, 1000);
    assert.equal(next.endTimestamp, null);
    assert.equal(next.pausedRemaining, 0);
  });

  test('endTimestamp が未来なら no-op', () => {
    const state = { endTimestamp: 2000, pausedRemaining: 100, initialSeconds: 100 };
    assert.strictEqual(lib.transitionTickExpiry(state, 1000), state);
  });

  test('endTimestamp が null なら no-op', () => {
    const state = { endTimestamp: null, pausedRemaining: 100, initialSeconds: 100 };
    assert.strictEqual(lib.transitionTickExpiry(state, 1000), state);
  });
});

// ============================================================
// layout helpers
// ============================================================
describe('clampSize', () => {
  const bounds = { minW: 180, maxW: 640, minH: 240, maxH: 640 };

  test('範囲内ならそのまま', () => {
    assert.deepEqual(lib.clampSize(320, 320, bounds), { width: 320, height: 320 });
  });

  test('小さすぎる値は最小値にクランプ', () => {
    assert.deepEqual(lib.clampSize(100, 100, bounds), { width: 180, height: 240 });
  });

  test('大きすぎる値は最大値にクランプ', () => {
    assert.deepEqual(lib.clampSize(1000, 1000, bounds), { width: 640, height: 640 });
  });

  test('小数値は四捨五入', () => {
    assert.deepEqual(lib.clampSize(320.4, 320.6, bounds), { width: 320, height: 321 });
  });
});

describe('computeDisplayFontSize', () => {
  test('通常範囲のサイズを返す', () => {
    const size = lib.computeDisplayFontSize({ width: 240, height: 280, charCount: 5 });
    assert.ok(size >= 20 && size <= 140, `expected 20<=size<=140, got ${size}`);
  });

  test('小さい枠サイズでは min にクランプ', () => {
    const size = lib.computeDisplayFontSize({
      width: 50,
      height: 240,
      charCount: 5,
      min: 20
    });
    assert.equal(size, 20);
  });

  test('大きい枠サイズでは max にクランプ', () => {
    const size = lib.computeDisplayFontSize({
      width: 2000,
      height: 2000,
      charCount: 5,
      max: 140
    });
    assert.equal(size, 140);
  });

  test('文字数が増えると幅由来でサイズが小さくなる', () => {
    const small = lib.computeDisplayFontSize({ width: 300, height: 280, charCount: 5 });
    const large = lib.computeDisplayFontSize({ width: 300, height: 280, charCount: 8 });
    assert.ok(large <= small, `expected size to decrease as charCount grows`);
  });
});
