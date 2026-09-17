//  GameLoop.ts ─
// Fixed-timestep game loop with interpolation.

export type UpdateFn = (dt: number) => void;
export type RenderFn = (alpha: number) => void;

const FIXED_DT = 1 / 60;   // 60 ticks/s
const MAX_FRAME_TIME = 0.25; // prevent spiral of death

export class GameLoop {
  private running = false;
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;

  private onUpdate: UpdateFn;
  private onRender: RenderFn;

  // Performance stats
  fps = 0;
  private fpsCounter = 0;
  private fpsTimer = 0;

  constructor(update: UpdateFn, render: RenderFn) {
    this.onUpdate = update;
    this.onRender = render;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private loop = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME;

    this.accumulator += frameTime;
    while (this.accumulator >= FIXED_DT) {
      this.onUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }

    this.onRender(this.accumulator / FIXED_DT);

    // FPS counter
    this.fpsCounter++;
    this.fpsTimer += frameTime;
    if (this.fpsTimer >= 1) {
      this.fps = this.fpsCounter;
      this.fpsCounter = 0;
      this.fpsTimer -= 1;
    }
  };
}
