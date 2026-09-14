// Структурные предикаты лент. Тюнер соблюдает ровно эти правила на этапе раскладки, а проверка
// чужих лент гоняет ровно эти функции — двух формулировок одного правила в природе быть не должно.
//
// Каждый предикат возвращает строку-нарушение или null («претензий нет»): так нарушения
// складываются в отчёт, а вызывающий сам решает, падать громко или показывать список.
//
// Метод — точный, без перебора len^reels: число спецсимволов на поле есть сумма независимых
// слагаемых по барабанам, поэтому границы «на ЛЮБОМ стоп-сочетании» = сумма границ по барабанам.

import { windowCounts } from './basis.ts';
import type { ReelSpec, Strip, SymbolId, WindowRule } from './types.ts';

/** Границы числа спецсимволов в окне барабана по всем его стопам. */
export interface WindowBounds {
  min: number;
  max: number;
  counts: number[];
}

export function specialWindowBounds(
  strip: Strip, rows: number, specialIds: readonly SymbolId[]
): WindowBounds {
  const counts = windowCounts(strip, rows, specialIds);
  let min = Infinity;
  let max = -Infinity;
  for (const c of counts) { if (c < min) min = c; if (c > max) max = c; }
  return { min: counts.length ? min : 0, max: counts.length ? max : 0, counts };
}

/** Границы числа спецсимволов НА ПОЛЕ по всем стоп-сочетаниям сета. */
export function fieldSpecialBounds(
  reelset: ReelSpec, rows: number, specialIds: readonly SymbolId[]
): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const s of reelset) {
    const b = specialWindowBounds(s, rows, specialIds);
    min += b.min;
    max += b.max;
  }
  return { min, max };
}

/** «Ровно/не менее/не более k спецсимволов в любом окне» — предикат правила раскладки. */
export function specialCountInWindow(
  strip: Strip, rows: number, specialIds: readonly SymbolId[], rule: WindowRule
): string | null {
  const b = specialWindowBounds(strip, rows, specialIds);
  const seen = `в окне ${b.min}..${b.max}`;
  if (rule.exactly !== undefined && (b.min !== rule.exactly || b.max !== rule.exactly)) {
    return `требуется ровно ${rule.exactly} спецсимвол(ов) в любом окне, ${seen}`;
  }
  if (rule.min !== undefined && b.min < rule.min) {
    return `требуется не менее ${rule.min} спецсимвол(ов) в любом окне, ${seen}`;
  }
  if (rule.max !== undefined && b.max > rule.max) {
    return `требуется не более ${rule.max} спецсимвол(ов) в любом окне, ${seen}`;
  }
  return null;
}

/** Заданных id на ленте быть не должно (джекпоты в базовой игре). */
export function symbolAbsent(strip: Strip, ids: readonly SymbolId[]): string | null {
  for (const id of ids) {
    const at = strip.indexOf(id);
    if (at >= 0) return `символ ${id} запрещён на этой ленте (позиция ${at})`;
  }
  return null;
}

/** Позиции спецсимволов на ленте. */
export function specialPositions(strip: Strip, specialIds: readonly SymbolId[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < strip.length; i++) if (specialIds.indexOf(strip[i] as SymbolId) >= 0) out.push(i);
  return out;
}

/** Минимальный циклический зазор между соседними спецсимволами. 0/1 спецсимвол — зазор = длине. */
export function specialGap(strip: Strip, specialIds: readonly SymbolId[]): number {
  const pos = specialPositions(strip, specialIds);
  if (pos.length < 2) return strip.length;
  let gap = Infinity;
  for (let i = 0; i < pos.length; i++) {
    const a = pos[i] as number;
    const b = pos[(i + 1) % pos.length] as number;
    const d = i + 1 < pos.length ? b - a : b + strip.length - a;
    if (d < gap) gap = d;
  }
  return gap;
}

/** Зазор между спецсимволами не меньше требуемого (чтобы окно не собирало их пачкой). */
export function minGap(strip: Strip, specialIds: readonly SymbolId[], gap: number): string | null {
  const g = specialGap(strip, specialIds);
  return g < gap ? `зазор между спецсимволами ${g} < требуемого ${gap}` : null;
}

/** Все id алфавита обязаны присутствовать на ленте. */
export function allSymbolsPresent(strip: Strip, ids: readonly SymbolId[]): string | null {
  const missing: SymbolId[] = [];
  for (const id of ids) if (strip.indexOf(id) < 0) missing.push(id);
  return missing.length ? `на ленте нет символов: ${missing.join(', ')}` : null;
}

/** Ни одного id вне разрешённого алфавита. */
export function onlyKnownSymbols(strip: Strip, ids: readonly SymbolId[]): string | null {
  for (let i = 0; i < strip.length; i++) {
    const v = strip[i] as SymbolId;
    if (ids.indexOf(v) < 0) return `символ ${v} (позиция ${i}) вне алфавита`;
  }
  return null;
}

/** Набор правил одной ленты — то же описание, которым тюнеру ставят задачу. */
export interface StripRules {
  rows: number;
  specialIds: readonly SymbolId[];
  window?: WindowRule;
  forbid?: readonly SymbolId[];
  symbols?: readonly SymbolId[];
  requireAll?: boolean;
  /** Ожидаемые счётчики символов: id → сколько ровно (проверка состава после раскладки). */
  counts?: Readonly<Record<number, number>>;
}

/** Все нарушения ленты одним списком. Пустой список = лента правилам соответствует. */
export function validateStrip(strip: Strip, rules: StripRules): string[] {
  const out: string[] = [];
  const push = (v: string | null): void => { if (v) out.push(v); };
  if (rules.window) {
    push(specialCountInWindow(strip, rules.rows, rules.specialIds, rules.window));
    if (rules.window.minGap !== undefined) push(minGap(strip, rules.specialIds, rules.window.minGap));
  }
  if (rules.forbid && rules.forbid.length) push(symbolAbsent(strip, rules.forbid));
  if (rules.symbols) {
    push(onlyKnownSymbols(strip, rules.symbols));
    if (rules.requireAll) push(allSymbolsPresent(strip, rules.symbols));
  }
  if (rules.counts) {
    for (const key of Object.keys(rules.counts)) {
      const id = Number(key);
      const want = rules.counts[id] as number;
      let n = 0;
      for (const v of strip) if (v === id) n++;
      if (n !== want) out.push(`символа ${id} на ленте ${n}, ожидалось ${want}`);
    }
  }
  return out;
}
