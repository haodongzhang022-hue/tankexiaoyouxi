type Listener = (...args: unknown[]) => void;

export class EventManager {
  private static instance: EventManager;
  private listeners: Map<string, Set<Listener>> = new Map();

  static getInstance(): EventManager {
    if (!EventManager.instance) EventManager.instance = new EventManager();
    return EventManager.instance;
  }

  on(event: string, fn: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  off(event: string, fn: Listener): void {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach(fn => fn(...args));
  }

  once(event: string, fn: Listener): void {
    const wrapper: Listener = (...args) => { fn(...args); this.off(event, wrapper); };
    this.on(event, wrapper);
  }
}
