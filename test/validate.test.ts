// Предикаты лент. Тот же код гоняет тюнер на этапе раскладки — поэтому важно, что предикаты
// ловят нарушения, а не подтверждают то, что и так построено конструктивно.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSymbolsPresent, fieldSpecialBounds, minGap, onlyKnownSymbols, planSpecialPositions,
  specialCountInWindow, specialGap, specialPositions, specialWindowBounds, symbolAbsent,
  validateStrip, mulberry32
} from '../src/index.ts';

const SP = [50];

test('окно: границы числа спецсимволов считаются по всем стопам циклически', () => {
  const strip = [50, 1, 2, 50, 3, 4, 1, 2, 50, 3]; // длина 10
  const b = specialWindowBounds(strip, 3, SP);
  assert.equal(b.counts.length, 10);
  assert.equal(b.min, 0);
  assert.equal(b.max, 2, 'окно [8,9,0] собирает две');
  assert.deepEqual(specialPositions(strip, SP), [0, 3, 8]);
});

test('«ровно k в окне» / «не менее» / «не более» — предикаты, а не пожелания', () => {
  const step3 = [50, 1, 2, 50, 3, 4, 50, 1, 2]; // длина 9, период 3
  assert.equal(specialCountInWindow(step3, 3, SP, { exactly: 1 }), null);
  assert.match(specialCountInWindow(step3, 3, SP, { exactly: 2 }) as string, /ровно 2/);
  assert.equal(specialCountInWindow(step3, 3, SP, { min: 1 }), null);
  assert.equal(specialCountInWindow(step3, 3, SP, { max: 1 }), null);

  const packed = [50, 50, 1, 2, 3, 4, 1, 2, 3];
  assert.match(specialCountInWindow(packed, 3, SP, { max: 1 }) as string, /не более 1/);
  assert.match(specialCountInWindow(packed, 3, SP, { min: 1 }) as string, /не менее 1/);
  assert.equal(specialGap(packed, SP), 1);
  assert.match(minGap(packed, SP, 3) as string, /зазор между спецсимволами 1 < требуемого 3/);
  assert.equal(minGap(step3, SP, 3), null);
});

test('запрет id, алфавит и обязательное присутствие', () => {
  const strip = [1, 2, 3, 4, 20, 21, 10, 11, 0, 50];
  assert.equal(symbolAbsent(strip, [51, 52]), null);
  assert.match(symbolAbsent(strip, [51, 50]) as string, /символ 50 запрещён/);
  assert.equal(allSymbolsPresent(strip, [1, 2, 0]), null);
  assert.match(allSymbolsPresent(strip, [1, 99]) as string, /нет символов: 99/);
  assert.match(onlyKnownSymbols(strip, [1, 2, 3]) as string, /вне алфавита/);
});

test('границы спецсимволов на поле — сумма границ по барабанам', () => {
  const step3 = [50, 1, 2, 50, 3, 4, 50, 1, 2];
  const none = [1, 2, 3, 4, 1, 2, 3, 4, 1];
  const bounds = fieldSpecialBounds([step3, step3, none, none, none], 3, SP);
  assert.deepEqual(bounds, { min: 2, max: 2 });
});

test('validateStrip собирает все нарушения разом', () => {
  const strip = [50, 50, 1, 2, 3, 4, 1, 2, 3, 51];
  const bad = validateStrip(strip, {
    rows: 3, specialIds: SP, window: { max: 1, minGap: 3 }, forbid: [51],
    symbols: [50, 1, 2, 3, 4, 20], requireAll: true, counts: { 1: 5 }
  });
  // окно, зазор, запрет 51, 51 вне алфавита, нет символа 20, счётчик символа 1
  assert.equal(bad.length, 6, bad.join(' | '));
  assert.equal(validateStrip([1, 2, 3, 1, 2, 3], { rows: 3, specialIds: SP }).length, 0);
});

test('раскладка спецсимволов: период для «ровно k», равномерный разброс иначе', () => {
  const rng = mulberry32(1);
  const step = planSpecialPositions(39, 3, { exactly: 1 }, 13, rng);
  assert.equal(step.length, 13);
  for (let i = 1; i < step.length; i++) {
    assert.equal(((step[i] as number) - (step[i - 1] as number) + 39) % 39, 3);
  }
  const spread = planSpecialPositions(40, 3, { max: 1 }, 5, rng);
  assert.equal(spread.length, 5);
  assert.equal(new Set(spread).size, 5, 'позиции не накладываются');
  assert.equal(planSpecialPositions(40, 3, undefined, 0, rng).length, 0);
});
