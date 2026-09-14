// Тюнер: сходимость, уважение ограничений, детерминизм по сиду и — отдельно — громкие отказы.
// Молчаливый промах здесь опаснее падения: лента уезжает в документ игры и живёт там годами.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldSpecialBounds, setMetrics, specialCountInWindow, specialGap, tuneReels, TunerError
} from '../src/index.ts';
import type { CountBound, ReelTarget, SymbolId, TunerTarget } from '../src/index.ts';
import { MONEY, sample-slot, WILD } from './_fixtures.ts';

const H1 = 20, H2 = 21, M1 = 10, M2 = 11, LA = 1, LK = 2, LQ = 3, LJ = 4;
const SYMBOLS = [WILD, H1, H2, M1, M2, LA, LK, LQ, LJ, MONEY];

const BOX: Record<number, CountBound> = {
  [H1]: { min: 1, max: 4 }, [H2]: { min: 1, max: 5 },
  [M1]: { min: 2, max: 12 }, [M2]: { min: 2, max: 12 },
  [LA]: { min: 4, max: 12 }, [LK]: { min: 4, max: 12 },
  [LQ]: { min: 4, max: 12 }, [LJ]: { min: 4, max: 12 }
};
const reel = (money: number, wild: number, length = 40): ReelTarget => ({
  length, counts: { ...BOX, [MONEY]: { exactly: money }, [WILD]: { exactly: wild } }
});
const plain = (): ReelTarget[] => [reel(0, 1), reel(1, 1), reel(1, 1), reel(1, 1), reel(0, 1)];
const count = (strip: readonly SymbolId[], id: SymbolId): number =>
  strip.filter((v) => v === id).length;

test('сходится к заданному rtp в пределах допуска и уважает счётчики', () => {
  const target: TunerTarget = {
    symbols: SYMBOLS, reels: plain(), rtp: 0.56, rtpTolerance: 0.002, seed: 20260805
  };
  const res = tuneReels(sample-slot, target);
  assert.ok(Math.abs(res.metrics.rtp - 0.56) <= 0.002, `rtp ${res.metrics.rtp}`);
  assert.equal(res.reelset.length, 5);
  for (let r = 0; r < 5; r++) {
    const s = res.reelset[r] as SymbolId[];
    assert.equal(s.length, 40);
    assert.equal(count(s, WILD), 1, `барабан ${r}: ровно один wild`);
    assert.equal(count(s, MONEY), r === 0 || r === 4 ? 0 : 1, `барабан ${r}: спецсимвол по цели`);
    for (const id of [H1, H2, M1, M2, LA, LK, LQ, LJ]) {
      const b = BOX[id] as CountBound;
      const n = count(s, id);
      assert.ok(n >= (b.min as number) && n <= (b.max as number), `барабан ${r}, символ ${id}: ${n}`);
    }
  }
  // Метрики результата — это метрики его лент, а не то, что тюнер думал по дороге.
  const m = setMetrics(sample-slot, res.reelset);
  assert.equal(m.rtp, res.metrics.rtp);
  assert.equal(m.hit, res.metrics.hit);
});

test('детерминирован по сиду; другой сид — другая лента при том же rtp', () => {
  const t = (seed: number): TunerTarget => ({
    symbols: SYMBOLS, reels: plain(), rtp: 0.56, rtpTolerance: 0.002, seed
  });
  const a = tuneReels(sample-slot, t(7));
  const b = tuneReels(sample-slot, t(7));
  assert.deepEqual(a.reelset, b.reelset, 'один сид — одна лента');
  const c = tuneReels(sample-slot, t(8));
  assert.notDeepEqual(a.reelset, c.reelset, 'другой сид — другая раскладка');
  // Состав (а значит и rtp) от сида раскладки не зависит по построению этапов.
  assert.equal(a.metrics.rtp, c.metrics.rtp);
  assert.notEqual(a.metrics.hit, c.metrics.hit);
});

test('цель по hit берётся вторым этапом (порядок → замер → поправка состава)', () => {
  const res = tuneReels(sample-slot, {
    symbols: SYMBOLS, reels: plain(), rtp: 0.56, rtpTolerance: 0.002,
    hit: 0.36, hitTolerance: 0.006, seed: 20260805
  });
  assert.ok(Math.abs(res.metrics.hit - 0.36) <= 0.006, `hit ${res.metrics.hit}`);
  assert.ok(Math.abs(res.metrics.rtp - 0.56) <= 0.002, `rtp ${res.metrics.rtp}`);
  assert.ok(res.rounds > 1, 'поправка по hit обязана была потребовать раундов');
});

test('rtp: max — максимум достижимого при ограничениях, а не молчаливый промах', () => {
  const res = tuneReels(sample-slot, { symbols: SYMBOLS, reels: plain(), rtp: 'max', seed: 3 });
  assert.ok(res.metrics.rtp > 0.56, `потолок ${res.metrics.rtp}`);
  assert.throws(
    () => tuneReels(sample-slot, {
      symbols: SYMBOLS, reels: plain(), rtp: res.metrics.rtp + 0.05, rtpTolerance: 0.002, seed: 3
    }),
    (e: unknown) => {
      assert.ok(e instanceof TunerError);
      assert.match(e.message, /цель выше потолка/);
      assert.equal(e.diagnostics.stage, 'composition');
      assert.ok((e.diagnostics.rtpRange as { max: number }).max > 0);
      return true;
    }
  );
});

test('недостижимая цель по hit — ошибка с достижимым диапазоном, а не тихий промах', () => {
  assert.throws(
    () => tuneReels(sample-slot, {
      symbols: SYMBOLS, reels: plain(), rtp: 0.56, rtpTolerance: 0.002,
      hit: 0.6, hitTolerance: 0.004, seed: 20260805
    }),
    (e: unknown) => {
      assert.ok(e instanceof TunerError);
      assert.match(e.message, /потолок/);
      assert.equal(e.diagnostics.stage, 'hit');
      assert.equal(e.diagnostics.hitTarget, 0.6);
      return true;
    }
  );
});

test('«ровно 1 спецсимвол в окне» при длине, не кратной высоте окна → внятная ошибка', () => {
  const target: TunerTarget = {
    symbols: SYMBOLS,
    reels: [
      { length: 40, counts: { ...BOX, [WILD]: { exactly: 0 } }, special: { exactly: 1 } },
      reel(0, 1), reel(0, 1), reel(0, 1), reel(0, 1)
    ],
    rtp: 'max', seed: 1
  };
  assert.throws(() => tuneReels(sample-slot, target), (e: unknown) => {
    assert.ok(e instanceof TunerError);
    assert.match(e.message, /требует периода 3, а длина ленты 40 на 3 не делится/);
    assert.match(e.message, /ближайшие: 39, 42/);
    assert.equal(e.diagnostics.stage, 'target');
    return true;
  });
  // «Ровно 2 в окне» при высоте 3 не делится уже по окну, а не по длине.
  assert.throws(() => tuneReels(sample-slot, {
    ...target,
    reels: [{ length: 39, counts: { ...BOX, [WILD]: { exactly: 0 } }, special: { exactly: 2 } },
      reel(0, 1), reel(0, 1), reel(0, 1), reel(0, 1)]
  }), /высота окна 3 не делится на 2 нацело/);
});

test('структурные правила раскладки соблюдены конструктивно', () => {
  const structural = (rule: object): ReelTarget => ({
    length: 39, counts: { ...BOX, [WILD]: { exactly: 0 } }, special: rule
  });
  const res = tuneReels(sample-slot, {
    symbols: SYMBOLS,
    reels: [
      structural({ exactly: 1 }), structural({ min: 1 }),
      { length: 39, counts: { ...BOX, [MONEY]: { exactly: 5 }, [WILD]: { exactly: 0 } }, special: { max: 1 } },
      reel(0, 1, 39), reel(0, 1, 39)
    ],
    rtp: 'max', seed: 42
  });
  const [s0, s1, s2] = res.reelset as SymbolId[][];
  assert.equal(specialCountInWindow(s0 as SymbolId[], 3, [MONEY], { exactly: 1 }), null);
  assert.equal(count(s0 as SymbolId[], MONEY), 13, 'период 3 на длине 39');
  assert.equal(specialCountInWindow(s1 as SymbolId[], 3, [MONEY], { min: 1 }), null);
  assert.equal(specialCountInWindow(s2 as SymbolId[], 3, [MONEY], { max: 1 }), null);
  assert.ok(specialGap(s2 as SymbolId[], [MONEY]) >= 3, 'зазор следует из «не более 1 в окне»');
  // Поле: два барабана со структурными спецсимволами дают минимум 2 на любом стоп-сочетании.
  const b = fieldSpecialBounds(res.reelset, 3, [MONEY]);
  assert.ok(b.min >= 2, `минимум на поле ${b.min}`);
  assert.ok(b.max <= 3, `максимум на поле ${b.max}`);
});

test('запрет id и противоречивые ограничения ловятся до расчёта', () => {
  const res = tuneReels(sample-slot, {
    symbols: [...SYMBOLS, 51],
    reels: plain().map((r) => ({ ...r, forbid: [51] })),
    rtp: 0.5, rtpTolerance: 0.01, seed: 5
  });
  for (const s of res.reelset) assert.ok(s.indexOf(51) < 0, 'запрещённый id не попал на ленту');

  assert.throws(() => tuneReels(sample-slot, {
    symbols: SYMBOLS,
    reels: [{ length: 40, counts: { [LA]: { min: 30, max: 10 } } }, reel(0, 1), reel(0, 1), reel(0, 1), reel(0, 1)],
    rtp: 0.5
  }), /ограничения по символу 1 противоречивы/);

  assert.throws(() => tuneReels(sample-slot, {
    symbols: SYMBOLS,
    reels: [{ length: 40, counts: { [LA]: { exactly: 5 }, [LK]: { exactly: 5 } }, forbid: [WILD, H1, H2, M1, M2, LQ, LJ, MONEY] },
      reel(0, 1), reel(0, 1), reel(0, 1), reel(0, 1)],
    rtp: 0.5
  }), /не складываются в ленту длины 40/);
});
