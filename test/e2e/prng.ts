/** The e2e fuzz PRNG: a run is a pure function of its seed, so nothing here touches Date.now or Math.random. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLabel(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      throw new Error(`Rng.int: maxExclusive (${maxExclusive}) must be positive`);
    }
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Rng.pick: empty array");
    }
    return items[this.int(items.length)] as T;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** The child depends on (seed, label) alone, however many draws the parent has taken, so a sub-decision replays on its own. */
  fork(label: string): Rng {
    return new Rng(hashLabel(this.seed, label));
  }
}
