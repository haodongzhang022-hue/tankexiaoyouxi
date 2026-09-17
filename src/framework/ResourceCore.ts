export type ResourceType = "tank" | "enemy" | "bullet" | "item" | "module" | "map" | "wand" | "unknown";

const PREFIX_MAP: Record<string, ResourceType> = {
  tank: "tank",
  enmy: "enemy",
  bull: "bullet",
  item: "item",
  modu: "module",
  map_: "map",
  wand: "wand",
};

export class ResourceCore {
  private static instance: ResourceCore;
  private configs: Map<string, Record<string, unknown>> = new Map();

  static getInstance(): ResourceCore {
    if (!ResourceCore.instance) ResourceCore.instance = new ResourceCore();
    return ResourceCore.instance;
  }

  parseType(id: string): ResourceType {
    return PREFIX_MAP[id.substring(0, 4)] ?? "unknown";
  }

  register(id: string, config: Record<string, unknown>): void {
    this.configs.set(id, config);
  }

  get<T = Record<string, unknown>>(id: string): T | null {
    return (this.configs.get(id) as T) ?? null;
  }

  getAll(type: ResourceType): Record<string, unknown>[] {
    return [...this.configs.entries()]
      .filter(([id]) => this.parseType(id) === type)
      .map(([, cfg]) => cfg);
  }
}
