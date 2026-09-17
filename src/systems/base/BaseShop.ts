//  BaseShop.ts ─ v2.7 基地商店（单机/主机端）
//  基地随机出现货物（商店面板）：每 60s 刷新 5 件 —— 1 件×0.2、1 件×0.5、3 件原价；
//  商品按强度定级定价（越强越贵，杜绝"强而便宜"导致的难度骤变）；用「经验」（=原经验钱包）购买。
//  购买效果由游戏模式侧（GameModeCore.buyShopItem）执行；本类只负责库存/刷新/折扣/渲染/点选。

export interface ShopCatalogItem {
  id: string;
  name: string;
  desc: string;
  kind: "item" | "module" | "levelup";   // 传统道具 / 模块 / v2.14.2升级服务
  price: number;             // 原价（经验）→ 打折价按折扣算；levelup 忽略此字段（动态按等级算）
  color: string;
  /** v2.34 炮筒扩容件：不进普通随机池，改走独立出现率（每件 10%）+ 独立折扣（50% 概率、随机 1~9 折） */
  slotItem?: boolean;
}

/** 商品目录：价格随强度梯度递增（修理＜维修件＜加速＜护盾＜火力＜加命＜时停＜炸弹＜模块……最强最贵） */
export const SHOP_CATALOG: ShopCatalogItem[] = [
  // v2.14.2：升级服务为固定项（不随机，永远在商店最后一格），价格由 GameModeCore.requestLevelUp 动态算
  { id: "levelup", name: "升级·三选一", desc: "花经验抽三选一永久强化", kind: "levelup", price: 0, color: "#ffd700" },
  { id: "item_repair_kit", name: "维修套件", desc: "修复基地一面墙", kind: "item", price: 25, color: "#4af" },
  { id: "item_extra_life", name: "额外命", desc: "+1 条命", kind: "item", price: 120, color: "#f4a" },
  { id: "item_speed_boost", name: "加速药水", desc: "移速+50%，持续15s", kind: "item", price: 45, color: "#6cf" },
  { id: "item_damage_boost", name: "攻击强化", desc: "伤害+30%，持续10s", kind: "item", price: 80, color: "#f80" },
  { id: "item_shield", name: "护盾", desc: "吸收下一次伤害", kind: "item", price: 60, color: "#8cf" },
  { id: "item_timestop", name: "时停", desc: "3s 内敌人静止", kind: "item", price: 150, color: "#a4f" },
  { id: "item_bomb", name: "全场炸弹", desc: "对全屏敌人造成伤害", kind: "item", price: 200, color: "#f55" },
  { id: "repair_base", name: "基地大修", desc: "补满基地墙与血量", kind: "item", price: 40, color: "#2d9" },
  // v2.34 炮筒扩容（用户口径）：1~4 号炮筒各一件 —— 该炮筒模块位 +1（上限 16 孔）；每件 300 经验
  //   买一次即售罄（等下次刷新可再出）；出现率每件独立 10%；折扣独立：50% 概率打折、随机 1~9 折
  { id: "item_cannon_slot_1", name: "炮筒1·扩容", desc: "1号炮筒模块位+1（上限16）", kind: "item", price: 300, color: "#8f8", slotItem: true },
  { id: "item_cannon_slot_2", name: "炮筒2·扩容", desc: "2号炮筒模块位+1（上限16）", kind: "item", price: 300, color: "#8f8", slotItem: true },
  { id: "item_cannon_slot_3", name: "炮筒3·扩容", desc: "3号炮筒模块位+1（上限16）", kind: "item", price: 300, color: "#8f8", slotItem: true },
  { id: "item_cannon_slot_4", name: "炮筒4·扩容", desc: "4号炮筒模块位+1（上限16）", kind: "item", price: 300, color: "#8f8", slotItem: true },
  // v2.34 背包扩容：背包格 +1（上限 16），同价位/同出现率/同折扣规则
  { id: "item_bag_slot", name: "背包·扩容", desc: "背包格+1（上限16）", kind: "item", price: 300, color: "#fb4", slotItem: true },
  { id: "mod_speed_up", name: "模块·射速", desc: "炮筒射速模块", kind: "module", price: 100, color: "#6cf" },
  { id: "mod_damage_up", name: "模块·伤害", desc: "炮筒伤害模块", kind: "module", price: 90, color: "#f80" },
  { id: "mod_cooldown_reduce", name: "模块·冷却", desc: "炮筒冷却模块", kind: "module", price: 110, color: "#8ff" },
  { id: "mod_split_2", name: "散射·一分二", desc: "1发分裂成2发（200次）", kind: "module", price: 180, color: "#9fe" },
  { id: "mod_split_3", name: "散射·一分三", desc: "1发分裂成3发（150次）", kind: "module", price: 260, color: "#6cf" },
  { id: "mod_aim_focus", name: "方向修正", desc: "收紧散射扇形（200次）", kind: "module", price: 160, color: "#bfa" },
  { id: "mod_homing", name: "轻度追踪", desc: "投射体轻微追踪（300次）", kind: "module", price: 200, color: "#8f8" },
  { id: "proj_sniper", name: "狙击弹", desc: "高伤远射模块", kind: "module", price: 260, color: "#fb4" },
  { id: "spec_wall", name: "墙御模块", desc: "召唤防御墙", kind: "module", price: 180, color: "#9a9" },
  { id: "spec_chain_lightning", name: "连锁闪电", desc: "电击多个敌人", kind: "module", price: 420, color: "#4cf" },
  { id: "spec_black_hole_gold", name: "黑洞·金", desc: "最强召唤，吞噬一切", kind: "module", price: 600, color: "#fa5" },
];

export interface ShopStock {
  id: string;
  price: number;     // 折后价（经验）
  discount: number;  // 1 = 原价，0.5 = 五折，0.2 = 两折
}

export class BaseShop {
  /** 刷新周期（秒）/ 每批数量 / 折扣档位（1 件 2 折、1 件 5 折、其余原价） */
  readonly REFRESH_EVERY = 60;
  readonly STOCK_SIZE = 5;
  /** v2.34 炮筒扩容件：每次刷新每件独立出现概率（10%） */
  static readonly SLOT_ITEM_CHANCE = 0.1;
  /** v2.34 炮筒扩容件：出现后打折概率（50%），折扣随机 1~9 折（0.1~0.9） */
  static readonly SLOT_ITEM_DISCOUNT_CHANCE = 0.5;
  private stock: ShopStock[] = [];
  private timer = this.REFRESH_EVERY;   // 开局先立即可买一批
  /** 库存版本号（刷新即 ++；主机据此向成员广播 shopstate） */
  version = 0;
  /** 面板打开中（玩家进入基地半径触发） */
  open = false;
  /** 面板锚点（底座屏幕坐标，由模式传入以贴近基地显示） */
  anchorX = 0; anchorY = 0;
  private btnRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  /** v2.14.2 升级服务动态 price（由 GameModeCore 每帧推） */
  levelupCost: number = 40;
  /** v2.14.2 升级服务是否可买（经验足够且无 pendingLevelUp） */
  levelupEnabled: boolean = true;
  /** 提示文案（购买成功/余额不足） */
  msg = "";
  private msgTimer = 0;

  constructor() { this.replenish(); }

  /** 立即重抽一批：4 件随机（排除 levelup 与炮筒扩容件） + 1 件固定升级服务 + 扩容件（每件独立 10%）。
   *  普通折扣档位：1×0.2 / 1×0.5 / 2×1.0（随机池）；扩容件独立折扣：50% 概率、随机 1~9 折 */
  replenish(): void {
    this.version++;
    // v2.14.2 过滤掉 levelup（它是固定项，不走随机）；v2.34 扩容件不进普通池（走独立 10%/件 出现率）
    const pool = SHOP_CATALOG.filter(c => c.id !== "levelup" && !c.slotItem);
    const pick = (n: number): ShopCatalogItem[] => {
      const out: ShopCatalogItem[] = [];
      while (n-- > 0 && pool.length > 0) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      return out;
    };
    const [cheap, mid] = [pick(1)[0], pick(1)[0]];
    const normal = pick(2);
    // v2.34 炮筒扩容：每件独立 10% 出现；出现后 50% 概率打折（随机 1~9 折），不打折=原价
    const slotsStock: ShopStock[] = [];
    for (const c of SHOP_CATALOG) {
      if (!c.slotItem) continue;
      if (Math.random() >= BaseShop.SLOT_ITEM_CHANCE) continue;
      const discount = Math.random() < BaseShop.SLOT_ITEM_DISCOUNT_CHANCE
        ? 0.1 + Math.random() * 0.8   // 1~9 折
        : 1;
      slotsStock.push({ id: c.id, price: this.discountPrice(c.price, discount), discount });
    }
    // 4 随机 + 固定 levelup（动态价由 GameModeCore 每帧推）+ 扩容件（额外格，不占 4 随机位）
    this.stock = [
      ...(cheap ? [{ id: cheap.id, price: this.discountPrice(cheap.price, 0.2), discount: 0.2 }] : []),
      ...(mid ? [{ id: mid.id, price: this.discountPrice(mid.price, 0.5), discount: 0.5 }] : []),
      ...normal.map((c) => ({ id: c.id, price: c.price, discount: 1 })),
      ...slotsStock,
      { id: "levelup", price: this.levelupCost, discount: 1 },
    ];
  }

  private discountPrice(base: number, rate: number): number {
    return Math.max(5, Math.round((base * rate) / 5) * 5);
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer <= 0) { this.timer = this.REFRESH_EVERY; this.replenish(); this.msg = "货源已刷新！"; this.msgTimer = 2; }
    if (this.msgTimer > 0) this.msgTimer -= dt;
  }

  stockNow(): readonly ShopStock[] { return this.stock; }

  /** v2.26 距下次刷新的剩余秒数（小人头顶/交互面板 周期指示器用） */
  get refreshRemaining(): number { return Math.max(0, this.timer); }

  /** v2.27 刷新进度（0~1）：沙漏/进度条可视化用 */
  get refreshFraction(): number { return Math.max(0, Math.min(1, this.timer / this.REFRESH_EVERY)); }

  /** v2.14.2 消费：原子化删除一条库存（购买成功后必调）。返回 true=确实删除了 */
  consumeItem(idx: number): boolean {
    if (idx < 0 || idx >= this.stock.length) return false;
    this.stock.splice(idx, 1);
    this.version++;   // 触发联机广播；单机也保持同步
    // 删掉后如果只剩 levelup（没货了），让面板留着但只剩最后一格
    return true;
  }

  /** 触屏/鼠标点选命中 → 返回物品下标，-1=未命中 */
  tapAt(x: number, y: number): number {
    if (!this.open) return -1;
    for (let i = 0; i < this.btnRects.length; i++) {
      const b = this.btnRects[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
    }
    return -1;
  }

  /** v2.14.1 面板区域（含描边留白），点击此处之外视为关闭请求 */
  tapClose(x: number, y: number): boolean {
    if (!this.open || this.btnRects.length === 0) return false;
    const b0 = this.btnRects[0];
    const bl = this.btnRects[this.btnRects.length - 1];
    return !(x >= b0.x - 10 && x <= b0.x + b0.w + 10 && y >= b0.y - 28 && y <= bl.y + bl.h + 10);
  }

  notify(name: string, ok: boolean): void {
    this.msg = ok ? `已购买 ${name}` : `经验不足（${name}）`;
    this.msgTimer = 1.8;
  }

  render(
    renderer: { ctx: CanvasRenderingContext2D; drawText(t: string, x: number, y: number, o?: Record<string, unknown>): void },
    W: number, H: number, wallet: number,
    ownerIdx?: number,   // v2.14.2 当前面板所有者（显示在顶部标题栏）
  ): void {
    if (!this.open || this.stock.length === 0) return;
    this.btnRects = [];
    drawShopPanel({
      ctx: renderer.ctx, W, H, stock: this.stock, wallet, ownerIdx,
      msg: this.msgTimer > 0 ? this.msg : "",
      msgColor: "#9f9",
      bottom: `刷新倒计时 ${Math.ceil(this.timer)}s · 1件2折·1件5折·原价 · 点基地或按E开关`,
      bottomFraction: this.refreshFraction,   // v2.27 底部刷新进度条（沙漏条）
      onRect: (i, r) => { this.btnRects[i] = r; },
    });
  }
}

/** v2.14.1 商店面板共享渲染（主机 BaseShop 与成员 RemoteView 同一实现，防两处漂移）
 *  侧边固定布局（左侧垂直居中），折扣商品显示「原价(划线) → 现价」清晰可见。 */
export interface ShopPanelItemLike { id: string; price: number; discount: number; }
export function drawShopPanel(o: {
  ctx: CanvasRenderingContext2D;
  W: number; H: number;
  stock: readonly ShopPanelItemLike[];
  wallet: number;
  ownerIdx?: number;   // v2.14.2 当前面板使用者（P1/P2）
  msg?: string;
  msgColor?: string;
  bottom?: string;
  /** v2.27 底部刷新进度（0~1）：绘制金色沙漏条（不看数字也能一眼看出还差多少） */
  bottomFraction?: number;
  onRect?: (i: number, r: { x: number; y: number; w: number; h: number }) => void;
}): void {
  const { ctx, stock } = o;
  if (stock.length === 0) return;
  const panelW = 290;
  const rowH = 42;
  const panelH = 30 + stock.length * rowH + 20;
  // 侧边固定：左侧、垂直居中偏上（避开顶部 HUD 40px 与底部触屏控制区，不遮挡战场中心）
  const px = 10;
  const py = Math.max(58, Math.round((o.H - panelH) / 2) - 24);

  ctx.fillStyle = "rgba(4,10,22,0.95)";
  ctx.fillRect(px - 6, py - 8, panelW + 12, panelH + 12);
  ctx.strokeStyle = "#2d9"; ctx.lineWidth = 1; ctx.strokeRect(px - 6, py - 8, panelW + 12, panelH + 12);

  const t = (x: number, y: number, s: string, c = "#eee", f = "11px monospace", a: CanvasTextAlign = "left") => {
    ctx.fillStyle = c; ctx.font = f; ctx.textAlign = a; ctx.fillText(s, x, y);
  };

  const ownerTag = o.ownerIdx !== undefined ? `  [使用者: P${o.ownerIdx + 1}]` : "";
  t(px + panelW / 2, py + 8, "基 地 商 店 · 经验购买" + ownerTag, "#7f7", "bold 12px monospace", "center");
  t(px + panelW - 4, py + 8, `P${o.ownerIdx !== undefined ? o.ownerIdx + 1 : "?"}经验 ${o.wallet}`, "#9f9", "10px monospace", "right");

  stock.forEach((s, i) => {
    const c = SHOP_CATALOG.find((x) => x.id === s.id);
    if (!c) return;
    const by = py + 22 + i * rowH;
    const rect = { x: px, y: by, w: panelW, h: rowH - 4 };
    if (o.onRect) o.onRect(i, rect);

    const discounted = s.discount < 1;
    const saleCol = s.discount <= 0.2 ? "#ff5f5f" : "#ff9a3c";
    ctx.fillStyle = discounted ? "rgba(24,38,18,0.92)" : "rgba(14,20,34,0.92)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    // 第一行：编号+名称（左）+ 折扣角标 + 价格区（右，原价划线 → 现价）
    t(rect.x + 8, rect.y + 16, `${i + 1}. ${c.name}`, c.color, "bold 12px monospace");
    if (discounted) {
      // v2.34 折扣显示修正：0.2→「2折」、0.45→「4.5折」（旧版显示 "20折" 易被误读为 20 折=加价）
      const zhe = s.discount * 10;
      const zheTxt = Number.isInteger(zhe) ? `${zhe}折` : `${zhe.toFixed(1)}折`;
      t(rect.x + 8, rect.y + 31, `特价 ${zheTxt}`, saleCol, "bold 10px monospace");
      // 现价（右对齐、大号显眼）
      const saleTxt = `现价 ${s.price}`;
      t(rect.x + rect.w - 8, rect.y + 16, saleTxt, saleCol, "bold 13px monospace", "right");
      // 原价（现价左侧，灰字+划线，一眼看出省了多少）
      const origTxt = `原价 ${c.price}`;
      const sw = ctx.measureText(saleTxt).width;
      const ow = ctx.measureText(origTxt).width;
      const ox = rect.x + rect.w - 8 - sw - 12 - ow;
      t(ox, rect.y + 16, origTxt, "#8a8a8a", "bold 11px monospace");
      ctx.strokeStyle = "#ff5f5f"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ox - 1, rect.y + 13); ctx.lineTo(ox + ow + 1, rect.y + 13); ctx.stroke();
    } else {
      t(rect.x + rect.w - 8, rect.y + 16, `价格 ${s.price}`, "#ffd700", "bold 13px monospace", "right");
    }

    // 第二行：介绍（折扣商品左侧放特价标注右侧让位，非折扣则居中横铺）
    const descX = discounted ? rect.x + 86 : rect.x + 8;
    t(descX, rect.y + 31, c.desc, "#9a9a9a", "10px monospace");
    // 非折扣商品在第二行右侧补折扣位：无
    ctx.strokeStyle = discounted ? saleCol : "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  });

  const bottom = o.msg ? `${o.msg}` : (o.bottom ?? "60s 自动刷新 1件2折·1件5折·3件原价 · 点基地或按E开关");
  // v2.27 沙漏条：金色填充 = 剩余比例（随时间流逝向右缩短）
  if (typeof o.bottomFraction === "number") {
    const barW = panelW - 40, barX = px + 20, barY = py + panelH - 13;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(barX, barY, barW, 3);
    ctx.fillStyle = "#ffd700";
    ctx.fillRect(barX, barY, barW * Math.max(0, Math.min(1, o.bottomFraction)), 3);
  }
  t(px + panelW / 2, py + panelH - 4, bottom, o.msg ? (o.msgColor ?? "#9f9") : "#6a6a6a", "9px monospace", "center");
}

/** v2.14.1 打开商店提示小药丸（靠近基地但商店未开时悬浮显示，教导玩家「点基地/按E」打开） */
export function drawShopHint(ctx: CanvasRenderingContext2D, x: number, y: number, label = "按 E 或点击基地 打开商店"): void {
  const w = ctx.measureText(label).width + 16;
  ctx.fillStyle = "rgba(4,10,22,0.82)";
  ctx.fillRect(x - w / 2, y - 11, w, 18);
  ctx.strokeStyle = "#2d9"; ctx.lineWidth = 1; ctx.strokeRect(x - w / 2, y - 11, w, 18);
  ctx.fillStyle = "#9f9";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y + 3);
}

/** 提交模块提示：靠近基地时显示"提交模块"按钮，点击自动合成（3白→1蓝，3蓝+1材料→1金） */
export function drawSubmitHint(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  whiteCount: number, blueCount: number, essence: number,
): { rx: number; ry: number; rw: number; rh: number } {
  const label = "⬆ 提交模块 (G键) 自动合成";
  const w = 220, h = 40;
  const rx = x - w / 2, ry = y;
  // 背景
  ctx.fillStyle = "rgba(4,10,22,0.9)";
  ctx.fillRect(rx, ry, w, h);
  ctx.strokeStyle = "#fa0"; ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, w, h);
  // 文字
  ctx.fillStyle = "#fa0"; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
  ctx.fillText(label, x, ry + 17);
  // 数量信息
  ctx.fillStyle = "#ddd"; ctx.font = "11px monospace";
  ctx.fillText(`白${whiteCount} 蓝${blueCount} 材料${essence}`, x, ry + 33);
  return { rx, ry, rw: w, rh: h };
}

export function shopItemOf(id: string): ShopCatalogItem | undefined {
  return SHOP_CATALOG.find((x) => x.id === id);
}