// @gmbl/gm-slots — точный басис линейного слота и подбор лент под целевые метрики.
//
// Что здесь: оценка линии (evaluate), точные метрики сета (basis), обратная задача (tuner),
// структурные предикаты лент (validate), детерминированный ГПСЧ раскладки (rng).
//
// Что остаётся игре: символы, paytable, линии, правило гейта бонуса, семейства лент и их смысл.
// Пакет знает про барабаны, окно, линии, wild и «спецсимвол» — и ни про одну конкретную игру.

export type {
  SymbolId, Strip, ReelSpec, Paytable, LineSpec, SlotSpec, GateRule, SetMetrics,
  CountBound, WindowRule, ReelTarget, TunerTarget, TunerResult
} from './types.ts';

export { evaluateTuple, evaluateLine, evaluatePaylines, totalWin } from './evaluate.ts';
export type { EvalSpec, TupleWin, LineWin, Field } from './evaluate.ts';

export {
  prepareSlot, stripFreq, countsFreq, expectedLine, expectedLineWin, hitRate, windowCounts,
  specialDist, triggerProb, setMetrics, minComboReels, linearRtp, linearBlend
} from './basis.ts';
export type { SlotContext, ReelFreq, BasisOptions, HitResult, LinearBlend } from './basis.ts';

export {
  specialWindowBounds, fieldSpecialBounds, specialCountInWindow, symbolAbsent, specialPositions,
  specialGap, minGap, allSymbolsPresent, onlyKnownSymbols, validateStrip
} from './validate.ts';
export type { WindowBounds, StripRules } from './validate.ts';

export { tuneReels, planSpecialPositions, TunerError } from './tuner.ts';
export type { TunerDiagnostics } from './tuner.ts';

export { mulberry32, randomInt, shuffle } from './rng.ts';
