// @gmbl/gm-slots — типы линейного слота.
//
// Границы пакета: барабаны, окно, линии, paytable, wild, «спецсимвол» (скаттер/Money) — всё
// параметрами. Про бонусы, режимы, покупки и конкретную игру пакет не знает; правило гейта
// приходит снаружи описанием, а не кодом.

/** id символа. Числовой — так его хранят ленты и paytable документа игры. */
export type SymbolId = number;

/** Лента одного барабана: id по позициям, циклическая. */
export type Strip = readonly SymbolId[];

/** Сет лент: барабаны слева направо. */
export type ReelSpec = readonly Strip[];

/** Выплаты: id символа → длина комбинации → выплата (в тех же единицах, что `SlotSpec.bet`). */
export type Paytable = Readonly<Record<number, Readonly<Record<number, number>> | undefined>>;

/** Линия — маска рядов по барабанам: значение = индекс ряда в окне. */
export type LineSpec = readonly number[];

/** Описание слота. Всё, что нужно, чтобы посчитать метрики любого сета лент. */
export interface SlotSpec {
  /** Строк в окне. */
  rows: number;
  /** Барабанов. */
  reels: number;
  /** Линии выплат. */
  lines: readonly LineSpec[];
  paytable: Paytable;
  /** Символ-подстановка; платит и сам, если у него есть строка в paytable. */
  wildId: SymbolId;
  /** Спецсимволы (скаттер/Money): линиями не платят, комбинацию рвут, считаются на поле. */
  specialIds: readonly SymbolId[];
  /** Ставка, в которой номинированы выплаты paytable. RTP = E[выплата спина] / bet. */
  bet: number;
}

/** Правило гейта бонуса по числу спецсимволов на поле. Чужая механика — только описание. */
export interface GateRule {
  /** Число спецсимволов, при котором триггер гарантирован. */
  guaranteed?: number;
  /** P(триггер | k спецсимволов) для k < guaranteed. Ключ — число как строка или число. */
  probByCount?: Readonly<Record<string, number>>;
  /** Какие k считаются «почти триггер» (антиципация). */
  anticipationCounts?: readonly number[];
}

/** Точные метрики одного сета лент. Каждая величина считается точно, не оценивается. */
export interface SetMetrics {
  /** RTP сета в долях ставки: Σ по линиям E[выплата линии] / bet. Зависит только от состава. */
  rtp: number;
  /** Вероятность хотя бы одной выигрышной линии. Зависит от порядка. */
  hit: number;
  /** E[выплата ОДНОЙ линии] в единицах paytable. */
  eLine: number;
  /** P(одна линия платит). Порядка не знает — прокси hit для тюнера. */
  pLine: number;
  /** Сколько стоп-сочетаний просмотрено при подсчёте hit (провенанс: это enum, не выборка). */
  hitStops: number;
  /** По скольким барабанам шёл enum hit. */
  hitReels: number;
  /** p_special_k: вероятность ровно k спецсимволов на поле, k = 0..rows×reels. */
  specialDist: number[];
  /** E[число спецсимволов на поле]. */
  eSpecial: number;
  /** Σ specialDist по anticipationCounts правила гейта. */
  pAnticipation: number;
  /** Вероятность триггера по правилу гейта; без правила — 0. */
  pTrigger: number;
  /** trigger_1n: 1/pTrigger, 0 при невозможном триггере. */
  trigger1n: number;
}

/** Ограничение на счётчик символа в ленте. */
export interface CountBound {
  min?: number;
  max?: number;
  exactly?: number;
}

/** Структурное правило раскладки спецсимволов по ленте (оно же — предикат валидатора). */
export interface WindowRule {
  /** Ровно k спецсимволов в ЛЮБОМ окне. Требует делимости: rows % k и len % (rows/k). */
  exactly?: number;
  /** Не менее k в любом окне. */
  min?: number;
  /** Не более k в любом окне. */
  max?: number;
  /** Минимальный (циклический) зазор между соседними спецсимволами. */
  minGap?: number;
  /** Явное число спецсимволов на ленте, когда правило его не задаёт. */
  count?: number;
}

/** Цель по одному барабану. */
export interface ReelTarget {
  /** Длина ленты. Параметр барабана: у «шага k» она обязана делиться нацело. */
  length: number;
  /** Ограничения по счётчикам символов: id → {min,max,exactly}. */
  counts?: Readonly<Record<number, CountBound>>;
  /** Запрещённые на этой ленте id (джекпоты в базовой игре). */
  forbid?: readonly SymbolId[];
  /** Структурное правило по спецсимволам. */
  special?: WindowRule;
  /** Стартовое распределение свободных позиций: id → вес. Влияет только на точку старта. */
  weightHint?: Readonly<Record<number, number>>;
}

/** Обратная задача: чего хотим от сета. */
export interface TunerTarget {
  /** Алфавит: какие id вообще могут стоять на лентах (спецсимволы включительно). */
  symbols: readonly SymbolId[];
  /** По барабану. Длина массива обязана совпасть с slot.reels. */
  reels: readonly ReelTarget[];
  /** Целевой RTP в долях ставки либо 'max' — «максимум достижимого при ограничениях». */
  rtp: number | 'max';
  /** Допуск по RTP (в долях ставки). По умолчанию 0.005. */
  rtpTolerance?: number;
  /** Целевой hit. Без него этап «порядок → замер hit → поправка состава» не запускается. */
  hit?: number;
  /** Допуск по hit. По умолчанию 0.01. */
  hitTolerance?: number;
  /** Сид: детерминизм раскладки. По умолчанию 1. */
  seed?: number;
  /** Потолок шагов координатного спуска на раунд. По умолчанию 4000. */
  maxSteps?: number;
  /** Потолок раундов «состав → порядок → hit → состав». По умолчанию 12. */
  maxRounds?: number;
  /** Требовать присутствия всех id алфавита на каждой ленте. По умолчанию false. */
  requireAll?: boolean;
}

/** Результат тюнера. Промах сюда не попадает: не сошлось — TunerError. */
export interface TunerResult {
  reelset: SymbolId[][];
  metrics: SetMetrics;
  /** Шагов координатного спуска суммарно. */
  steps: number;
  /** Раундов «состав → порядок». */
  rounds: number;
  seed: number;
  /** Человекочитаемые заметки: во что упёрлись, что подтянуто конструктивно. */
  notes: string[];
}
