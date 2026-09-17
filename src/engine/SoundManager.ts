// SoundManager.ts - Procedural sound effects using Web Audio API
// No audio files needed - generates sounds at runtime

export type SoundName =
  | "shoot"       // firing a projectile
  | "explosion"   // explosion/AOE
  | "hit"         // bullet hits tank
  | "levelup"     // level up
  | "enemy_die"   // enemy killed
  | "pickup"      // picked up loot
  | "coin"        // gold coin pickup (ding-dong)
  | "wall_hit"    // bullet hits wall
  | "wall_place"  // player places a wall
  | "laser"       // laser beam
  | "black_hole"  // black hole
  | "stun"        // friendly fire stun
  | "base_hit"    // base being hit
  | "game_over"   // game over
  | "shop_buy"    // buying in shop
  | "warning"     // enemy spawn warning
  | "deny"        // invalid action (not enough gold etc.)
  | "coin"        // coin pickup
  ;

export class SoundManager {
  private ctx: AudioContext | null = null;
  private masterVolume: number = 0.3;
  private enabled: boolean = true;

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  setVolume(v: number): void { this.masterVolume = Math.max(0, Math.min(1, v)); }
  setEnabled(e: boolean): void { this.enabled = e; }
  toggle(): boolean { this.enabled = !this.enabled; return this.enabled; }

  play(name: SoundName): void {
    if (!this.enabled) return;
    try {
      const ac = this.getContext();
      const vol = this.masterVolume;
      const now = ac.currentTime;

      switch (name) {
        case "shoot":
          this.playShoot(ac, now, vol);
          break;
        case "explosion":
          this.playExplosion(ac, now, vol);
          break;
        case "hit":
          this.playHit(ac, now, vol);
          break;
        case "levelup":
          this.playLevelUp(ac, now, vol);
          break;
        case "enemy_die":
          this.playEnemyDie(ac, now, vol);
          break;
        case "pickup":
          this.playPickup(ac, now, vol);
          break;
        case "coin":
          this.playCoin(ac, now, vol);
          break;
        case "wall_hit":
          this.playWallHit(ac, now, vol);
          break;
        case "wall_place":
          this.playWallPlace(ac, now, vol);
          break;
        case "laser":
          this.playLaser(ac, now, vol);
          break;
        case "black_hole":
          this.playBlackHole(ac, now, vol);
          break;
        case "stun":
          this.playStun(ac, now, vol);
          break;
        case "base_hit":
          this.playBaseHit(ac, now, vol);
          break;
        case "game_over":
          this.playGameOver(ac, now, vol);
          break;
        case "shop_buy":
          this.playShopBuy(ac, now, vol);
          break;
        case "warning":
          this.playWarning(ac, now, vol);
          break;
        case "deny":
          this.playDeny(ac, now, vol);
          break;
      }
    } catch (_) {
      // AudioContext may not be available - silently ignore
    }
  }

  private playShoot(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.08);
    gain.gain.setValueAtTime(vol * 0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  private playExplosion(ac: AudioContext, now: number, vol: number): void {
    const bufferSize = ac.sampleRate * 0.3;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
    }
    const source = ac.createBufferSource();
    source.buffer = buffer;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(vol * 0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(800, now);
    filter.frequency.exponentialRampToValueAtTime(100, now + 0.3);
    source.connect(filter).connect(gain).connect(ac.destination);
    source.start(now);
    source.stop(now + 0.3);
  }

  private playHit(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.06);
    gain.gain.setValueAtTime(vol * 0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  private playLevelUp(ac: AudioContext, now: number, vol: number): void {
    const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.1);
      gain.gain.linearRampToValueAtTime(vol * 0.2, now + i * 0.1 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.15);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + i * 0.1);
      osc.stop(now + i * 0.1 + 0.15);
    });
  }

  private playEnemyDie(ac: AudioContext, now: number, vol: number): void {
    const bufferSize = Math.floor(ac.sampleRate * 0.15);
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
    }
    const source = ac.createBufferSource();
    source.buffer = buffer;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(vol * 0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    source.connect(gain).connect(ac.destination);
    source.start(now);
    source.stop(now + 0.15);
  }

  private playPickup(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(1600, now + 0.1);
    gain.gain.setValueAtTime(vol * 0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** Gold pickup: bright "ding-dong" two-note chime */
  private playCoin(ac: AudioContext, now: number, vol: number): void {
    const notes = [1318, 1760];  // E6, A6
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.06);
      gain.gain.linearRampToValueAtTime(vol * 0.18, now + i * 0.06 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.14);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 0.14);
    });
  }

  private playWallHit(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.04);
    gain.gain.setValueAtTime(vol * 0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  private playWallPlace(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.1);
    gain.gain.setValueAtTime(vol * 0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  private playLaser(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
    gain.gain.setValueAtTime(vol * 0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  private playBlackHole(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(80, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 1);
    gain.gain.setValueAtTime(vol * 0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 1);
  }

  private playStun(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(100, now + 0.2);
    gain.gain.setValueAtTime(vol * 0.15, now);
    gain.gain.setValueAtTime(vol * 0.15, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  private playBaseHit(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.3);
    gain.gain.setValueAtTime(vol * 0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  private playGameOver(ac: AudioContext, now: number, vol: number): void {
    const notes = [523, 466, 392, 330]; // descending
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.2);
      gain.gain.linearRampToValueAtTime(vol * 0.25, now + i * 0.2 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.2 + 0.3);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + i * 0.2);
      osc.stop(now + i * 0.2 + 0.3);
    });
  }

  private playShopBuy(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.08);
    gain.gain.setValueAtTime(vol * 0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  private playWarning(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(vol * 0.08, now);
    gain.gain.setValueAtTime(vol * 0.08, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  private playDeny(ac: AudioContext, now: number, vol: number): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.setValueAtTime(110, now + 0.09);
    gain.gain.setValueAtTime(vol * 0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  }
}

// Singleton
let _instance: SoundManager | null = null;
export function getSoundManager(): SoundManager {
  if (!_instance) _instance = new SoundManager();
  return _instance;
}