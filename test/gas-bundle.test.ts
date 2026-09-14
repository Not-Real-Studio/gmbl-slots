// GAS-бандл обязан быть плоским файлом для Apps Script: ни import, ни export, ни module.exports,
// ни BigInt-литералов (парсер Apps Script отвергает `1n` файлом целиком). Публичные имена обязаны
// стать глобальными функциями, внутренние — не обязаны существовать вовсе.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { setMetrics } from '../src/index.ts';
import { SMALL, SMALL_REELS } from './_fixtures.ts';

const cwd = fileURLToPath(new URL('..', import.meta.url));
execFileSync('node', ['build-gas.mjs'], { cwd });
const text = readFileSync(fileURLToPath(new URL('../dist/gm-slots.gas.js', import.meta.url)), 'utf8');

test('бандл плоский: ни import/export, ни module.exports, ни BigInt-литералов', () => {
  assert.equal(/^\s*(import|export)\s/m.test(text), false, 'в бандле остались import/export');
  assert.equal(text.includes('module.exports'), false, 'в бандле остался module.exports');
  const literals = text.match(/(?<![A-Za-z0-9_$])\d+n\b/g) ?? [];
  assert.deepEqual(literals, [], `в бандле BigInt-литералы: ${literals.join(', ')}`);
  assert.equal(text.includes('node:'), false, 'в бандле node-only слой');
});

test('бандл поднимает публичные имена глобальными (как в Apps Script) и парсится как ES2020', () => {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx);
  for (const name of ['evaluateTuple', 'evaluateLine', 'evaluatePaylines', 'totalWin',
    'prepareSlot', 'expectedLine', 'expectedLineWin', 'hitRate', 'specialDist', 'triggerProb',
    'setMetrics', 'minComboReels', 'linearRtp', 'linearBlend', 'windowCounts',
    'specialWindowBounds', 'fieldSpecialBounds', 'specialCountInWindow', 'symbolAbsent',
    'minGap', 'allSymbolsPresent', 'validateStrip', 'tuneReels', 'planSpecialPositions',
    'TunerError', 'mulberry32', 'shuffle']) {
    assert.ok(ctx[name] !== undefined, `в бандле нет глобального имени «${name}»`);
  }
  assert.ok(ctx.GmSlots, 'namespace GmSlots тоже доступен');
});

test('бандл считает то же, что исходники (метрика в метрику)', () => {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx);
  const bundled = (ctx.setMetrics as typeof setMetrics)(SMALL, SMALL_REELS);
  const local = setMetrics(SMALL, SMALL_REELS);
  assert.ok(Object.is(bundled.rtp, local.rtp), `${bundled.rtp} ≠ ${local.rtp}`);
  assert.ok(Object.is(bundled.hit, local.hit));
  // Массив приезжает из чужого realm — сравниваем значения, а не прототипы.
  assert.deepEqual([...bundled.specialDist], [...local.specialDist]);
});
