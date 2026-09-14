// Басис против полного перебора гридов. Сравнение ТОЧНОЕ (до эпсилона плавающей арифметики),
// а не «в пределах SEM»: обе стороны считают одну и ту же величину, просто разной ценой.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePaylines, expectedLineWin, hitRate, linearBlend, linearRtp, minComboReels, prepareSlot,
  setMetrics, specialDist, stripFreq, triggerProb
} from '../src/index.ts';
import type { SetMetrics, SlotSpec, SymbolId } from '../src/index.ts';
import { sample-slot, SMALL, SMALL_REELS, bruteForce } from './_fixtures.ts';

const EPS = 1e-12;
const brute = bruteForce(SMALL, SMALL_REELS, (f, s) => evaluatePaylines(f, s));

test('rtp = полный перебор гридов (не приближение)', () => {
  const m = setMetrics(SMALL, SMALL_REELS);
  assert.ok(Math.abs(m.rtp - brute.rtp) < EPS, `${m.rtp} ≠ ${brute.rtp}`);
  // и то же через E[линии] напрямую
  const rtp = expectedLineWin(SMALL, SMALL_REELS) * SMALL.lines.length / SMALL.bet;
  assert.ok(Math.abs(rtp - brute.rtp) < EPS);
});

test('hit = полный перебор гридов', () => {
  const m = setMetrics(SMALL, SMALL_REELS);
  assert.ok(Math.abs(m.hit - brute.hit) < EPS, `${m.hit} ≠ ${brute.hit}`);
  // перебор идёт по минимальной платящей длине, а не по всем барабанам
  const h = hitRate(SMALL, SMALL_REELS);
  assert.equal(h.reels, minComboReels(SMALL));
  assert.equal(h.stops, Math.pow(10, h.reels));
});

test('распределение спецсимвола: свёртка окон = перебор', () => {
  const dist = specialDist(SMALL, SMALL_REELS);
  let sum = 0;
  for (let k = 0; k < brute.dist.length; k++) {
    const a = dist[k] || 0;
    const b = brute.dist[k] as number;
    assert.ok(Math.abs(a - b) < EPS, `k=${k}: ${a} ≠ ${b}`);
    sum += a;
  }
  assert.ok(Math.abs(sum - 1) < EPS, `распределение не нормировано: ${sum}`);
});

test('перестановка ленты не меняет rtp, но меняет hit — на этом стоит тюнер', () => {
  const a = setMetrics(SMALL, SMALL_REELS);

  // Сортировка ленты первого барабана: состав тот же, порядок другой.
  const sorted = SMALL_REELS.map((s) => s.slice());
  (sorted[0] as SymbolId[]).sort((x, y) => x - y);
  const b = setMetrics(SMALL, sorted);
  assert.ok(Math.abs(a.rtp - b.rtp) < EPS, `rtp обязан совпасть: ${a.rtp} ≠ ${b.rtp}`);
  assert.notEqual(a.hit, b.hit, 'hit обязан зависеть от порядка');

  // Циклический сдвиг — не перестановка «по существу»: стопы равномерны, метрики обязаны совпасть
  // ВСЕ, включая зависящие от порядка.
  const rolled = SMALL_REELS.map((s) => s.slice());
  const r0 = rolled[0] as SymbolId[];
  r0.push(r0.shift() as SymbolId);
  const c = setMetrics(SMALL, rolled);
  assert.ok(Math.abs(a.rtp - c.rtp) < EPS);
  assert.ok(Math.abs(a.hit - c.hit) < EPS, 'сдвиг ленты ничего не меняет');
  assert.deepEqual(c.specialDist, a.specialDist);
});

test('правило гейта: триггер и антиципация считаются по переданному описанию', () => {
  const gate = { guaranteed: 3, probByCount: { '1': 0.1, '2': 0.5 }, anticipationCounts: [2] };
  const m = setMetrics(SMALL, SMALL_REELS, { gate });
  const d = m.specialDist;
  let want = 0;
  for (let c = 3; c < d.length; c++) want += d[c] as number;
  want += (d[1] as number) * 0.1 + (d[2] as number) * 0.5;
  assert.ok(Math.abs(m.pTrigger - want) < EPS);
  assert.ok(Math.abs(m.pAnticipation - (d[2] as number)) < EPS);
  assert.ok(Math.abs(m.trigger1n - 1 / want) < EPS);
  assert.equal(triggerProb(d, undefined), 0, 'без правила гейта триггера нет');
  assert.equal(setMetrics(SMALL, SMALL_REELS).trigger1n, 0);
});

test('linearRtp: свёртка басиса по весам = взвешенное среднее', () => {
  const metrics: Record<string, SetMetrics> = {
    a: setMetrics(SMALL, SMALL_REELS),
    b: setMetrics(SMALL, SMALL_REELS.map((s) => s.slice().reverse()))
  };
  const rtp = linearRtp(metrics, { a: 3, b: 1 });
  const want = 0.75 * (metrics.a as SetMetrics).rtp + 0.25 * (metrics.b as SetMetrics).rtp;
  assert.ok(Math.abs(rtp - want) < EPS);
  const blend = linearBlend(metrics, { a: 3, b: 1 });
  assert.ok(Math.abs(blend.hit - (0.75 * (metrics.a as SetMetrics).hit + 0.25 * (metrics.b as SetMetrics).hit)) < EPS);
  assert.throws(() => linearRtp(metrics, { c: 1 }), /метрик по нему нет/);
  assert.throws(() => linearRtp(metrics, { a: 0 }), /сумма весов/);
});

test('символ вне paytable — обычный рвущий наполнитель, а не дыра в расчёте', () => {
  // Басис не знает списка символов игры: id без строки paytable просто не платит и рвёт серию.
  // Запрет конкретных id — дело валидатора (validate.symbolAbsent), а не арифметики.
  const filler = SMALL_REELS.map((s) => s.slice());
  (filler[0] as SymbolId[])[0] = 777;
  const m = setMetrics(SMALL, filler);
  assert.ok(m.rtp > 0 && m.rtp < 1);
  // А вот подсунуть чужой id в готовый контекст нельзя: тюнер обязан падать, а не считать мимо.
  const ctx = prepareSlot(SMALL);
  assert.throws(() => stripFreq(ctx, [777, 1, 2]), /вне алфавита слота/);
});

test('потолок перебора hit заявлен явно', () => {
  const long: SymbolId[][] = [];
  for (let r = 0; r < 5; r++) {
    const s: SymbolId[] = [];
    for (let i = 0; i < 200; i++) s.push(i % 2 === 0 ? 20 : 4);
    long.push(s);
  }
  assert.throws(() => hitRate(sample-slot, long), /стоп-сочетаний по 3 барабанам \(потолок/);
});
