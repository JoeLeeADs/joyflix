/* eslint-disable no-console */

import { db } from './db';

/**
 * 定时任务（/api/cron）互斥锁。
 *
 * 背景：`start.js` 开机后会立即触发一次全量刷新，之后每小时一次；而
 * `/api/cron` 同时在鉴权豁免名单里，任何能访问站点的人都可以手动触发。
 * 单次刷新要遍历所有用户、并发访问大量采集源（实测 2~4 分钟），
 * 两次并发会让采集源负载翻倍、也可能把同一部剧的元数据互相覆盖。
 *
 * 这里用存储层的原子操作做一把带自动过期的锁：
 * - 加锁 `SET key token NX EX ttl`（原子，谁先到谁拿）
 * - 解锁 `GET == token` 再 `DEL`（仅持有者可解，Lua 保证原子）
 * - ttl 远大于单次任务耗时，又小于调度周期（1 小时），
 *   进程被 kill 等异常退出时最多影响一次调度，不会永久卡死
 */

// 锁的键名
export const CRON_LOCK_KEY = 'joyflix:cron:lock';

// 锁的自动过期时间（秒）：30 分钟
export const CRON_LOCK_TTL_SECONDS = 30 * 60;

export interface CronLockHandle {
  /** 本次是否真的拿到了锁 */
  acquired: boolean;
  /** 存储后端是否支持加锁（localstorage 模式不支持） */
  supported: boolean;
  key: string;
  token: string;
}

function createToken(): string {
  return `${Date.now()}-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * 尝试获取定时任务锁。
 * 存储后端异常时 fail-open（不加锁继续执行），避免因为锁本身让定时任务彻底停摆。
 */
export async function acquireCronLock(
  key: string = CRON_LOCK_KEY,
  ttlSeconds: number = CRON_LOCK_TTL_SECONDS
): Promise<CronLockHandle> {
  const token = createToken();
  const handle: CronLockHandle = {
    acquired: false,
    supported: true,
    key,
    token,
  };

  try {
    handle.acquired = await db.acquireLock(key, token, ttlSeconds);
  } catch (err) {
    console.error('获取 cron 锁失败，本次不加锁执行:', err);
    handle.supported = false;
    handle.acquired = true;
  }

  return handle;
}

/** 释放定时任务锁，仅持有者可释放 */
export async function releaseCronLock(handle: CronLockHandle): Promise<void> {
  if (!handle.supported || !handle.acquired) return;

  try {
    const released = await db.releaseLock(handle.key, handle.token);
    if (!released) {
      console.warn('释放 cron 锁未生效（锁可能已被自动过期）:', handle.key);
    }
  } catch (err) {
    console.error('释放 cron 锁异常:', err);
  }
}
