//  MapGenerator.ts ─
//  v2.3 主题化程序化地形生成
//  多遍生成流程（同一 Seeded RNG 保证可复现）：
//    1. 边框墙 → 2. 墙体布局（每主题不同：散点/线墙/房间/冰脊）
//    3. 危险地形（水/岩浆/毒沼/油渍） → 4. 装饰（森林/冰面）
//    5. 基地/出生区/出生通道清空（保证连通） → 6. 基地正面护墙（S 形缺口）
import { Tilemap, TileType, type TileElement } from "../../game/Tilemap";

export type BiomeId = "classic" | "ice" | "volcano" | "swamp" | "steel" | "jungle";

export interface BiomeDef {
  id: BiomeId;
  name: string;
  color: string;
  wallType: TileType.Brick | TileType.Steel;
  wallDensity: number;         // 墙体覆盖比例（0-1）
  steelRatio: number;          // 墙中钢铁比例
  wallShape: "scatter" | "lines" | "rooms" | "bands";
  hazardType: TileType | null; // 危险地面：Water/Ice/Forest/Empty(空地+永久状态)
  hazardDensity: number;
  hazardState?: TileElement;   // 危险地面附带永久状态（fire=岩浆/oil=油渍/poison=毒沼）
  hazardStateRatio: number;    // 危险格中带状态的比例
  hazardStateIntensity?: number;
  decorType: TileType | null;  // 装饰（Forest/Ice）
  decorDensity: number;
}

export const BIOMES: BiomeDef[] = [
  {
    id: "classic", name: "经典", color: "#333",
    wallType: TileType.Brick, wallDensity: 0.13, steelRatio: 0.25, wallShape: "scatter",
    hazardType: TileType.Water, hazardDensity: 0.024,
    hazardStateRatio: 0,
    decorType: TileType.Forest, decorDensity: 0.032,
  },
  {
    id: "ice", name: "冰雪", color: "#9cf",
    wallType: TileType.Steel, wallDensity: 0.10, steelRatio: 0.5, wallShape: "bands",
    hazardType: TileType.Water, hazardDensity: 0.03,
    hazardStateRatio: 0,
    decorType: TileType.Ice, decorDensity: 0.05,
  },
  {
    id: "volcano", name: "火山", color: "#f73",
    wallType: TileType.Steel, wallDensity: 0.12, steelRatio: 0.7, wallShape: "lines",
    hazardType: TileType.Empty, hazardDensity: 0.045, hazardState: "fire",
    hazardStateRatio: 1, hazardStateIntensity: 2,
    decorType: TileType.Forest, decorDensity: 0.025,
  },
  {
    id: "swamp", name: "沼泽", color: "#3a5",
    wallType: TileType.Brick, wallDensity: 0.08, steelRatio: 0.15, wallShape: "scatter",
    hazardType: TileType.Water, hazardDensity: 0.03,
    hazardStateRatio: 0,  // v2.15 去掉毒雾状态：水面改为蓝色海面效果，不再有绿泡泡突变
    decorType: TileType.Forest, decorDensity: 0.04,
  },
  {
    id: "steel", name: "钢铁", color: "#888",
    wallType: TileType.Steel, wallDensity: 0.16, steelRatio: 0.85, wallShape: "rooms",
    hazardType: TileType.Empty, hazardDensity: 0.03, hazardState: "oil",
    hazardStateRatio: 1,
    decorType: null, decorDensity: 0,
  },
  {
    id: "jungle", name: "丛林", color: "#1a6",
    wallType: TileType.Brick, wallDensity: 0.09, steelRatio: 0.2, wallShape: "scatter",
    hazardType: TileType.Forest, hazardDensity: 0.055,
    hazardStateRatio: 0,
    decorType: TileType.Forest, decorDensity: 0.05,
  },
];

export function biomeForStage(stage: number): BiomeDef {
  const chapter = Math.floor((stage - 1) / 5);
  return BIOMES[chapter % BIOMES.length];
}

/** mulberry32：小而可复现的 Seeded RNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一张主题化地图。
 * @param seed       可复现种子（同一 seed + biome 生成完全相同地图）
 * @param difficulty 0-1：越高墙体越密越硬、危险地形越多
 */
export function generateMap(
  tilemap: Tilemap,
  biome: BiomeDef,
  seed: number,
  difficulty: number,
): void {
  // 设置生物群系（影响地图渲染配色）
  tilemap.biome = biome.id;
  const W = tilemap.cols;
  const H = tilemap.rows;
  const rng = mulberry32(seed);
  const rr = (n: number) => Math.floor(rng() * n);
  const chance = (p: number) => rng() < p;
  const inInterior = (c: number, r: number) => c >= 1 && c < W - 1 && r >= 1 && r < H - 1;

  // 1. 边框墙
  for (let c = 0; c < W; c++) { tilemap.set(c, 0, TileType.Wall); tilemap.set(c, H - 1, TileType.Wall); }
  for (let r = 0; r < H; r++) { tilemap.set(0, r, TileType.Wall); tilemap.set(W - 1, r, TileType.Wall); }

  // 难度缩放：墙更密更硬、危险更多
  const wallDensity = Math.min(0.30, biome.wallDensity * (1 + difficulty * 0.8));
  const steelRatio = Math.min(0.92, biome.steelRatio + difficulty * 0.25);
  const hazardDensity = biome.hazardDensity * (1 + difficulty * 0.6);
  const wallCount = Math.round(W * H * wallDensity);

  const setWall = (c: number, r: number): void => {
    if (!inInterior(c, r)) return;
    if (tilemap.get(c, r)!.type !== TileType.Empty) return;
    tilemap.set(c, r, chance(steelRatio) ? TileType.Steel : TileType.Brick);
  };

  // 2. 墙体布局（每主题不同形态）
  switch (biome.wallShape) {
    case "scatter": {
      // 经典/沼泽/丛林：随机散点 + 相邻延伸
      for (let i = 0; i < wallCount; i++) {
        const c = 1 + rr(W - 2);
        const r = 4 + rr(H - 9);
        setWall(c, r);
        if (chance(0.5)) setWall(c + 1, r);
        if (chance(0.5)) setWall(c, r + 1);
      }
      break;
    }
    case "lines": {
      // 火山：熔岩裂缝两侧的玄武岩短墙
      for (let i = 0; i < wallCount; i++) {
        const horizontal = chance(0.5);
        const c = 1 + rr(W - 6);
        const r = 4 + rr(H - 9);
        const len = 2 + rr(3);
        for (let k = 0; k < len; k++) setWall(horizontal ? c + k : c, horizontal ? r : r + k);
      }
      break;
    }
    case "bands": {
      // 冰雪：横向冰脊/墙体带
      for (let i = 0; i < wallCount; i++) {
        const r = 4 + rr(H - 10);
        const c0 = 1 + rr(W - 6);
        for (let c = c0; c < c0 + 4; c++) setWall(c, r);
      }
      break;
    }
    case "rooms": {
      // 钢铁：房间式墙体围合
      for (let i = 0; i < Math.ceil(wallCount / 4); i++) {
        const c = 2 + rr(W - 8);
        const r = 4 + rr(H - 10);
        const w = 2 + rr(3);
        const h = 2 + rr(3);
        for (let dc = -1; dc <= w; dc++) { setWall(c + dc, r); setWall(c + dc, r + h); }
        for (let dr = 0; dr <= h; dr++) { setWall(c - 1, r + dr); setWall(c + w, r + dr); }
      }
      break;
    }
  }

  // 3. 危险地形（水/岩浆/毒沼/油渍）
  // v2.15 水面改为大片连续区域（海面效果），其他危险地形保持原有散布方式
  const hazardCount = Math.round(W * H * hazardDensity);
  for (let i = 0; i < hazardCount; i++) {
    const c = 2 + rr(W - 4);
    const r = 5 + rr(H - 10);
    if (r >= H - 5) continue;

    if (biome.hazardType === TileType.Empty) {
      // 岩浆/油渍：空地 + 永久状态（覆盖墙体，熔岩"吞噬"砖石）
      if (biome.hazardState) {
        tilemap.set(c, r, TileType.Empty);
        tilemap.setPersistentState(c, r, biome.hazardState, biome.hazardStateIntensity ?? 1);
      }
    } else if (biome.hazardType === TileType.Water) {
      // v2.15 水面：生成大片连续区域（海面效果），2x2 或 3x3 块状
      if (tilemap.get(c, r)!.type !== TileType.Empty) continue;  // 不覆盖墙体
      const blockSize = chance(0.4) ? 3 : 2;  // 40% 概率 3x3，60% 概率 2x2
      for (let dc = 0; dc < blockSize; dc++) {
        for (let dr = 0; dr < blockSize; dr++) {
          const nc = c + dc, nr = r + dr;
          if (nc >= W - 1 || nr >= H - 5) continue;
          if (tilemap.get(nc, nr)!.type === TileType.Empty) {
            tilemap.set(nc, nr, TileType.Water);
          }
        }
      }
    } else if (biome.hazardType) {
      // 其他危险地形（森林等）：保持原有散布方式
      if (tilemap.get(c, r)!.type !== TileType.Empty) continue;  // 不覆盖墙体
      if (chance(0.6)) tilemap.set(c, r, biome.hazardType);
      if (chance(0.4)) tilemap.set(c + 1, r, biome.hazardType);
    }
  }

  // 4. 装饰（森林/冰面）
  if (biome.decorType) {
    const decorCount = Math.round(W * H * biome.decorDensity);
    for (let i = 0; i < decorCount; i++) {
      const c = 2 + rr(W - 4);
      const r = 5 + rr(H - 10);
      if (r >= H - 5) continue;
      if (tilemap.get(c, r)!.type !== TileType.Empty) continue;
      if (chance(0.6)) tilemap.set(c, r, biome.decorType);
      if (chance(0.4)) tilemap.set(c + 1, r, biome.decorType);
    }
  }

  // 5. 基地/出生区/出生通道清空（保证连通性，与旧 buildMap 一致的通行保证）
  for (let r = 1; r <= 3; r++)
    for (let c = 1; c < W - 1; c++) tilemap.set(c, r, TileType.Empty);
  for (let r = H - 5; r <= H - 2; r++)
    for (let c = 1; c < W - 1; c++) tilemap.set(c, r, TileType.Empty);

  const spawnCols = [
    Math.floor(W * 0.1), Math.floor(W * 0.25), Math.floor(W * 0.5),
    Math.floor(W * 0.75), Math.floor(W * 0.9),
  ];
  for (const sc of spawnCols)
    for (let r = 1; r < H - 1; r++)
      for (let dc = -1; dc <= 1; dc++) {
        const cc = sc + dc;
        if (cc >= 1 && cc < W - 1) tilemap.set(cc, r, TileType.Empty);
      }

  const midC = Math.floor(W / 2);
  for (let r = H - 7; r <= H - 4; r++)
    for (let dc = -3; dc <= 3; dc++) {
      const cc = midC + dc;
      if (cc >= 1 && cc < W - 1) tilemap.set(cc, r, TileType.Empty);
    }

  // 6. 基地正面护墙：挡住正中线直射（基地在底中 bc=W/2, br=H-4），留 S 形缺口绕行
  const bc = midC;
  const br = H - 4;
  for (let c = bc - 2; c <= bc + 1; c++) {
    tilemap.set(c, br - 6, TileType.Brick);
    tilemap.set(c, br - 5, TileType.Brick);
  }
  tilemap.set(bc,     br - 6, TileType.Empty);  // 缺口：先下后右的绕行入口
  tilemap.set(bc + 1, br - 5, TileType.Empty);

  // 7. v2.15 连通性检验：BFS 洪水填充，确保玩家出生点到敌人出生点有通路
  // 可通行：空地、砖墙（可破坏）、森林、冰面、基地
  // 不可通行：水面、钢墙、边界墙
  verifyConnectivity(tilemap, W, H);
}

// ── v2.15 连通性检验：BFS 洪水填充，确保不被水面/钢墙完全阻断 ──
function verifyConnectivity(tilemap: Tilemap, W: number, H: number): void {
  const isPassable = (c: number, r: number): boolean => {
    if (c < 0 || c >= W || r < 0 || r >= H) return false;
    const t = tilemap.get(c, r);
    if (!t) return false;
    // 可通行：空地、砖墙（可破坏）、森林、冰面、基地
    return t.type === TileType.Empty || t.type === TileType.Brick ||
           t.type === TileType.Forest || t.type === TileType.Ice || t.type === TileType.Base;
  };

  // 从玩家出生点（底部中间）开始 BFS
  const startC = Math.floor(W / 2);
  const startR = H - 3;
  const visited = new Set<number>();
  const queue: Array<[number, number]> = [[startC, startR]];
  visited.add(startR * W + startC);

  while (queue.length > 0) {
    const [c, r] = queue.shift()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc, nr = r + dr;
      const key = nr * W + nc;
      if (visited.has(key)) continue;
      if (!isPassable(nc, nr)) continue;
      visited.add(key);
      queue.push([nc, nr]);
    }
  }

  // 检验敌人出生点（顶部5个位置）是否可达
  const spawnCols = [
    Math.floor(W * 0.1), Math.floor(W * 0.25), Math.floor(W * 0.5),
    Math.floor(W * 0.75), Math.floor(W * 0.9),
  ];
  let allReachable = true;
  for (const sc of spawnCols) {
    if (!visited.has(2 * W + sc)) {
      allReachable = false;
      break;
    }
  }

  // 如果有不可达的出生点，打通通路：沿中间列移除水面/钢墙
  if (!allReachable) {
    const midC = Math.floor(W / 2);
    for (let r = 2; r < H - 3; r++) {
      const t = tilemap.get(midC, r);
      if (t && (t.type === TileType.Water || t.type === TileType.Steel)) {
        tilemap.set(midC, r, TileType.Empty);
      }
    }
  }
}
