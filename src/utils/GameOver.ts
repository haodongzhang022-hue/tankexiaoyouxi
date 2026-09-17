import type { Tank } from "../game/Tank";

/**
 * 队伍是否被淘汰：
 *  - 所有玩家【同时都既不存活也没有剩余命数】才算淘汰；
 *  - 只要还有任何一个玩家有命可复活（或正在复活中），就不算淘汰。
 */
export function isTeamEliminated(players: Tank[]): boolean {
  return !players.some(p => p.isAlive || p.lives > 0);
}
