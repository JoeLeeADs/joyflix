import { NextResponse } from 'next/server';
import { getUpstashRedisClient } from '@/lib/upstash.db';

const RECOMMENDATIONS_KEY = 'recommendations:movie_titles_cache';
const LAST_UPDATED_KEY = 'recommendations:last_updated';
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天（毫秒）

export const dynamic = 'force-dynamic';

export async function GET() {
  console.log('API 路由已命中！'); // 早期日志

  // Upstash 客户端是可选的：未配置 UPSTASH_URL / UPSTASH_TOKEN 时跳过缓存层，
  // 改为实时计算推荐列表，避免 getUpstashRedisClient() 抛出的异常绕过本路由
  // 自身的错误处理而返回 500。
  let client: ReturnType<typeof getUpstashRedisClient> | null = null;
  try {
    client = getUpstashRedisClient();
  } catch (error) {
    console.warn('未配置 Upstash 客户端，将跳过缓存层直接实时计算推荐:', error);
  }

  // 内部 fetch 路径：从豆瓣分类接口获取热门电影标题
  const fetchUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/douban/categories?kind=movie&category=热门&type=全部&limit=50`;

  try {
    let recommendedMovies: string[] = [];

    if (!client) {
      // 无缓存层：直接实时拉取豆瓣热门电影标题
      console.log(`无 Upstash 客户端，实时从内部接口获取数据: ${fetchUrl}`);
      const response = await fetch(fetchUrl);

      if (!response.ok) {
        console.error(`豆瓣 API 响应不正常: ${response.status} ${response.statusText}`);
        throw new Error(`Failed to fetch from Douban API: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('从豆瓣 API 接收到数据:', data);
      const allMovies: { title: string; id: string }[] = data.list || [];
      recommendedMovies = Array.from(new Set(allMovies.map((movie) => movie.title)));
      console.log('已实时获取推荐电影:', recommendedMovies.length);
    } else {
      // ---- 以下为保留的缓存逻辑（client 可用时）----
      console.log('尝试从 Upstash 获取 LAST_UPDATED_KEY...');
      const lastUpdatedStr = await client.get(LAST_UPDATED_KEY);
      console.log(`已获取 LAST_UPDATED_KEY: ${lastUpdatedStr}`);
      const lastUpdated = Number(lastUpdatedStr) || 0;
      const now = Date.now();

      console.log(`当前时间: ${new Date(now).toISOString()}`);
      console.log(`最后更新时间: ${lastUpdated ? new Date(lastUpdated).toISOString() : '从不'}`);
      console.log(`刷新间隔: ${REFRESH_INTERVAL_MS / (1000 * 60 * 60 * 24)} 天`);

      // 检查是否需要刷新
      if (!lastUpdated || (now - lastUpdated > REFRESH_INTERVAL_MS)) {
        console.log('需要刷新。尝试刷新缓存...');
        console.log(`正在从: ${fetchUrl} 获取数据`);
        try {
          // 从原始豆瓣 API 获取
          const response = await fetch(fetchUrl);

          if (!response.ok) {
            console.error(`豆瓣 API 响应不正常: ${response.status} ${response.statusText}`);
            throw new Error(`Failed to fetch from Douban API: ${response.statusText}`);
          }

          const data = await response.json();
          console.log('从豆瓣 API 接收到数据:', data);
          const allMovies: { title: string; id: string }[] = data.list || [];

          // 提取标题并去重
          const uniqueTitles = Array.from(new Set(allMovies.map((movie) => movie.title)));
          console.log('已提取唯一标题:', uniqueTitles.length);

          // 存储到 Upstash
          const moviesJson = JSON.stringify(uniqueTitles);
          console.log(`尝试存储 RECOMMENDED_MOVIES_KEY。大小: ${moviesJson.length} 字符。`);
          // --- 测试将简化版电影数据存储为逗号分隔的字符串 ---
          const simplifiedMoviesCsv = uniqueTitles.slice(0, 50).join(','); // 仅存储前 50 个标题作为 CSV
          console.log(`尝试将 RECOMMENDED_MOVIES_KEY 存储为 CSV。大小: ${simplifiedMoviesCsv.length} 字符。`);
          await client.set(RECOMMENDATIONS_KEY, simplifiedMoviesCsv); // 使用简化数据作为实际键
          // --- 测试结束 ---
          console.log('已将推荐电影存储到 Upstash。');
          const verifyRecommendedMovies = await client.get(RECOMMENDATIONS_KEY);
          console.log(`已验证 Upstash 中的推荐电影（前 100 个字符）: ${typeof verifyRecommendedMovies === 'string' ? verifyRecommendedMovies.substring(0, 100) + '...' : '空或无'}`);

          await client.set(LAST_UPDATED_KEY, now);
          console.log('已将最后更新时间戳存储到 Upstash。');
          const verifyLastUpdated = await client.get(LAST_UPDATED_KEY);
          console.log(`已验证 Upstash 中的最后更新时间: ${verifyLastUpdated}`);
          recommendedMovies = uniqueTitles;
          console.log('推荐电影缓存已刷新并存储到 Upstash。');
        } catch (error) {
          console.error('刷新推荐电影缓存时出错:', error);
          // 如果刷新失败，尝试从现有缓存加载
          const cachedMoviesStr = await client.get(RECOMMENDATIONS_KEY);
          if (cachedMoviesStr) {
            recommendedMovies = typeof cachedMoviesStr === 'string' ? cachedMoviesStr.split(',') : [];
            console.log('由于刷新失败，已从现有缓存加载推荐电影。');
          } else {
            console.log('刷新失败后未找到现有缓存。');
          }
        }
      } else {
        console.log('缓存是新的。正在从 Upstash 缓存加载...');
        // 从缓存加载
        const cachedMoviesStr = await client.get(RECOMMENDATIONS_KEY);
        console.log(`已获取 RECOMMENDED_MOVIES_KEY: ${typeof cachedMoviesStr === 'string' ? cachedMoviesStr.substring(0, 100) + '...' : '空或无'}`); // 记录前 100 个字符
        if (cachedMoviesStr) {
          recommendedMovies = typeof cachedMoviesStr === 'string' ? cachedMoviesStr.split(',') : [];
          console.log('已从 Upstash 缓存加载推荐电影。');
          console.log(`解析后的 recommendedMovies 长度: ${recommendedMovies.length}`);
        } else {
          console.log('缓存中未找到推荐电影，尝试刷新...');
          // 这种情况理想情况下应该由上面的刷新逻辑处理，
          // 但作为备用，如果缓存为空且未到刷新时间，则强制刷新。
          // 这可能发生在首次运行或缓存被手动清除时。
          // 为避免无限循环，我们现在只返回空，让下一次请求触发刷新。
          // 或者，我们可以递归调用 GET，但这有风险。
          // 为简单起见，如果缓存为空且未到刷新时间，我们只返回空。
          // 下一个请求在 REFRESH_INTERVAL_MS 之后将触发刷新。
        }
      }
    }

    // 打乱并获取 6 个随机推荐
    const shuffled = recommendedMovies.sort(() => 0.5 - Math.random());
    const selectedRecommendations = shuffled.slice(0, 6);

    return NextResponse.json({ list: selectedRecommendations });
  } catch (error) {
    console.error('推荐 API 中出错:', error);
    return NextResponse.json({ list: [] }, { status: 500 });
  }
}
