// SnapshotCleanupService — 过期快照清理器（v12 快照机制）
// 功能：后台周期性物理清理已过期的快照（软删除记录）
//       deleted_until < now 的灵感：数据库级联清理 + 删除灵感目录
// 实现方式：
//   1. start()：启动后延迟 30s 执行一次 purgeOnce()，之后每 24h setInterval 循环
//   2. purgeOnce()：调用 Inspiration.purgeExpired() 取过期 ID 列表 → 逐个 removeStorage 删目录
//   3. stop()：清理 setTimeout + setInterval（配合 SIGINT/SIGTERM 优雅退出）
//
// 关键约束：
//   - 只清理 deleted_until 已过期的记录（默认保留期 30 天，见 softDelete）
//   - 清理幂等：无过期快照时无操作；目录删除失败仅告警不中断
//   - 不阻塞启动：首次清理延迟 30s，避开启动峰值

import { Inspiration } from '../models/Inspiration.js';
import inspirationStorage from '../services/inspirationStorage.js';

// 清理周期：每 24 小时检查一次
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 启动后延迟首次清理的毫秒数（避开启动峰值）
const STARTUP_DELAY_MS = 30 * 1000;

let timer = null;
let started = false;

/**
 * 执行一次过期快照清理
 * 功能：找出 deleted_until 已过期的软删除记录，物理删除数据库记录与灵感目录
 * 实现方式：purgeExpired 返回过期 ID 列表 → 逐个 removeStorage（try/catch 不阻塞）
 * @returns {Promise<number>} 本次清理的快照数量
 */
async function purgeOnce() {
  try {
    const expiredIds = Inspiration.purgeExpired();
    if (expiredIds.length === 0) return 0;
    // 删除灵感目录（尽力而为，失败仅告警）
    for (const id of expiredIds) {
      try {
        await inspirationStorage.removeStorage(id);
      } catch (err) {
        console.warn(`[SnapshotCleanup] Failed to remove storage for ${id}:`, err.message);
      }
    }
    console.log(`[SnapshotCleanup] Purged ${expiredIds.length} expired snapshot(s)`);
    return expiredIds.length;
  } catch (err) {
    // 清理失败不中断周期（下次继续尝试）
    console.error('[SnapshotCleanup] purgeOnce failed:', err.message);
    return 0;
  }
}

/**
 * 启动快照清理周期
 * 功能：延迟 30s 执行首次清理，之后每 24h 循环
 * 实现方式：setTimeout 首跑 → 内部 setInterval 周期化（幂等：重复 start 不叠加定时器）
 */
export function startSnapshotCleanup() {
  if (started) return;
  started = true;
  setTimeout(() => {
    purgeOnce();
    timer = setInterval(purgeOnce, CLEANUP_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
  console.log('[SnapshotCleanup] scheduler started (first run in 30s, then every 24h)');
}

/**
 * 停止清理周期（优雅退出用）
 * 功能：清理 setTimeout + setInterval，避免句柄泄漏
 */
export function stopSnapshotCleanup() {
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
