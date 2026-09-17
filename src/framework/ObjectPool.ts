export class ObjectPool<T> {
  private pool: T[] = [];
  private factory: () => T;
  private reset: (obj: T) => void;

  constructor(factory: () => T, reset: (obj: T) => void, preAllocate = 0) {
    this.factory = factory;
    this.reset = reset;
    for (let i = 0; i < preAllocate; i++) this.pool.push(factory());
  }

  acquire(): T {
    return this.pool.length > 0 ? this.pool.pop()! : this.factory();
  }

  release(obj: T): void {
    this.reset(obj);
    this.pool.push(obj);
  }

  get size(): number { return this.pool.length; }
}
