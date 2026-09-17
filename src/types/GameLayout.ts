// GameLayout.ts - shared layout type
// canvasW/H = 整块画布尺寸（含侧边信息栏）；infoW/infoH = 信息栏尺寸
// 场地(世界地图)始终占画布左上角 mapCols*TILE x mapRows*TILE 区域
export interface GameLayout {
  canvasW: number;
  canvasH: number;
  mapCols: number;
  mapRows: number;
  /** 右侧信息栏宽度（竖屏为 0） */
  infoW: number;
  /** 底部信息栏高度（横屏为 0） */
  infoH: number;
}
