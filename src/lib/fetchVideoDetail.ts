import { getAvailableApiSites } from '@/lib/config';
import { SearchResult } from '@/lib/types';

import { getDetailFromApi, searchFromApi } from './downstream';

interface FetchVideoDetailOptions {
  source: string;
  id: string;
  fallbackTitle?: string;
}

type ApiSite = Awaited<ReturnType<typeof getAvailableApiSites>>[number];

/**
 * 单个采集源搜索的超时时间。
 * 部分采集源会连接挂死（实测有一个源单次搜索卡了 70 秒，另有源直接 fetch failed），
 * 这里必须自己兜一层超时，否则一个坏源就能把整个 cron 任务拖住。
 * 与 /api/search 的做法保持一致（那边 20s），这里取更保守的 15s。
 */
const SEARCH_TIMEOUT_MS = 15000;

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 把中文数字串转成阿拉伯数字（支持 1-99，覆盖「第一季」「十二」这类写法）。 */
function cnToArabicSegment(segment: string): string {
  if (segment === '十') {
    return '10';
  }

  if (!segment.includes('十')) {
    return segment
      .split('')
      .map((c) => (c in CN_DIGITS ? String(CN_DIGITS[c]) : c))
      .join('');
  }

  const [head, tail] = segment.split('十');
  const tens = head ? String(CN_DIGITS[head] ?? head) : '1';
  const ones = tail ? String(CN_DIGITS[tail] ?? tail) : '0';
  return `${tens}${ones}`;
}

/**
 * 标题归一化，用于跨源匹配。
 * 统一中文数字（第四季 → 第4季）、去掉空白与常见中英文标点、忽略大小写。
 */
function normalizeTitle(title: string): string {
  return title
    .replace(/[零一二两三四五六七八九十]+/g, (m) => cnToArabicSegment(m))
    .replace(
      /[\s\u3000·・:：;；,，.。!！?？"'“”‘’()（）[\]【】{}｛｝《》<>、\-—_~～|/\\&+#]/g,
      ''
    )
    .toLowerCase();
}

const stripDigits = (s: string) => s.replace(/[0-9]/g, '');

/** 带超时的单源搜索：超时或失败都返回空数组，不打断整体兜底流程。 */
async function searchFromApiSafely(
  apiSite: ApiSite,
  query: string
): Promise<SearchResult[]> {
  try {
    return await Promise.race([
      searchFromApi(apiSite, query),
      new Promise<SearchResult[]>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${apiSite.name} 搜索超时`)),
          SEARCH_TIMEOUT_MS
        )
      ),
    ]);
  } catch {
    return [];
  }
}

/**
 * 并行搜索全部可用源，返回结果数组与传入的 apiSites 顺序严格对齐。
 *
 * 之所以并行：串行搜索 27 个源时，只要有一个源挂死，单个片名就要等上数十秒，
 * 29 个收藏累积下来能把一次 cron 跑成十几分钟（实测确实如此）。并行后单次搜索的
 * 耗时上限由「各源耗时之和」降为「最慢单源（且被 15s 超时兜住）」。
 * 这与 /api/search 的既有做法一致。
 */
async function searchAllSites(
  apiSites: ApiSite[],
  query: string
): Promise<SearchResult[][]> {
  return Promise.all(apiSites.map((site) => searchFromApiSafely(site, query)));
}

/** 在按源优先级排列的结果里，找出第一个标题归一化后等于 target 的影片。 */
function pickByTitle(
  resultsBySite: SearchResult[][],
  target: string,
  transform: (s: string) => string = (s) => s
): SearchResult | null {
  for (const results of resultsBySite) {
    const hit = results.find(
      (item: SearchResult) => transform(normalizeTitle(item.title)) === target
    );
    if (hit) {
      return hit;
    }
  }
  return null;
}

/**
 * 根据 source 与 id 获取视频详情。
 * - 若 source 是真实可用的 API 站点：先用 fallbackTitle 搜索精确匹配（命中即返回），
 *   否则按 id 调用 /api/detail。
 * - 若 source 是合成来源（如详情页收藏写入的 `title_based`）：用 fallbackTitle 在所有可用源中
 *   跨源搜索标题匹配的影片；未提供 fallbackTitle 或都未命中时抛错。
 */
export async function fetchVideoDetail({
  source,
  id,
  fallbackTitle = '',
}: FetchVideoDetailOptions): Promise<SearchResult> {
  const apiSites = await getAvailableApiSites();
  const apiSite = apiSites.find((site) => site.key === source);

  // 真实存在的 API 来源：沿用原有逻辑——先用 fallbackTitle 在所有结果里精确匹配
  // source+id，命中即返回；否则回退到按 id 拉取详情，拿不到则抛错。行为保持不变。
  if (apiSite) {
    if (fallbackTitle) {
      try {
        const searchData = await searchFromApiSafely(apiSite, fallbackTitle.trim());
        const exactMatch = searchData.find(
          (item: SearchResult) =>
            item.source.toString() === source.toString() &&
            item.id.toString() === id.toString()
        );
        if (exactMatch) {
          return exactMatch;
        }
      } catch (error) {
        // do nothing
      }
    }

    const detail = await getDetailFromApi(apiSite, id);
    if (!detail) {
      throw new Error('获取视频详情失败');
    }

    return detail;
  }

  // 合成来源（如详情页收藏时写入的 `title_based`）：它不属于任何可用 API 站点，
  // 因此无法用 source+id 直接拉取详情。这里利用收藏时一并存入的 fallbackTitle（影片名），
  // 在所有可用源中搜索标题匹配的影片，从而把 `title_based+片名` 这类合成 key
  // 解析成真实详情，而不必迁移线上的收藏 key。
  const title = fallbackTitle.trim();
  if (!title) {
    // 没有可用标题兜底时，维持原有契约：直接抛错。
    throw new Error('无效的API来源');
  }

  const normalizedTitle = normalizeTitle(title);
  // 「第N季」这类季度标记：带标记的片名不允许在第二轮做「去数字」模糊匹配，
  // 否则容易把第 4 季的元数据刷到第 5 季上。
  const hasSeasonMarker = /第[0-9]+季/.test(normalizedTitle);

  // 第一轮：用原标题搜索，按归一化标题比对（可容忍空格、标点、中文数字差异，
  // 例如「全职高手 第一季」↔「全职高手第一季」、「斗破苍穹 第4季」↔「斗破苍穹第四季」）。
  const firstPass = await searchAllSites(apiSites, title);
  const firstHit = pickByTitle(firstPass, normalizedTitle);
  if (firstHit) {
    return firstHit;
  }

  // 第二轮：形如「秦时明月1之百步飞剑」的片名，源站常写作「秦时明月之百步飞剑」——
  // 比原名少一个数字（实测这是线上收藏刷新失败的主因）。此时去掉所有数字再搜一次，
  // 并按去数字后的标题比对。
  if (!hasSeasonMarker) {
    const strippedTitle = stripDigits(title);
    const strippedNormalized = stripDigits(normalizedTitle);
    if (strippedTitle && strippedTitle !== title && strippedNormalized) {
      const secondPass = await searchAllSites(apiSites, strippedTitle);
      const secondHit = pickByTitle(secondPass, strippedNormalized, stripDigits);
      if (secondHit) {
        return secondHit;
      }
    }
  }

  throw new Error('未在任何可用源中找到匹配的影片');
}
