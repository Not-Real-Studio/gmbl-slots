// Фикстуры тестов.
//
// sample-slot — слот-донор механики (Sample Slot): его константы перенесены дословно, на нём
// гоняются фикстуры оценки линии. Совпадение с движком игры — то, ради чего перенос вообще
// считается переносом, а не переписыванием.
//
// SMALL — мелкий слот (3 барабана, лента 10, окно 2), на котором полный перебор len^reels гридов
// выполним за миллисекунды: против него сверяются ВСЕ точные формулы басиса.

import type { SlotSpec, SymbolId } from '../src/index.ts';

export const WILD = 0;
export const MONEY = 50;
export const JACKPOTS = [51, 52, 53, 54];

/** Sample Slot — src/game.js, единица = сотая доля ставки, базовая ставка 100. */
export const sample-slot: SlotSpec = {
  rows: 3,
  reels: 5,
  bet: 100,
  wildId: WILD,
  specialIds: [MONEY],
  paytable: {
    0: { 3: 200, 4: 600, 5: 2000 },
    20: { 3: 150, 4: 450, 5: 1500 },
    21: { 3: 120, 4: 350, 5: 1200 },
    10: { 3: 80, 4: 250, 5: 800 },
    11: { 3: 60, 4: 200, 5: 600 },
    1: { 3: 35, 4: 100, 5: 300 },
    2: { 3: 30, 4: 90, 5: 250 },
    3: { 3: 25, 4: 75, 5: 200 },
    4: { 3: 20, 4: 60, 5: 150 }
  },
  lines: [
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
    [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 1, 0, 1],
    [1, 0, 1, 2, 1], [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2]
  ]
};

/** Грид 5×3 из «верхнего ряда» ids: остальные ряды — рвущий символ. */
export function topRow(ids: readonly SymbolId[], breaker: SymbolId = MONEY): SymbolId[][] {
  const f: SymbolId[][] = [];
  for (let r = 0; r < ids.length; r++) f.push([ids[r] as SymbolId, breaker, breaker]);
  return f;
}
export const TOP_LINE = [0, 0, 0, 0, 0];

/** Мелкий слот под полный перебор: 3 барабана, окно 2, лента 10 позиций. */
export const SMALL: SlotSpec = {
  rows: 2,
  reels: 3,
  bet: 10,
  wildId: 0,
  specialIds: [9],
  paytable: {
    0: { 2: 20, 3: 60 },
    1: { 3: 12 },
    2: { 2: 3, 3: 8 }
  },
  lines: [[0, 0, 0], [1, 1, 1], [0, 1, 0], [1, 0, 1]]
};

/** Три ленты по 10 позиций: wild, два платящих, спецсимвол, наполнитель. */
export const SMALL_REELS: SymbolId[][] = [
  [1, 2, 3, 0, 2, 9, 1, 3, 2, 1],
  [2, 1, 9, 3, 0, 1, 2, 2, 3, 1],
  [3, 2, 1, 1, 9, 2, 0, 3, 1, 2]
];

/** Полный перебор гридов мелкого слота: точные RTP, hit и распределение спецсимволов. */
export function bruteForce(
  slot: SlotSpec, reelset: readonly (readonly SymbolId[])[],
  evaluate: (field: SymbolId[][], slot: SlotSpec) => { win: number }[]
): { rtp: number; hit: number; dist: number[] } {
  const R = reelset.length;
  let stops = 1;
  for (const s of reelset) stops *= s.length;
  let sum = 0;
  let hits = 0;
  const dist: number[] = [];
  const idx: number[] = new Array(R).fill(0);
  for (let n = 0; n < stops; n++) {
    const field: SymbolId[][] = [];
    let special = 0;
    for (let r = 0; r < R; r++) {
      const s = reelset[r] as readonly SymbolId[];
      const col: SymbolId[] = [];
      for (let row = 0; row < slot.rows; row++) {
        const id = s[((idx[r] as number) + row) % s.length] as SymbolId;
        col.push(id);
        if (slot.specialIds.indexOf(id) >= 0) special++;
      }
      field.push(col);
    }
    const wins = evaluate(field, slot);
    let win = 0;
    for (const w of wins) win += w.win;
    sum += win;
    if (wins.length) hits++;
    dist[special] = (dist[special] || 0) + 1;
    for (let r = 0; r < R; r++) {
      const s = reelset[r] as readonly SymbolId[];
      const next = (idx[r] as number) + 1;
      if (next < s.length) { idx[r] = next; break; }
      idx[r] = 0;
    }
  }
  const out: number[] = [];
  for (let k = 0; k < slot.rows * R + 1; k++) out.push((dist[k] || 0) / stops);
  return { rtp: sum / stops / slot.bet, hit: hits / stops, dist: out };
}
