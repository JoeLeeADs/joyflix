'use client';

export interface BangumiCalendarData {
  weekday: {
    en: string;
  };
  items: {
    id: number;
    name: string;
    name_cn: string;
    rating: {
      score: number;
    };
    air_date: string;
    images: {
      large: string;
      common: string;
      medium: string;
      small: string;
      grid: string;
    };
  }[];
}

/**
 * bgm.tv 每日放送日历。
 *
 * 重要：这个域名在国内网络环境下被 DNS 污染（实测默认 DNS / 223.5.5.5 /
 * 119.29.29.29 / 8.8.8.8 会返回四个互不相同的假 IP，IPv6 甚至返回 Facebook
 * 的地址段），直连会一直挂在 TCP 握手上而不报错。
 *
 * 因此这里必须做到两件事，缺一不可：
 * 1. 显式超时 —— 否则 fetch 永不 settle；
 * 2. 永不抛错、失败返回空数组 —— 否则会把调用方的 await 一起拖死。
 *
 * 历史事故：首页把本函数放进 Promise.all 且没有任何超时，导致国内网络下整个
 * 首页的 loading 永远为 true，所有板块无限显示骨架屏。
 */
const BANGUMI_CALENDAR_URL = 'https://api.bgm.tv/calendar';
const BANGUMI_TIMEOUT_MS = 8000;

export async function GetBangumiCalendarData(): Promise<BangumiCalendarData[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BANGUMI_TIMEOUT_MS);

  try {
    const response = await fetch(BANGUMI_CALENDAR_URL, {
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[bangumi] 日历接口返回 ${response.status}，本次跳过每日放送`);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn(
      '[bangumi] 无法获取每日放送数据（网络不可达或超时），已降级跳过：',
      (error as Error).message
    );
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}
