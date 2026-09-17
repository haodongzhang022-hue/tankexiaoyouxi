// Camera.ts - Scrolling camera for large maps (follows avg player position)
// Includes screen-shake system triggered on explosions/hits for combat feedback.
export class Camera {
  x: number = 0;  // world position of camera top-left
  y: number = 0;
  width: number;
  height: number;
  worldWidth: number;
  worldHeight: number;

  // ── Screen shake ──
  private shakeTime = 0;       // remaining time
  private shakeDuration = 0;   // total duration
  private shakeIntensity = 0;  // max offset px
  private shakeX = 0;          // current offset applied to ctx
  private shakeY = 0;

  constructor(viewW: number, viewH: number, worldW: number, worldH: number) {
    this.width = viewW;
    this.height = viewH;
    this.worldWidth = worldW;
    this.worldHeight = worldH;
  }

  /** Trigger screen shake. intensity = max pixel offset, duration = seconds */
  addShake(intensity: number, duration: number): void {
    // Stronger new shake overrides weaker ongoing one
    this.shakeIntensity = Math.max(this.shakeIntensity * (this.shakeTime / Math.max(0.001, this.shakeDuration)), intensity);
    this.shakeTime = duration;
    this.shakeDuration = duration;
  }

  /** Decay shake over time — call once per update() with dt */
  update(dt: number): void {
    if (this.shakeTime <= 0) {
      this.shakeX = 0;
      this.shakeY = 0;
      return;
    }
    this.shakeTime -= dt;
    const t = Math.max(0, this.shakeTime / this.shakeDuration);
    const amp = this.shakeIntensity * t * t; // ease-out decay
    this.shakeX = (Math.random() * 2 - 1) * amp;
    this.shakeY = (Math.random() * 2 - 1) * amp;
  }

  follow(wx: number, wy: number): void {
    this.x = Math.round(Math.max(0, Math.min(this.worldWidth  - this.width,  wx - this.width  / 2)));
    this.y = Math.round(Math.max(0, Math.min(this.worldHeight - this.height, wy - this.height / 2)));
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx - this.x + this.shakeX, y: wy - this.y + this.shakeY };
  }

  isVisible(wx: number, wy: number, margin = 64): boolean {
    return wx >= this.x - margin && wx <= this.x + this.width  + margin &&
           wy >= this.y - margin && wy <= this.y + this.height + margin;
  }

  applyToCtx(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.translate(-this.x + this.shakeX, -this.y + this.shakeY);
  }

  restoreCtx(ctx: CanvasRenderingContext2D): void {
    ctx.restore();
  }
}
