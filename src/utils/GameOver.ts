import type { Tank } from "../game/Tank";

/**
 * 队伍是否被淘汰：
 *  - 所有玩家【同时都既不存活也没有剩余命数】才算淘汰；
 *  - 只要还有任何一个玩家有命可复活（或正在复活中），就不算淘汰。
 */
export function isTeamEliminated(players: Tank[]): boolean {
  return !players.some(p => p.isAlive || p.lives > 0);
}

/**
 * v3.0.4 联机对局的淘汰判据：只看**本地有人操作**的席位。
 *
 * 为什么不能直接复用上面那个（3/4 人局的实际 bug）：
 *   `isTeamEliminated` 问的是"队伍是否被淘汰" —— 单机语义下没错（P2 由 AI 或本地键位接管，
 *   总要等所有人）。但联机房间支持 4 个席位，主机侧会给 AI 席位留命、也会给远端真人留命，
 *   于是"全员阵亡"变成**永远不成立**：只要 3/4 号 AI 还有一条命，P1 死光了也算输不了，
 *   对局会一直挂着。玩家感知就是"我死了但游戏不结束"。
 *
 * 现在的判据：**由人操作的席位**（P1 房主 + 远端成员操作的那几个；`remoteSeats` 传玩家索引，
 * 主机固定含 0）全部"既不在场也没命可复活"时，本局才结束。AI 席位（含 P2 由 AI 接管）不参与
 * 判定 —— 它们随玩家一起阵亡，不该替玩家续命。
 *
 * @param players      全部战斗席位（索引 = 玩家索引）
 * @param remoteSeats  由**真人**操作的席位索引（默认 [0]）
 */
export function isAllHumanPlayersDead(players: Tank[], remoteSeats: readonly number[] = [0]): boolean {
  const humans = remoteSeats.filter(i => i >= 0 && i < players.length);
  if (humans.length === 0) return isTeamEliminated(players);   // 兜底：没人操作时退回原判据
  return !humans.some(i => players[i].isAlive || players[i].lives > 0);
}
