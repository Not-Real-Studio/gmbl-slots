// Точные метрики сета лент. Ни одна величина здесь не оценивается — всё считается точно,
// но не лобовым перебором len^reels гридов: три независимых разложения дают те же числа.
//
//  1. RTP. Стопы барабанов независимы и равномерны ⇒ символ в ячейке (барабан r, ряд m)
//     распределён как частоты символов ленты r и от ряда НЕ зависит. Значит совместное
//     распределение символов линии — произведение частот, одно и то же у ВСЕХ линий, и
//     E[выигрыш спина] = число линий × E[выигрыш линии] (линейность матожидания: корреляция
//     линий на среднее не влияет). E[линии] раскладывается по «ведущей серии»: выплата зависит
//     только от тройки (w — сколько wild слева, s — первый не-wild символ, L — длина серии),
//     а вероятность такой тройки — произведение частот. O(барабаны² × символы), доли
//     миллисекунды. Зависит ТОЛЬКО от состава лент.
//  2. hit. Комбинация считается слева и требует минимум K подряд (K — минимальная платящая
//     длина paytable), значит факт «есть выигрыш» определяется первыми K барабанами: остальные
//     заполняются рвущим символом и на ответ не влияют. Перебор стопов первых K барабанов —
//     точный и дешёвый. Зависит ОТ ПОРЯДКА: разные линии берут разные ячейки одного окна.
//  3. Число спецсимволов на поле — сумма независимых слагаемых (спецсимволы в окне барабана).
//     Свёртка распределений по стопам даёт точное распределение 0..rows×reels. Зависит ОТ ПОРЯДКА.
//
// Разделение «RTP — состав, hit и спецсимвол — порядок» и есть то, на чём стоит тюнер.

import { evaluateTuple } from './evaluate.ts';
import type { GateRule, ReelSpec, SetMetrics, SlotSpec, Strip, SymbolId } from './types.ts';

/** Опции расчёта: правило гейта и потолки перебора. */
export interface BasisOptions {
  gate?: GateRule;
  /** Сколько барабанов перебирать под hit. По умолчанию — минимальная платящая длина paytable. */
  hitReels?: number;
  /** Потолок стоп-сочетаний перебора hit. По умолчанию 5 000 000. Превышение — громкая ошибка. */
  maxStops?: number;
  /** Готовый контекст слота (переиспользование таблицы выплат тюнером). */
  ctx?: SlotContext;
}

/**
 * Предрасчёт по слоту: алфавит символов, индексы и таблица выплат по тройке (w, L, символ).
 * Считается один раз; тюнер гоняет через него десятки тысяч расчётов RTP.
 */
export interface SlotContext {
  slot: SlotSpec;
  reels: number;
  lines: number;
  bet: number;
  /** Алфавит: id символов в стабильном порядке. */
  symbols: SymbolId[];
  /** id → индекс в алфавите. */
  index: Map<SymbolId, number>;
  wildIndex: number;
  /** Символ, которого нет ни в paytable, ни на лентах: рвёт серию и не платит. */
  breakerId: SymbolId;
  /** win[w][L][sIndex] — выплата линии «w wild, затем серия символа s общей длины L». */
  win: number[][][];
  /** Выплата линии из одних wild. */
  winAllWild: number;
  /** Минимальная платящая длина paytable — по стольким барабанам идёт enum hit. */
  minComboReels: number;
}

/** Частоты символов барабана: плотный массив по алфавиту контекста. */
export type ReelFreq = number[];

function paytableIds(slot: SlotSpec): SymbolId[] {
  const out: SymbolId[] = [];
  for (const k of Object.keys(slot.paytable)) out.push(Number(k));
  return out;
}

/** Минимальная длина, за которую хоть один символ платит, максимизированная по символам:
 *  ровно столько барабанов достаточно перебрать, чтобы факт выигрыша был определён. */
export function minComboReels(slot: SlotSpec): number {
  let need = 0;
  let any = false;
  for (const id of paytableIds(slot)) {
    const table = slot.paytable[id];
    if (!table) continue;
    let min = Infinity;
    for (const k of Object.keys(table)) {
      const len = Number(k);
      if ((table[len] || 0) > 0 && len < min) min = len;
    }
    if (min !== Infinity) { any = true; if (min > need) need = min; }
  }
  if (!any) throw new Error('gm-slots: в paytable нет ни одной платящей комбинации');
  return need;
}

/** Собрать контекст слота. `extra` — дополнительные id (ленты), чтобы рвущий символ был свежим. */
export function prepareSlot(slot: SlotSpec, extra: readonly SymbolId[] = []): SlotContext {
  const symbols: SymbolId[] = [];
  const index = new Map<SymbolId, number>();
  const add = (id: SymbolId): void => {
    if (!index.has(id)) { index.set(id, symbols.length); symbols.push(id); }
  };
  add(slot.wildId);
  for (const id of paytableIds(slot)) add(id);
  for (const id of slot.specialIds) add(id);
  for (const id of extra) add(id);

  let breaker = 0;
  for (const id of symbols) if (id >= breaker) breaker = id + 1;

  const R = slot.reels;
  const S = symbols.length;
  const win: number[][][] = [];
  for (let w = 0; w <= R; w++) {
    const byL: number[][] = [];
    for (let L = 0; L <= R; L++) {
      const bySym: number[] = [];
      for (let si = 0; si < S; si++) bySym.push(0);
      byL.push(bySym);
    }
    win.push(byL);
  }
  // Выплата зависит ровно от тройки (w, s, L): кандидат-wild видит серию длины w, кандидат-s —
  // длины L, а чем именно L..R-1 заполнены, роли не играет (серия уже оборвана).
  for (let w = 0; w < R; w++) {
    for (let si = 0; si < S; si++) {
      const s = symbols[si] as SymbolId;
      if (s === slot.wildId) continue;
      for (let L = w + 1; L <= R; L++) {
        const ids: SymbolId[] = [];
        for (let r = 0; r < w; r++) ids.push(slot.wildId);
        for (let r = w; r < L; r++) ids.push(s);
        for (let r = L; r < R; r++) ids.push(breaker);
        const res = evaluateTuple(ids, slot);
        (win[w] as number[][])[L]![si] = res ? res.win : 0;
      }
    }
  }
  const allWild: SymbolId[] = [];
  for (let r = 0; r < R; r++) allWild.push(slot.wildId);
  const resAll = evaluateTuple(allWild, slot);

  return {
    slot,
    reels: R,
    lines: slot.lines.length,
    bet: slot.bet,
    symbols,
    index,
    wildIndex: index.get(slot.wildId) as number,
    breakerId: breaker,
    win,
    winAllWild: resAll ? resAll.win : 0,
    minComboReels: minComboReels(slot)
  };
}

/** Частоты символов ленты в алфавите контекста. Чужой id — громкая ошибка, а не тихий ноль. */
export function stripFreq(ctx: SlotContext, strip: Strip): ReelFreq {
  const f: number[] = [];
  for (let i = 0; i < ctx.symbols.length; i++) f.push(0);
  const step = 1 / strip.length;
  for (const id of strip) {
    const si = ctx.index.get(id);
    if (si === undefined) throw new Error(`gm-slots: символ ${id} вне алфавита слота`);
    f[si] = (f[si] as number) + step;
  }
  return f;
}

/** Частоты по счётчикам (тюнер держит состав как счётчики, а не как ленту). */
export function countsFreq(ctx: SlotContext, counts: Map<SymbolId, number>, length: number): ReelFreq {
  const f: number[] = [];
  for (let i = 0; i < ctx.symbols.length; i++) f.push(0);
  for (const [id, n] of counts) {
    const si = ctx.index.get(id);
    if (si === undefined) throw new Error(`gm-slots: символ ${id} вне алфавита слота`);
    f[si] = (f[si] as number) + n / length;
  }
  return f;
}

/** E[выплата ОДНОЙ линии] и P(линия платит). Обе величины — только от состава лент. */
export function expectedLine(ctx: SlotContext, freqs: readonly ReelFreq[]): { win: number; hit: number } {
  const R = ctx.reels;
  const S = ctx.symbols.length;
  const wi = ctx.wildIndex;
  let win = 0;
  let hit = 0;
  let pre = 1; // Π частот wild по барабанам левее w

  for (let w = 0; w < R; w++) {
    const fw = freqs[w] as ReelFreq;
    for (let si = 0; si < S; si++) {
      if (si === wi) continue;
      const fs = fw[si] as number;
      if (fs <= 0) continue;
      const table = (ctx.win[w] as number[][]);
      let cont = 1; // Π вероятностей «позиция продолжила серию» на w+1..L-1
      for (let L = w + 1; L <= R; L++) {
        const fl = L < R ? (freqs[L] as ReelFreq) : null;
        const tail = fl ? 1 - (fl[si] as number) - (fl[wi] as number) : 1;
        if (tail > 0) {
          const wv = (table[L] as number[])[si] as number;
          if (wv > 0) {
            const p = pre * fs * cont * tail;
            win += p * wv;
            hit += p;
          }
        }
        if (fl) {
          cont *= (fl[si] as number) + (fl[wi] as number);
          if (cont <= 0) break;
        }
      }
    }
    pre *= (fw[wi] as number);
    if (pre <= 0) break;
  }
  if (pre > 0 && ctx.winAllWild > 0) { win += pre * ctx.winAllWild; hit += pre; }
  return { win, hit };
}

/** E[выплата одной линии] по сету лент (в единицах paytable). */
export function expectedLineWin(slot: SlotSpec, reelset: ReelSpec): number {
  const ctx = prepareSlot(slot, allIds(reelset));
  const freqs = reelset.map((s) => stripFreq(ctx, s));
  return expectedLine(ctx, freqs).win;
}

function allIds(reelset: ReelSpec): SymbolId[] {
  const out: SymbolId[] = [];
  for (const s of reelset) for (const id of s) out.push(id);
  return out;
}

/** Результат перебора hit: сам hit + провенанс (сколько стопов и по скольким барабанам). */
export interface HitResult {
  hit: number;
  stops: number;
  reels: number;
}

/**
 * Точный hit: перебор стопов первых `minComboReels` барабанов. Остальные барабаны заполняются
 * рвущим символом — на факт выигрыша они повлиять не могут (серия считается слева).
 */
export function hitRate(
  slot: SlotSpec, reelset: ReelSpec, opts: BasisOptions = {}
): HitResult {
  const ctx = opts.ctx ?? prepareSlot(slot, allIds(reelset));
  const R = reelset.length;
  const k = opts.hitReels ?? ctx.minComboReels;
  if (k > R) {
    throw new Error(`gm-slots: минимальная платящая длина ${k} больше числа барабанов ${R}`);
  }
  let stops = 1;
  for (let r = 0; r < k; r++) stops *= (reelset[r] as Strip).length;
  const cap = opts.maxStops ?? 5000000;
  if (stops > cap) {
    throw new Error(
      `gm-slots: перебор hit — ${stops} стоп-сочетаний по ${k} барабанам (потолок ${cap}). ` +
      'Либо укоротите ленты, либо поднимите maxStops сознательно.'
    );
  }

  // Окна барабанов: колонка на каждый стоп. Строится один раз, дальше — только индексы.
  const cols: SymbolId[][][] = [];
  for (let r = 0; r < k; r++) {
    const s = reelset[r] as Strip;
    const per: SymbolId[][] = [];
    for (let stop = 0; stop < s.length; stop++) {
      const c: SymbolId[] = [];
      for (let row = 0; row < slot.rows; row++) c.push(s[(stop + row) % s.length] as SymbolId);
      per.push(c);
    }
    cols.push(per);
  }

  // Линии, различающиеся только за пределами k барабанов, дают один и тот же ответ — дубли
  // схлопываются: enum и так самая дорогая часть басиса.
  const seen = new Set<string>();
  const prefixes: number[][] = [];
  for (const line of slot.lines) {
    const p = line.slice(0, k);
    const key = p.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    prefixes.push(p as number[]);
  }

  const ids: SymbolId[] = [];
  for (let r = 0; r < R; r++) ids.push(ctx.breakerId);
  const stopIdx: number[] = [];
  for (let r = 0; r < k; r++) stopIdx.push(0);
  const active: SymbolId[][] = [];
  for (let r = 0; r < k; r++) active.push((cols[r] as SymbolId[][])[0] as SymbolId[]);

  let hits = 0;
  for (let n = 0; n < stops; n++) {
    let win = false;
    for (const p of prefixes) {
      for (let r = 0; r < k; r++) ids[r] = (active[r] as SymbolId[])[p[r] as number] as SymbolId;
      if (evaluateTuple(ids, slot)) { win = true; break; }
    }
    if (win) hits++;
    // одометр по стопам
    for (let r = 0; r < k; r++) {
      const per = cols[r] as SymbolId[][];
      const next = (stopIdx[r] as number) + 1;
      if (next < per.length) { stopIdx[r] = next; active[r] = per[next] as SymbolId[]; break; }
      stopIdx[r] = 0; active[r] = per[0] as SymbolId[];
    }
  }
  return { hit: hits / stops, stops, reels: k };
}

/** Число спецсимволов в окне барабана на каждом стопе. */
export function windowCounts(strip: Strip, rows: number, specialIds: readonly SymbolId[]): number[] {
  const out: number[] = [];
  for (let stop = 0; stop < strip.length; stop++) {
    let n = 0;
    for (let row = 0; row < rows; row++) {
      const id = strip[(stop + row) % strip.length] as SymbolId;
      if (specialIds.indexOf(id) >= 0) n++;
    }
    out.push(n);
  }
  return out;
}

/**
 * Точное распределение числа спецсимволов на поле: свёртка независимых окон по барабанам.
 * dist[k] = P(ровно k спецсимволов), сумма = 1.
 */
export function specialDist(slot: SlotSpec, reelset: ReelSpec): number[] {
  let dist: number[] = [1];
  for (const s of reelset) {
    const counts = windowCounts(s, slot.rows, slot.specialIds);
    const per: number[] = [];
    for (const c of counts) per[c] = (per[c] || 0) + 1 / s.length;
    const next: number[] = [];
    for (let a = 0; a < dist.length; a++) {
      const pa = dist[a] || 0;
      if (!pa) continue;
      for (let b = 0; b < per.length; b++) {
        const pb = per[b] || 0;
        if (!pb) continue;
        next[a + b] = (next[a + b] || 0) + pa * pb;
      }
    }
    dist = next;
  }
  for (let i = 0; i < dist.length; i++) if (!dist[i]) dist[i] = 0;
  return dist;
}

/** Вероятность триггера по правилу гейта: гарантия сверху + ролл по таблице ниже неё. */
export function triggerProb(dist: readonly number[], gate: GateRule | undefined): number {
  if (!gate) return 0;
  const guaranteed = gate.guaranteed ?? Infinity;
  const table = gate.probByCount || {};
  let p = 0;
  for (let c = 0; c < dist.length; c++) {
    if (c === 0) continue;
    if (c >= guaranteed) p += dist[c] as number;
    else p += (dist[c] as number) * (table[String(c)] || 0);
  }
  return p;
}

/** Все метрики сета разом. */
export function setMetrics(slot: SlotSpec, reelset: ReelSpec, opts: BasisOptions = {}): SetMetrics {
  const ctx = opts.ctx ?? prepareSlot(slot, allIds(reelset));
  const freqs = reelset.map((s) => stripFreq(ctx, s));
  const line = expectedLine(ctx, freqs);
  const h = hitRate(slot, reelset, { ...opts, ctx });
  const dist = specialDist(slot, reelset);
  let eSpecial = 0;
  for (let c = 0; c < dist.length; c++) eSpecial += c * (dist[c] as number);
  let pAnticipation = 0;
  for (const c of opts.gate?.anticipationCounts || []) pAnticipation += dist[c] || 0;
  const pTrigger = triggerProb(dist, opts.gate);

  return {
    rtp: line.win * slot.lines.length / slot.bet,
    hit: h.hit,
    eLine: line.win,
    pLine: line.hit,
    hitStops: h.stops,
    hitReels: h.reels,
    specialDist: dist,
    eSpecial,
    pAnticipation,
    pTrigger,
    trigger1n: pTrigger > 0 ? 1 / pTrigger : 0
  };
}

/** Линейная свёртка басиса в RTP профиля: RTP(веса) = Σ доля(сет) × RTP(сет). */
export function linearRtp(
  metrics: Readonly<Record<string, SetMetrics>>, weights: Readonly<Record<string, number>>
): number {
  return linearBlend(metrics, weights).rtp;
}

/** Что даёт линейная свёртка кроме RTP: hit, спецсимвол, триггер — все они тоже линейны по весам. */
export interface LinearBlend {
  rtp: number;
  hit: number;
  eSpecial: number;
  pTrigger: number;
  pAnticipation: number;
  trigger1n: number;
}

export function linearBlend(
  metrics: Readonly<Record<string, SetMetrics>>, weights: Readonly<Record<string, number>>
): LinearBlend {
  let sum = 0;
  for (const k of Object.keys(weights)) {
    const w = weights[k] as number;
    if (!(w >= 0)) throw new Error(`gm-slots: вес сета «${k}» отрицателен или не число: ${w}`);
    if (!metrics[k]) throw new Error(`gm-slots: вес задан для сета «${k}», а метрик по нему нет`);
    sum += w;
  }
  if (sum <= 0) throw new Error('gm-slots: сумма весов сетов равна нулю');
  const acc: LinearBlend = { rtp: 0, hit: 0, eSpecial: 0, pTrigger: 0, pAnticipation: 0, trigger1n: 0 };
  for (const k of Object.keys(weights)) {
    const share = (weights[k] as number) / sum;
    const m = metrics[k] as SetMetrics;
    acc.rtp += share * m.rtp;
    acc.hit += share * m.hit;
    acc.eSpecial += share * m.eSpecial;
    acc.pTrigger += share * m.pTrigger;
    acc.pAnticipation += share * m.pAnticipation;
  }
  acc.trigger1n = acc.pTrigger > 0 ? 1 / acc.pTrigger : 0;
  return acc;
}
