// Оценка линии на синтетической фикстуре SAMPLE. Результаты
// обязаны совпасть — иначе это не перенос механики, а её переписывание.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLine, evaluatePaylines, evaluateTuple, totalWin } from '../src/index.ts';
import { JACKPOTS, MONEY, SAMPLE, TOP_LINE, WILD, topRow } from './_fixtures.ts';

const TB = 100;
const pt = SAMPLE.paytable;
const evalTop = (ids: number[]): { symbol: number; length: number; win: number } | null =>
  evaluateLine(topRow(ids), TOP_LINE, SAMPLE);

test('каждый платящий символ × каждая длина = paytable', () => {
  for (const sym of Object.keys(pt)) {
    const id = Number(sym);
    for (const len of [3, 4, 5]) {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) ids.push(i < len ? id : (id === MONEY ? WILD : MONEY));
      const w = evalTop(ids);
      assert.ok(w, `символ ${id}, длина ${len}: ожидался выигрыш`);
      assert.equal(w.win, (pt[id] as Record<number, number>)[len], `символ ${id}, длина ${len}`);
      assert.equal(w.length, len);
      assert.equal(w.symbol, id);
    }
  }
});

test('длина 1–2 не платит', () => {
  assert.equal(evalTop([20, MONEY, MONEY, MONEY, MONEY]), null);
  assert.equal(evalTop([20, 20, MONEY, MONEY, MONEY]), null);
});

test('wild платит сам: линия из пяти wild = 10 ×TB', () => {
  const w = evalTop([WILD, WILD, WILD, WILD, WILD]);
  assert.equal(w?.symbol, WILD);
  assert.equal(w?.win, 10 * TB);
});

test('wild подменяет платящий символ', () => {
  const w = evalTop([20, WILD, 20, MONEY, MONEY]);
  assert.equal(w?.symbol, 20);
  assert.equal(w?.length, 3);
  assert.equal(w?.win, (pt[20] as Record<number, number>)[3]);
});

test('на линию платится ОДНА лучшая комбинация из двух кандидатов', () => {
  const cheap = evalTop([WILD, WILD, WILD, 4, 4]);
  assert.equal(cheap?.symbol, WILD, 'дороже wild-тройка');
  assert.equal(cheap?.win, (pt[WILD] as Record<number, number>)[3]);
  const rich = evalTop([WILD, WILD, 20, 20, 20]);
  assert.equal(rich?.symbol, 20);
  assert.equal(rich?.win, (pt[20] as Record<number, number>)[5]);
});

test('спецсимвол рвёт комбинацию и сам не платит', () => {
  assert.equal(evalTop([20, 20, MONEY, 20, 20]), null);
  assert.equal(evalTop([MONEY, MONEY, MONEY, 20, 20]), null, 'спецсимвол кандидатом быть не может');
  assert.equal(evalTop([20, 20, 20, MONEY, 20])?.length, 3, 'серия обрывается на спецсимволе');
});

test('символ без строки paytable рвёт комбинацию (джекпоты BG)', () => {
  for (const jid of JACKPOTS) {
    assert.equal(evalTop([20, 20, jid, 20, 20]), null, 'джекпот ' + jid);
    assert.equal(evalTop([jid, jid, jid, jid, jid]), null, 'джекпот ' + jid + ' сам не платит');
  }
});

test('потолок: полное поле wild = 100 ×TB на 10 линиях', () => {
  const full: number[][] = [];
  for (let r = 0; r < 5; r++) full.push([WILD, WILD, WILD]);
  const wins = evaluatePaylines(full, SAMPLE);
  assert.equal(wins.length, SAMPLE.lines.length);
  assert.equal(totalWin(wins), 100 * TB);
  assert.equal(evaluateLine(full, [0, 1, 2, 1, 0], SAMPLE)?.symbol, WILD);
});

test('evaluateLine — обёртка над evaluateTuple: одна логика, два входа', () => {
  const ids = [WILD, 20, 20, 4, 4];
  const t = evaluateTuple(ids, SAMPLE);
  const l = evaluateLine(topRow(ids), TOP_LINE, SAMPLE);
  assert.equal(t?.win, l?.win);
  assert.equal(t?.symbol, l?.symbol);
  assert.equal(t?.length, l?.length);
  assert.deepEqual(l?.cells, [[0, 0], [1, 0], [2, 0]]);
});
