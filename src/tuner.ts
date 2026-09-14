// Обратная задача: подобрать сет лент под целевые метрики.
//
// КЛЮЧЕВОЕ РАЗДЕЛЕНИЕ, ИЗ КОТОРОГО СЛЕДУЕТ ВСЁ ОСТАЛЬНОЕ: RTP зависит только от СОСТАВА
// барабана (мультимножества символов), а hit и распределение спецсимвола — от ПОРЯДКА.
// Поэтому задача разваливается на два этапа, и ни один из них не мешает другому:
//
//   Этап 1 — состав. Координатный спуск по счётчикам: замена одной позиции символа A на символ B,
//   пересчёт RTP (доли миллисекунды, basis.expectedLine), приём шага при приближении к цели.
//   Ограничения — коробочные: min/max/exactly по символу на барабан.
//
//   Этап 2 — порядок. Состав раскладывается в последовательность конструктивно, под структурные
//   правила: «ровно k спецсимволов в любом окне» (период = rows/k, с проверкой делимости длины),
//   «не менее k», минимальный зазор, запрет id. Потом меряется hit; при промахе — возврат к
//   этапу 1 с поправкой прокси-цели (hit двигается соотношением частых дешёвых и редких дорогих
//   символов, а внутри этапа 1 это видно как P(линия платит)).
//
// Не сошлось — TunerError с диагностикой (во что упёрлись), а не молчаливый «лучший вариант»:
// молча промахнувшаяся лента уезжает в документ игры и живёт там годами.

import {
  countsFreq, expectedLine, prepareSlot, setMetrics
} from './basis.ts';
import type { ReelFreq, SlotContext } from './basis.ts';
import { mulberry32, randomInt, shuffle } from './rng.ts';
import { validateStrip } from './validate.ts';
import type {
  CountBound, ReelTarget, SetMetrics, SlotSpec, SymbolId, TunerResult, TunerTarget, WindowRule
} from './types.ts';

/** Во что упёрся тюнер. Печатается в сообщении ошибки и доступна программно. */
export interface TunerDiagnostics {
  stage: 'target' | 'composition' | 'layout' | 'hit';
  reel?: number;
  rtp?: number;
  rtpTarget?: number;
  /** Достижимый диапазон RTP при данных ограничениях — считается только при провале. */
  rtpRange?: { min: number; max: number };
  hit?: number;
  hitTarget?: number;
  violations?: string[];
  notes: string[];
}

export class TunerError extends Error {
  readonly diagnostics: TunerDiagnostics;
  constructor(message: string, diagnostics: TunerDiagnostics) {
    super(message);
    this.name = 'TunerError';
    this.diagnostics = diagnostics;
  }
}

interface Bound { min: number; max: number; pinned: boolean }

interface ReelPlan {
  index: number;
  length: number;
  allowed: SymbolId[];
  bound: Map<SymbolId, Bound>;
  window: WindowRule | undefined;
  specialIds: SymbolId[];
  specialCount: number;
  forbid: readonly SymbolId[];
  weightHint: Readonly<Record<number, number>> | undefined;
}

const DEF_RTP_TOL = 0.005;
const DEF_HIT_TOL = 0.01;
const DEF_STEPS = 4000;
const DEF_ROUNDS = 12;

function boundOf(b: CountBound | undefined, length: number): Bound {
  if (b && b.exactly !== undefined) return { min: b.exactly, max: b.exactly, pinned: true };
  return { min: b?.min ?? 0, max: b?.max ?? length, pinned: false };
}

/**
 * Сколько спецсимволов обязано быть на ленте, чтобы структурное правило вообще было выполнимо.
 * Здесь же ловятся грабли делимости: «ровно 1 в окне» достигается только периодом = высоте окна,
 * значит длина ленты обязана делиться на неё — при 40 позициях и окне 3 такой ленты не существует.
 */
function resolveSpecialCount(
  reel: ReelTarget, rows: number, specialIds: readonly SymbolId[], notes: string[], index: number
): number {
  const rule = reel.special;
  const len = reel.length;
  if (rule && rule.exactly !== undefined) {
    const k = rule.exactly;
    if (k === 0) return 0;
    if (rows % k !== 0) {
      throw new TunerError(
        `барабан ${index}: «ровно ${k} спецсимвола(ов) в окне» недостижимо: высота окна ${rows} ` +
        `не делится на ${k} нацело`,
        { stage: 'target', reel: index, notes }
      );
    }
    const period = rows / k;
    if (len % period !== 0) {
      throw new TunerError(
        `барабан ${index}: «ровно ${k} спецсимвола(ов) в окне» требует периода ${period}, а длина ` +
        `ленты ${len} на ${period} не делится. Возьмите длину, кратную ${period} ` +
        `(ближайшие: ${Math.floor(len / period) * period}, ${(Math.floor(len / period) + 1) * period}).`,
        { stage: 'target', reel: index, notes }
      );
    }
    const count = len / period;
    notes.push(`барабан ${index}: ${count} спецсимволов шагом ${period} — ровно ${k} в любом окне`);
    return count;
  }
  if (rule && rule.min !== undefined && rule.min > 0) {
    const m = rule.min;
    if (m > rows) {
      throw new TunerError(
        `барабан ${index}: «не менее ${m} в окне» недостижимо при высоте окна ${rows}`,
        { stage: 'target', reel: index, notes }
      );
    }
    const gap = Math.floor(rows / m);
    const count = Math.ceil(len / gap);
    notes.push(`барабан ${index}: ${count} спецсимволов (максимальный зазор ${gap}) — не менее ${m} в окне`);
    return count;
  }
  if (rule && rule.count !== undefined) return rule.count;
  let sum = 0;
  for (const id of specialIds) {
    const b = reel.counts ? reel.counts[id] : undefined;
    sum += b?.exactly ?? b?.min ?? 0;
  }
  return sum;
}

/** Правило окна, дополненное зазором, который следует из «не более k в окне». */
function effectiveWindow(rule: WindowRule | undefined, rows: number): WindowRule | undefined {
  if (!rule) return undefined;
  const out: WindowRule = { ...rule };
  if (rule.max !== undefined && rule.max > 0) {
    const need = Math.floor((rows - 1) / rule.max) + 1;
    out.minGap = Math.max(rule.minGap ?? 0, need);
  }
  if (rule.exactly !== undefined && rule.exactly > 0) {
    out.min = rule.exactly;
    out.max = rule.exactly;
  }
  return out;
}

function buildPlans(slot: SlotSpec, target: TunerTarget, notes: string[]): ReelPlan[] {
  if (target.reels.length !== slot.reels) {
    throw new TunerError(
      `в цели ${target.reels.length} барабанов, в слоте ${slot.reels}`,
      { stage: 'target', notes }
    );
  }
  const plans: ReelPlan[] = [];
  for (let r = 0; r < target.reels.length; r++) {
    const reel = target.reels[r] as ReelTarget;
    const forbid = reel.forbid || [];
    const specialIds = slot.specialIds.filter((id) => target.symbols.indexOf(id) >= 0);
    const specialCount = resolveSpecialCount(reel, slot.rows, specialIds, notes, r);

    const bound = new Map<SymbolId, Bound>();
    const allowed: SymbolId[] = [];
    for (const id of target.symbols) {
      if (forbid.indexOf(id) >= 0) { bound.set(id, { min: 0, max: 0, pinned: true }); continue; }
      const b = boundOf(reel.counts ? reel.counts[id] : undefined, reel.length);
      if (target.requireAll && b.max > 0 && b.min < 1 && specialIds.indexOf(id) < 0) b.min = 1;
      if (b.min > b.max) {
        throw new TunerError(
          `барабан ${r}: ограничения по символу ${id} противоречивы (min ${b.min} > max ${b.max})`,
          { stage: 'target', reel: r, notes }
        );
      }
      bound.set(id, b);
      if (b.max > 0) allowed.push(id);
    }

    // Счётчики спецсимволов диктует структура: этап 1 их не двигает, иначе этап 2 не разложится.
    if (specialIds.length) {
      let left = specialCount;
      for (let i = 0; i < specialIds.length; i++) {
        const id = specialIds[i] as SymbolId;
        const share = i === specialIds.length - 1 ? left : Math.floor(specialCount / specialIds.length);
        left -= share;
        bound.set(id, { min: share, max: share, pinned: true });
        if (share > 0 && allowed.indexOf(id) < 0) allowed.push(id);
      }
    }

    let low = 0;
    let high = 0;
    for (const id of target.symbols) {
      const b = bound.get(id) as Bound;
      low += b.min;
      high += b.max;
    }
    if (low > reel.length || high < reel.length) {
      throw new TunerError(
        `барабан ${r}: ограничения по счётчикам не складываются в ленту длины ${reel.length} ` +
        `(сумма минимумов ${low}, сумма максимумов ${high})`,
        { stage: 'target', reel: r, notes }
      );
    }
    plans.push({
      index: r,
      length: reel.length,
      allowed,
      bound,
      window: effectiveWindow(reel.special, slot.rows),
      specialIds,
      specialCount,
      forbid,
      weightHint: reel.weightHint
    });
  }
  return plans;
}

/** Стартовый состав: минимумы обязательны, остаток раскидывается по подсказке весов. */
function initCounts(plan: ReelPlan): Map<SymbolId, number> {
  const counts = new Map<SymbolId, number>();
  let used = 0;
  for (const id of plan.allowed) {
    const b = plan.bound.get(id) as Bound;
    counts.set(id, b.min);
    used += b.min;
  }
  let left = plan.length - used;
  const movable = plan.allowed.filter((id) => !(plan.bound.get(id) as Bound).pinned);
  if (left > 0 && !movable.length) {
    throw new TunerError(
      `барабан ${plan.index}: все счётчики зафиксированы, но ${left} позиций остались пустыми`,
      { stage: 'target', reel: plan.index, notes: [] }
    );
  }
  let weightSum = 0;
  const weight = (id: SymbolId): number => (plan.weightHint ? (plan.weightHint[id] ?? 0) : 1) || 1;
  for (const id of movable) weightSum += weight(id);
  // Раздаём пропорционально подсказке, остаток — по кругу: точка старта, а не результат.
  for (const id of movable) {
    if (left <= 0) break;
    const b = plan.bound.get(id) as Bound;
    const want = Math.floor(left * weight(id) / weightSum);
    const add = Math.min(want, b.max - (counts.get(id) as number));
    counts.set(id, (counts.get(id) as number) + add);
  }
  used = 0;
  for (const n of counts.values()) used += n;
  left = plan.length - used;
  let guard = 0;
  while (left > 0) {
    let moved = false;
    for (const id of movable) {
      if (left <= 0) break;
      const b = plan.bound.get(id) as Bound;
      const cur = counts.get(id) as number;
      if (cur < b.max) { counts.set(id, cur + 1); left--; moved = true; }
    }
    if (!moved || ++guard > plan.length) break;
  }
  if (left !== 0) {
    throw new TunerError(
      `барабан ${plan.index}: не удалось набрать ленту длины ${plan.length} (не разложено ${left})`,
      { stage: 'target', reel: plan.index, notes: [] }
    );
  }
  return counts;
}

interface Descent {
  counts: Map<SymbolId, number>[];
  freqs: ReelFreq[];
  rtp: number;
  pLine: number;
  steps: number;
}

function measure(ctx: SlotContext, freqs: ReelFreq[]): { rtp: number; pLine: number } {
  const line = expectedLine(ctx, freqs);
  return { rtp: line.win * ctx.lines / ctx.bet, pLine: line.hit };
}

type Cost = (rtp: number, pLine: number) => number;

/**
 * Координатный спуск по составу. Шаг — «одна позиция символа A становится символом B» на одном
 * барабане: именно так устроена лента, поэтому и шаг такой. Берётся наилучший шаг, затем он же
 * повторяется, пока улучшает (крупные движения RTP — это десятки одинаковых замен подряд).
 */
function descend(
  ctx: SlotContext, plans: ReelPlan[], counts: Map<SymbolId, number>[], cost: Cost, maxSteps: number
): Descent {
  const freqs = plans.map((p, r) => countsFreq(ctx, counts[r] as Map<SymbolId, number>, p.length));
  let cur = measure(ctx, freqs);
  let best = cost(cur.rtp, cur.pLine);
  let steps = 0;

  const apply = (r: number, from: SymbolId, to: SymbolId): void => {
    const c = counts[r] as Map<SymbolId, number>;
    c.set(from, (c.get(from) as number) - 1);
    c.set(to, (c.get(to) as number) + 1);
    const f = freqs[r] as ReelFreq;
    const step = 1 / (plans[r] as ReelPlan).length;
    const fi = ctx.index.get(from) as number;
    const ti = ctx.index.get(to) as number;
    f[fi] = (f[fi] as number) - step;
    f[ti] = (f[ti] as number) + step;
  };
  const canMove = (r: number, from: SymbolId, to: SymbolId): boolean => {
    if (from === to) return false;
    const p = plans[r] as ReelPlan;
    const bf = p.bound.get(from) as Bound | undefined;
    const bt = p.bound.get(to) as Bound | undefined;
    if (!bf || !bt || bf.pinned || bt.pinned) return false;
    const c = counts[r] as Map<SymbolId, number>;
    return (c.get(from) as number) > bf.min && (c.get(to) as number) < bt.max;
  };

  while (steps < maxSteps) {
    let bestMove: { r: number; from: SymbolId; to: SymbolId; cost: number } | null = null;
    for (let r = 0; r < plans.length; r++) {
      const p = plans[r] as ReelPlan;
      for (const from of p.allowed) {
        for (const to of p.allowed) {
          if (!canMove(r, from, to)) continue;
          apply(r, from, to);
          const m = measure(ctx, freqs);
          const c = cost(m.rtp, m.pLine);
          apply(r, to, from);
          if (c < best - 1e-15 && (!bestMove || c < bestMove.cost)) {
            bestMove = { r, from, to, cost: c };
          }
        }
      }
    }
    if (!bestMove) break;
    // Тот же шаг повторяем, пока улучшает: сканировать все пары заново на каждую позицию дорого.
    let last = bestMove.cost;
    apply(bestMove.r, bestMove.from, bestMove.to);
    best = last;
    steps++;
    while (steps < maxSteps && canMove(bestMove.r, bestMove.from, bestMove.to)) {
      apply(bestMove.r, bestMove.from, bestMove.to);
      const m = measure(ctx, freqs);
      const c = cost(m.rtp, m.pLine);
      if (c < last - 1e-15) { last = c; best = c; steps++; } else { apply(bestMove.r, bestMove.to, bestMove.from); break; }
    }
  }
  cur = measure(ctx, freqs);
  return { counts, freqs, rtp: cur.rtp, pLine: cur.pLine, steps };
}

function cloneCounts(counts: Map<SymbolId, number>[]): Map<SymbolId, number>[] {
  return counts.map((c) => new Map(c));
}

/** Достижимый диапазон RTP при данных ограничениях — считается только когда цель не взята. */
function rtpRange(
  ctx: SlotContext, plans: ReelPlan[], counts: Map<SymbolId, number>[], maxSteps: number
): { min: number; max: number } {
  const up = descend(ctx, plans, cloneCounts(counts), (rtp) => -rtp, maxSteps);
  const down = descend(ctx, plans, cloneCounts(counts), (rtp) => rtp, maxSteps);
  return { min: down.rtp, max: up.rtp };
}

/**
 * Позиции спецсимволов: конструктивно, а не перебором. «Ровно k в окне» — строгий период
 * rows/k, всё остальное — равномерный разброс (зазоры отличаются не более чем на 1).
 */
export function planSpecialPositions(
  length: number, rows: number, rule: WindowRule | undefined, count: number, rng: () => number
): number[] {
  if (count <= 0) return [];
  const offset = randomInt(length, rng);
  const out: number[] = [];
  if (rule && rule.exactly !== undefined && rule.exactly > 0) {
    const period = rows / rule.exactly;
    for (let i = 0; i < count; i++) out.push((offset + i * period) % length);
    return out.sort((a, b) => a - b);
  }
  for (let i = 0; i < count; i++) out.push((offset + Math.floor(i * length / count)) % length);
  return out.sort((a, b) => a - b);
}

/** Этап 2 для одной ленты: состав → последовательность под структурные правила. */
function layoutStrip(
  plan: ReelPlan, counts: Map<SymbolId, number>, rows: number, rng: () => number, notes: string[]
): SymbolId[] {
  const strip: SymbolId[] = new Array(plan.length).fill(-1);
  const specials: SymbolId[] = [];
  for (const id of plan.specialIds) {
    for (let i = 0; i < (counts.get(id) || 0); i++) specials.push(id);
  }
  const positions = planSpecialPositions(plan.length, rows, plan.window, specials.length, rng);
  if (positions.length !== specials.length) {
    throw new TunerError(
      `барабан ${plan.index}: раскладка дала ${positions.length} мест под ${specials.length} спецсимволов`,
      { stage: 'layout', reel: plan.index, notes }
    );
  }
  const seen = new Set<number>();
  for (const p of positions) {
    if (seen.has(p)) {
      throw new TunerError(
        `барабан ${plan.index}: раскладка спецсимволов наложилась сама на себя (позиция ${p}) — ` +
        `${specials.length} спецсимволов не помещаются в ленту длины ${plan.length} с таким шагом`,
        { stage: 'layout', reel: plan.index, notes }
      );
    }
    seen.add(p);
  }
  shuffle(specials, rng);
  for (let i = 0; i < positions.length; i++) strip[positions[i] as number] = specials[i] as SymbolId;

  const rest: SymbolId[] = [];
  for (const [id, n] of counts) {
    if (plan.specialIds.indexOf(id) >= 0) continue;
    for (let i = 0; i < n; i++) rest.push(id);
  }
  shuffle(rest, rng);
  let k = 0;
  for (let i = 0; i < strip.length; i++) if (strip[i] === -1) strip[i] = rest[k++] as SymbolId;
  if (k !== rest.length) {
    throw new TunerError(
      `барабан ${plan.index}: состав (${rest.length + specials.length}) не совпал с длиной ленты ${plan.length}`,
      { stage: 'layout', reel: plan.index, notes }
    );
  }
  return strip;
}

/**
 * Подобрать сет лент под цель. Детерминирован по сиду. Не сошлось — TunerError с диагностикой.
 */
export function tuneReels(slot: SlotSpec, target: TunerTarget): TunerResult {
  const notes: string[] = [];
  const plans = buildPlans(slot, target, notes);
  const ctx = prepareSlot(slot, target.symbols);
  const seed = target.seed ?? 1;
  const rtpTol = target.rtpTolerance ?? DEF_RTP_TOL;
  const hitTol = target.hitTolerance ?? DEF_HIT_TOL;
  const maxSteps = target.maxSteps ?? DEF_STEPS;
  const maxRounds = target.hit === undefined ? 1 : (target.maxRounds ?? DEF_ROUNDS);
  const pLineTol = Math.max(hitTol / Math.max(1, slot.lines.length), 1e-5);
  const maximize = target.rtp === 'max';
  const rtpTarget = maximize ? 0 : (target.rtp as number);

  const base = plans.map((p) => initCounts(p));
  let guess: number | null = null;
  const seen: { pLine: number; hit: number }[] = [];
  const asked: number[] = [];
  let steps = 0;
  let best: { reelset: SymbolId[][]; metrics: SetMetrics } | null = null;

  for (let round = 0; round < maxRounds; round++) {
    // RTP — ограничение с допуском, hit — цель внутри допуска. Поэтому промах по RTP штрафуется
    // только ЗА границей допуска, зато на три порядка тяжелее: иначе спуск охотно разменивает
    // попадание по RTP на приближение к hit и в итоге не берёт ни того, ни другого.
    const cost: Cost = maximize
      ? (rtp): number => -rtp
      : (rtp, pLine): number => {
        const dr = Math.abs(rtp - rtpTarget) / rtpTol;
        if (guess === null) return dr * dr;
        const over = dr > 1 ? dr - 1 : 0;
        const dh = (pLine - guess) / Math.max(guess, pLineTol);
        return 1000 * over * over + dh * dh;
      };
    const d = descend(ctx, plans, cloneCounts(base), cost, maxSteps);
    steps += d.steps;

    if (!maximize && Math.abs(d.rtp - rtpTarget) > rtpTol) {
      const range = rtpRange(ctx, plans, base, maxSteps);
      throw new TunerError(
        `RTP не сходится: цель ${rtpTarget.toFixed(4)} ±${rtpTol}, достигнуто ${d.rtp.toFixed(4)}. ` +
        `При данных ограничениях состав даёт RTP в диапазоне ${range.min.toFixed(4)}..${range.max.toFixed(4)} — ` +
        (rtpTarget > range.max
          ? 'цель выше потолка: ослабьте ограничения (спецсимволы/wild занимают позиции) или снизьте цель.'
          : rtpTarget < range.min
            ? 'цель ниже пола: даже самый дешёвый допустимый состав платит больше.'
            : 'цель внутри диапазона, но не берётся шагом «одна позиция» — упёрлись в гранулярность ленты.'),
        { stage: 'composition', rtp: d.rtp, rtpTarget, rtpRange: range, notes }
      );
    }

    // Один и тот же сид раскладки на всех раундах: между раундами обязан меняться ТОЛЬКО состав,
    // иначе поправка по hit ловит шум перестановки вместо сигнала состава.
    const rng = mulberry32(seed | 0);
    const reelset: SymbolId[][] = [];
    for (let r = 0; r < plans.length; r++) {
      const plan = plans[r] as ReelPlan;
      const strip = layoutStrip(plan, d.counts[r] as Map<SymbolId, number>, slot.rows, rng, notes);
      const violations = validateStrip(strip, {
        rows: slot.rows,
        specialIds: plan.specialIds,
        window: plan.window,
        forbid: plan.forbid,
        symbols: target.symbols,
        requireAll: false
      });
      if (violations.length) {
        throw new TunerError(
          `барабан ${r}: раскладка не удовлетворяет структурным правилам — ${violations.join('; ')}`,
          { stage: 'layout', reel: r, violations, notes }
        );
      }
      reelset.push(strip);
    }

    const metrics = setMetrics(slot, reelset, { gate: undefined, ctx });
    if (target.hit === undefined || Math.abs(metrics.hit - target.hit) <= hitTol) {
      if (maximize) notes.push(`RTP максимизирован: ${metrics.rtp.toFixed(6)}`);
      return {
        reelset,
        metrics,
        steps,
        rounds: round + 1,
        seed,
        notes
      };
    }

    // Поправка. hit монотонен по P(линия платит) — прокси, который этап 1 двигает напрямую
    // (доля частых дешёвых символов против редких дорогих). Пока цель не взята в вилку, идём
    // наружу шагами; есть вилка — метод ложного положения, а при повторе догадки — деление вилки
    // пополам. Секущая без вилки на дискретном составе разбегается, поэтому её здесь нет.
    seen.push({ pLine: metrics.pLine, hit: metrics.hit });
    if (!best || Math.abs(metrics.hit - target.hit) < Math.abs(best.metrics.hit - target.hit)) {
      best = { reelset, metrics };
    }
    let below: { pLine: number; hit: number } | null = null;
    let above: { pLine: number; hit: number } | null = null;
    for (const s of seen) {
      if (s.hit <= target.hit && (!below || s.hit > below.hit)) below = s;
      if (s.hit >= target.hit && (!above || s.hit < above.hit)) above = s;
    }
    const bracket = below && above && above.hit - below.hit > 1e-12 ? { below, above } : null;
    let next = bracket
      ? bracket.below.pLine
        + (target.hit - bracket.below.hit) * (bracket.above.pLine - bracket.below.pLine)
          / (bracket.above.hit - bracket.below.hit)
      : (metrics.hit < target.hit ? metrics.pLine * 1.25 : metrics.pLine * 0.8);
    const tried = (v: number): boolean => asked.some((a) => Math.abs(a - v) < 1e-9);
    if (tried(next) && bracket) next = (bracket.below.pLine + bracket.above.pLine) / 2;
    next = Math.min(0.999, Math.max(1e-6, next));
    if (tried(next)) {
      const reach = seen.map((s) => s.hit);
      const lo = Math.min(...reach);
      const hi = Math.max(...reach);
      throw new TunerError(
        (above
          ? (below
            ? `hit упёрся в гранулярность состава: замена одной позиции двигает hit крупнее допуска`
            : `hit упёрся в пол ${lo.toFixed(4)}: дешевле состав при этом RTP не делается`)
          : `hit упёрся в потолок ${hi.toFixed(4)}: чаще платить состав при этом RTP не может`) +
        `. Цель ${target.hit} ±${hitTol}, достижимое ${lo.toFixed(4)}..${hi.toFixed(4)}, ближайшее ` +
        `${(best as { metrics: SetMetrics }).metrics.hit.toFixed(4)} при RTP ` +
        `${(best as { metrics: SetMetrics }).metrics.rtp.toFixed(4)}. Двигайте цель, допуск или ` +
        'ограничения по счётчикам (hit растёт с долей частых дешёвых символов).',
        {
          stage: 'hit',
          hit: (best as { metrics: SetMetrics }).metrics.hit,
          hitTarget: target.hit,
          rtp: (best as { metrics: SetMetrics }).metrics.rtp,
          rtpTarget,
          notes
        }
      );
    }
    asked.push(next);
    guess = next;
    notes.push(`раунд ${round + 1}: hit ${metrics.hit.toFixed(4)} при цели ${target.hit}, ` +
      `прокси-цель P(линия) → ${guess.toFixed(6)}`);
  }

  const m = best?.metrics;
  throw new TunerError(
    `hit не сходится за ${maxRounds} раундов: цель ${target.hit} ±${hitTol}, ` +
    `ближайшее ${m ? m.hit.toFixed(4) : '—'} при RTP ${m ? m.rtp.toFixed(4) : '—'}. ` +
    'Состав, дающий нужный RTP, не даёт нужного hit: двигайте цель по hit, допуск или ограничения ' +
    'по счётчикам (hit растёт с долей частых дешёвых символов).',
    {
      stage: 'hit',
      hit: m ? m.hit : undefined,
      hitTarget: target.hit,
      rtp: m ? m.rtp : undefined,
      rtpTarget,
      notes
    }
  );
}
