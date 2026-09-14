// Оценка линии линейного слота. Перенос из SAMPLE (src/evaluate.js) без изменения семантики:
// кандидаты «первый не-wild символ» + «сам wild, если линия начинается с wild», wild подменяет и
// платит по своей строке paytable, на линию платится ОДНА самая дорогая комбинация, спецсимвол
// (нет строки в paytable) рвёт серию и кандидатом быть не может.
//
// Единственная реализация — `evaluateTuple` по кортежу символов. `evaluateLine` (грид + маска
// рядов) — тонкая обёртка над ней: басису нужен кортеж без грида, игре — грид, а двойника логики
// в паре «пакет/движок» держать нельзя.

import type { Paytable, SymbolId } from './types.ts';

/** Что от слота нужно оценке линии — и ничего больше. */
export interface EvalSpec {
  wildId: SymbolId;
  paytable: Paytable;
}

/** Выигрыш комбинации на кортеже символов. */
export interface TupleWin {
  symbol: SymbolId;
  length: number;
  win: number;
}

/** Выигрыш линии на гриде: тот же кортеж + ячейки поля. */
export interface LineWin extends TupleWin {
  /** [[барабан, ряд], ...] по длине комбинации. */
  cells: number[][];
  /** 1-based номер линии; проставляет evaluatePaylines. */
  line?: number;
}

/** Грид: field[барабан][ряд] = id символа. */
export type Field = readonly (readonly SymbolId[])[];

// Длина ведущей серии кандидата sym слева. Wild засчитывается за кандидата, кроме случая
// «кандидат сам wild» — тогда серию продолжают только wild.
function runLength(ids: readonly SymbolId[], sym: SymbolId, wild: SymbolId): number {
  let len = 0;
  for (let r = 0; r < ids.length; r++) {
    const id = ids[r] as SymbolId;
    if (id === sym || (sym !== wild && id === wild)) len++;
    else break;
  }
  return len;
}

function candidate(
  ids: readonly SymbolId[], sym: SymbolId, wild: SymbolId, pt: Paytable
): TupleWin | null {
  const table = pt[sym];
  if (!table) return null;
  const len = runLength(ids, sym, wild);
  const win = table[len] || 0;
  if (win <= 0) return null;
  return { symbol: sym, length: len, win };
}

/**
 * Оценка кортежа символов одной линии. Возвращает лучшую комбинацию или null.
 * При равенстве выплат побеждает кандидат-wild — как в исходнике (строгое `>`).
 */
export function evaluateTuple(ids: readonly SymbolId[], slot: EvalSpec): TupleWin | null {
  const wild = slot.wildId;
  const pt = slot.paytable;
  let best: TupleWin | null = null;

  if (ids[0] === wild) best = candidate(ids, wild, wild, pt);

  let sym = -1;
  for (let r = 0; r < ids.length; r++) {
    const id = ids[r] as SymbolId;
    if (id !== wild) { sym = id; break; }
  }
  if (sym >= 0) {
    const c = candidate(ids, sym, wild, pt);
    if (c && (!best || c.win > best.win)) best = c;
  }
  return best;
}

/** Оценка одной линии грида по маске рядов. */
export function evaluateLine(field: Field, line: readonly number[], slot: EvalSpec): LineWin | null {
  const ids: SymbolId[] = [];
  for (let r = 0; r < line.length; r++) {
    ids.push((field[r] as readonly SymbolId[])[line[r] as number] as SymbolId);
  }
  const w = evaluateTuple(ids, slot);
  if (!w) return null;
  const cells: number[][] = [];
  for (let i = 0; i < w.length; i++) cells.push([i, line[i] as number]);
  return { symbol: w.symbol, length: w.length, win: w.win, cells };
}

/** Оценка всех линий слота. Номер линии в результате 1-based. */
export function evaluatePaylines(
  field: Field, slot: EvalSpec & { lines: readonly (readonly number[])[] }
): LineWin[] {
  const wins: LineWin[] = [];
  for (let li = 0; li < slot.lines.length; li++) {
    const w = evaluateLine(field, slot.lines[li] as readonly number[], slot);
    if (w) { w.line = li + 1; wins.push(w); }
  }
  return wins;
}

/** Сумма выплат линий. */
export function totalWin(wins: readonly TupleWin[]): number {
  let sum = 0;
  for (let i = 0; i < wins.length; i++) sum += (wins[i] as TupleWin).win;
  return sum;
}
