// Weighted random pick: items = [{type, prob}]
export function weightedRandom<T extends { prob: number }>(items: T[]): T | null {
  if (!items.length) return null;
  const total = items.reduce((s, i) => s + i.prob, 0);
  let r = Math.random() * total;
  for (const item of items) { r -= item.prob; if (r <= 0) return item; }
  return items[items.length - 1];
}

export class AIExecutor {
  private static instance: AIExecutor;
  private rules: Map<string, { prob: number; type: string }[]> = new Map();

  static getInstance(): AIExecutor {
    if (!AIExecutor.instance) AIExecutor.instance = new AIExecutor();
    return AIExecutor.instance;
  }

  registerRule(aiType: string, actions: { prob: number; type: string }[]): void {
    this.rules.set(aiType, actions);
  }

  execute(aiType: string): string {
    const actions = this.rules.get(aiType) ?? this.rules.get("aggressive") ?? [];
    return weightedRandom(actions)?.type ?? "idle";
  }

  getRule(aiType: string) { return this.rules.get(aiType); }
}
