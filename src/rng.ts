// Детерминированный ГПСЧ для раскладки лент. Тюнер обязан быть воспроизводим по сиду: лента —
// это данные документа игры, и «пересобрал — получил другое» здесь недопустимо.
// mulberry32 — тот же приём, что в движках слотов: чистая функция от 32-битного состояния.

/** Генератор [0,1) по 32-битному сиду. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Целое из [0, n). */
export function randomInt(n: number, rng: () => number): number {
  return Math.floor(rng() * n) % n;
}

/** Перемешивание на месте (Фишер—Йейтс), детерминированное по rng. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1, rng);
    const t = items[i] as T;
    items[i] = items[j] as T;
    items[j] = t;
  }
  return items;
}
