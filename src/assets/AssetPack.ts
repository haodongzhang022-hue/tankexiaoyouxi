/**
 * AssetPack.ts —— 视觉资源包系统
 *
 * 把所有重复出现的通用视觉素材（生物群系配色、坦克外观、特效样式）集中管理。
 * 联机时 2 号机一次性下载主机的资源包并覆盖本地配置，确保两端视觉 100% 一致，
 * 避免"各自生成导致视觉偏差"。
 *
 * 资源包通过检查点（checkpoint）消息传输，只在首次连接或版本不匹配时发送。
 */

// ═══════════════════════════════════════════════════════════
//  类型定义
// ═══════════════════════════════════════════════════════════

/** 生物群系配色 */
export interface BiomeColors {
  ground: string;
  groundAlt: string;
  water: string;
  waterDeep: string;
  forest: string;
  forestLight: string;
  brick: string;
  brickDark: string;
  steel: string;
  steelDark: string;
  ice: string;
  iceLight: string;
}

/** 敌军坦克等级外观 */
export interface GradeVisual {
  bodyLight: string;
  bodyDark: string;
  trackColor: string;
  turretColor: string;
  accentColor: string;
  glowColor?: string;
  armorPlates: number;
  spikes: boolean;
  energyLines: boolean;
}

/** 玩家坦克配色 */
export interface PlayerTankColors {
  mainLight: string;
  mainDark: string;
  bodyMid: string;  // 渐变中间色
  trackColor: string;
  turretLight: string;
  turretDark: string;
  accent: string;
}

/** 特效样式 */
export interface EffectStyles {
  explosion: {
    colors: [string, string, string]; // 中心/中间/边缘
    duration: number; // 秒
  };
  damageNumber: {
    font: string;
    critFont: string;
    color: string;
    critColor: string;
  };
  hitFlash: {
    color: string;
    duration: number; // 秒
    alpha: number;
  };
}

/** 完整资源包 */
export interface AssetPack {
  /** 资源包版本（格式：主.次，如 "2.17"） */
  version: string;
  /** 生物群系配色表 */
  biomes: Record<string, BiomeColors>;
  /** 敌军坦克等级外观 */
  enemyTanks: Record<string, GradeVisual>;
  /** 玩家坦克配色（P1/P2） */
  playerTanks: { P1: PlayerTankColors; P2: PlayerTankColors };
  /** 特效样式 */
  effects: EffectStyles;
}

// ═══════════════════════════════════════════════════════════
//  默认资源包（与代码中硬编码的原始值一致）
// ═══════════════════════════════════════════════════════════

export const DEFAULT_ASSET_PACK: AssetPack = {
  version: "2.36",

  biomes: {
    classic: {
      ground: "#1a1d24", groundAlt: "#161920",
      water: "#1a5ab0", waterDeep: "#0a2a5a",
      forest: "#1a5c00", forestLight: "#2d7a00",
      brick: "#c84800", brickDark: "#7a2a00",
      steel: "#9a9a9a", steelDark: "#5a5a5a",
      ice: "#aaddff", iceLight: "#d0eeff",
    },
    ice: {
      ground: "#1a2230", groundAlt: "#161e2a",
      water: "#2a6ab8", waterDeep: "#0a3060",
      forest: "#2a6c20", forestLight: "#3d8a30",
      brick: "#b85820", brickDark: "#6a3010",
      steel: "#aab8c8", steelDark: "#6a7888",
      ice: "#b8e0ff", iceLight: "#e0f4ff",
    },
    volcano: {
      ground: "#2a1818", groundAlt: "#221212",
      water: "#8a3010", waterDeep: "#4a1808",
      forest: "#3a4a10", forestLight: "#4a5a20",
      brick: "#a83810", brickDark: "#5a1c08",
      steel: "#8a7870", steelDark: "#4a3830",
      ice: "#8ab0c8", iceLight: "#b0d0e0",
    },
    swamp: {
      ground: "#1a2418", groundAlt: "#141e12",
      water: "#2a5a30", waterDeep: "#0a2a18",
      forest: "#1a4c10", forestLight: "#2a6a20",
      brick: "#a85020", brickDark: "#5a2810",
      steel: "#8a9a88", steelDark: "#4a5a48",
      ice: "#9ac8b0", iceLight: "#c0e0d0",
    },
    steel: {
      ground: "#202028", groundAlt: "#1a1a22",
      water: "#3a5a7a", waterDeep: "#1a2a3a",
      forest: "#2a4a2a", forestLight: "#3a5a3a",
      brick: "#9a5030", brickDark: "#5a2818",
      steel: "#a8a8b0", steelDark: "#686870",
      ice: "#a0c0d0", iceLight: "#c8e0f0",
    },
    jungle: {
      ground: "#142010", groundAlt: "#101a0c",
      water: "#1a5a40", waterDeep: "#082a18",
      forest: "#0f4a08", forestLight: "#1f6a18",
      brick: "#b04818", brickDark: "#602408",
      steel: "#8a9a80", steelDark: "#4a5a40",
      ice: "#90c8a8", iceLight: "#b8e0c8",
    },
  },

  enemyTanks: {
    F: {
      bodyLight: "#b07850", bodyDark: "#6a4828",
      trackColor: "#2a1f15", turretColor: "#5a3e22",
      accentColor: "#3a2815", armorPlates: 0, spikes: false, energyLines: false,
    },
    C: {
      bodyLight: "#5a9a5a", bodyDark: "#2e5a2e",
      trackColor: "#1a2a1a", turretColor: "#244a24",
      accentColor: "#88bb88", armorPlates: 1, spikes: false, energyLines: false,
    },
    B: {
      bodyLight: "#5a7acc", bodyDark: "#2a3a7a",
      trackColor: "#151a2e", turretColor: "#223060",
      accentColor: "#7a9aff", armorPlates: 2, spikes: false, energyLines: false,
    },
    A: {
      bodyLight: "#cc5555", bodyDark: "#7a2222",
      trackColor: "#2a1010", turretColor: "#5a1818",
      accentColor: "#ff8866", armorPlates: 2, spikes: true, energyLines: false,
    },
    S: {
      bodyLight: "#ff4444", bodyDark: "#aa1111",
      trackColor: "#2a0808", turretColor: "#661010",
      accentColor: "#ffaa44", glowColor: "#ff6644",
      armorPlates: 3, spikes: true, energyLines: true,
    },
    // v2.36 新增 S2~S5 梯队外观（与 Enemy.ts 配色对齐）
    S2: {
      bodyLight: "#ff8844", bodyDark: "#aa4411",
      trackColor: "#2a1408", turretColor: "#662a10",
      accentColor: "#ffbb66", glowColor: "#ff8844",
      armorPlates: 3, spikes: true, energyLines: true,
    },
    S3: {
      bodyLight: "#cc44ff", bodyDark: "#661188",
      trackColor: "#1a052a", turretColor: "#441055",
      accentColor: "#dd88ff", glowColor: "#cc44ff",
      armorPlates: 3, spikes: true, energyLines: true,
    },
    S4: {
      bodyLight: "#00ccff", bodyDark: "#005588",
      trackColor: "#051a2a", turretColor: "#104455",
      accentColor: "#88eeff", glowColor: "#00ccff",
      armorPlates: 4, spikes: true, energyLines: true,
    },
    S5: {
      bodyLight: "#ffdd00", bodyDark: "#885500",
      trackColor: "#2a1a05", turretColor: "#554400",
      accentColor: "#ffee88", glowColor: "#ffdd00",
      armorPlates: 4, spikes: true, energyLines: true,
    },
    BOSS: {
      bodyLight: "#ff44ff", bodyDark: "#881188",
      trackColor: "#1a051a", turretColor: "#551055",
      accentColor: "#ff88ff", glowColor: "#ff44ff",
      armorPlates: 4, spikes: true, energyLines: true,
    },
  },

  playerTanks: {
    P1: {
      mainLight: "#5aa0ff", mainDark: "#1a4caf", bodyMid: "#3a7cdf",
      trackColor: "#0a1a3a", turretLight: "#7ab8ff", turretDark: "#2a5cbf",
      accent: "#aaddff",
    },
    P2: {
      mainLight: "#5ae06a", mainDark: "#1a8a2a", bodyMid: "#3aba4a",
      trackColor: "#0a2a10", turretLight: "#7aea8a", turretDark: "#2a9a3a",
      accent: "#bbffbb",
    },
  },

  effects: {
    explosion: {
      colors: ["#ffffff", "#ff8800", "rgba(200,0,0,0)"],
      duration: 0.5,
    },
    damageNumber: {
      font: "12px monospace",
      critFont: "bold 15px monospace",
      color: "#ffffff",
      critColor: "#ffff44",
    },
    hitFlash: {
      color: "rgba(255,255,255,ALPHA)",
      duration: 0.18,
      alpha: 0.7,
    },
  },
};

// ═══════════════════════════════════════════════════════════
//  全局资源包管理器
// ═══════════════════════════════════════════════════════════

class AssetPackManager {
  private current: AssetPack = { ...DEFAULT_ASSET_PACK };
  private listeners: Array<(pack: AssetPack) => void> = [];

  /** 获取当前资源包 */
  get(): AssetPack {
    return this.current;
  }

  /** 获取资源包版本 */
  getVersion(): string {
    return this.current.version;
  }

  /** 计算资源包 hash（简单字符串哈希，用于版本比对） */
  computeHash(): string {
    const str = JSON.stringify(this.current);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 应用资源包（远端下载后调用，直接覆盖，无需玩家手动调整）
   * 合并策略：新包字段覆盖旧包，缺失字段保留默认值
   */
  apply(pack: Partial<AssetPack>): void {
    this.current = {
      ...DEFAULT_ASSET_PACK,
      ...pack,
      biomes: { ...DEFAULT_ASSET_PACK.biomes, ...(pack.biomes ?? {}) },
      enemyTanks: { ...DEFAULT_ASSET_PACK.enemyTanks, ...(pack.enemyTanks ?? {}) },
      playerTanks: {
        P1: { ...DEFAULT_ASSET_PACK.playerTanks.P1, ...(pack.playerTanks?.P1 ?? {}) },
        P2: { ...DEFAULT_ASSET_PACK.playerTanks.P2, ...(pack.playerTanks?.P2 ?? {}) },
      },
      effects: { ...DEFAULT_ASSET_PACK.effects, ...(pack.effects ?? {}) },
    };
    this.listeners.forEach((fn) => fn(this.current));
  }

  /** 重置为默认资源包 */
  reset(): void {
    this.current = { ...DEFAULT_ASSET_PACK };
    this.listeners.forEach((fn) => fn(this.current));
  }

  /** 订阅资源包变化 */
  subscribe(fn: (pack: AssetPack) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** 导出为可传输的 JSON（去掉函数等不可序列化内容） */
  toJSON(): AssetPack {
    return JSON.parse(JSON.stringify(this.current));
  }
}

/** 全局单例 */
export const assetPack = new AssetPackManager();

/** 便捷获取：生物群系配色 */
export function getBiomeColors(biome?: string): BiomeColors {
  const pack = assetPack.get();
  return pack.biomes[biome ?? "classic"] ?? pack.biomes.classic;
}

/** 便捷获取：敌军坦克等级外观 */
export function getGradeVisual(grade?: string): GradeVisual {
  const pack = assetPack.get();
  return pack.enemyTanks[grade ?? "F"] ?? pack.enemyTanks.F;
}

/** 便捷获取：玩家坦克配色 */
export function getPlayerTankColors(playerId: number): PlayerTankColors {
  const pack = assetPack.get();
  return playerId === 1 ? pack.playerTanks.P2 : pack.playerTanks.P1;
}
