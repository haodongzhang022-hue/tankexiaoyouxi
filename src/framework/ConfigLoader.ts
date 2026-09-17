export class ConfigLoader {
  private static instance: ConfigLoader;
  private cache: Map<string, unknown> = new Map();

  static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) ConfigLoader.instance = new ConfigLoader();
    return ConfigLoader.instance;
  }

  async load<T>(path: string): Promise<T> {
    if (this.cache.has(path)) return this.cache.get(path) as T;
    const res = await fetch(path);
    if (!res.ok) throw new Error(`ConfigLoader: failed to load ${path} (${res.status})`);
    const data = await res.json() as T;
    this.cache.set(path, data);
    return data;
  }

  // Deep merge: source overrides base, missing fields use base defaults
  merge<T extends Record<string, unknown>>(base: T, source: Partial<T>): T {
    const result = { ...base };
    for (const key in source) {
      const sv = source[key];
      const bv = base[key];
      if (sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
          bv !== null && typeof bv === "object" && !Array.isArray(bv)) {
        result[key] = this.merge(bv as Record<string, unknown>, sv as Record<string, unknown>) as T[typeof key];
      } else if (sv !== undefined) {
        result[key] = sv as T[typeof key];
      }
    }
    return result;
  }

  clearCache(): void { this.cache.clear(); }
}
