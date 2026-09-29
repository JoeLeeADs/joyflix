import { getAvailableApiSites } from '@/lib/config';
import { SearchResult } from '@/lib/types';

import { getDetailFromApi, searchFromApi } from './downstream';

interface FetchVideoDetailOptions {
  source: string;
  id: string;
  fallbackTitle?: string;
}

/**
 * 根据 source 与 id 获取视频详情。
 * - 若 source 是真实可用的 API 站点：先用 fallbackTitle 搜索精确匹配（命中即返回），
 *   否则按 id 调用 /api/detail。
 * - 若 source 是合成来源（如详情页收藏写入的 `title_based`）：用 fallbackTitle 在所有可用源中
 *   跨源搜索首个标题精确匹配的影片；未提供 fallbackTitle 或都未命中时抛错。
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
        const searchData = await searchFromApi(apiSite, fallbackTitle.trim());
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
  // 在所有可用源中逐个搜索，返回首个标题精确匹配的影片，从而把 `title_based+片名`
  // 这类合成 key 解析成真实详情，而不必迁移线上的收藏 key。
  const title = fallbackTitle.trim();
  if (!title) {
    // 没有可用标题兜底时，维持原有契约：直接抛错。
    throw new Error('无效的API来源');
  }

  for (const site of apiSites) {
    try {
      const searchData = await searchFromApi(site, title);
      const titleMatch = searchData.find(
        (item: SearchResult) => item.title.trim() === title
      );
      if (titleMatch) {
        return titleMatch;
      }
    } catch (error) {
      // 单个源搜索失败或超时不应中断整体兜底流程
      // do nothing
    }
  }

  throw new Error('未在任何可用源中找到匹配的影片');
}
