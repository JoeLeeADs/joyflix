import { NextResponse } from 'next/server';

export const runtime = 'edge';

/**
 * 出栈取图的超时与重试。
 *
 * 为什么需要：
 * 1. 原先这里是裸 fetch，**没有超时** —— 一旦豆瓣图床的连接挂住，这个请求会一直悬着，
 *    前端表现就是"这张封面永远在加载"，和我们刚修掉的首页骨架屏是同一类隐患。
 * 2. 实测封面代理存在约 2% 的**偶发失败**（同一张图下一轮又能成功），
 *    属于连接被重置一类的瞬时错误，重试一次基本都能救回来。
 *
 * 注意：上游返回 4xx 属于确定性失败（图不存在/被拒），重试没有意义，直接透传。
 */
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const IMAGE_FETCH_ATTEMPTS = 2;

// OrionTV 兼容接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  let lastError = 'Error fetching image';

  for (let attempt = 1; attempt <= IMAGE_FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      IMAGE_FETCH_TIMEOUT_MS
    );

    try {
      const imageResponse = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          Referer: 'https://movie.douban.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
      });

      // 成功路径：先清掉定时器再返回，避免响应体还在流式返回时被中断。
      clearTimeout(timeoutId);

      if (!imageResponse.ok) {
        // 4xx 是确定性失败，重试无意义
        if (imageResponse.status < 500) {
          return NextResponse.json(
            { error: imageResponse.statusText },
            { status: imageResponse.status }
          );
        }
        lastError = imageResponse.statusText || `HTTP ${imageResponse.status}`;
        continue;
      }

      const contentType = imageResponse.headers.get('content-type');

      if (!imageResponse.body) {
        lastError = 'Image response has no body';
        continue;
      }

      // 创建响应头
      const headers = new Headers();
      if (contentType) {
        headers.set('Content-Type', contentType);
      }

      // 设置缓存头（可选）
      headers.set(
        'Cache-Control',
        'public, max-age=15720000, s-maxage=15720000'
      ); // 缓存半年
      headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');
      headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');
      headers.set('Netlify-Vary', 'query');

      // 直接返回图片流
      return new Response(imageResponse.body, {
        status: 200,
        headers,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      lastError =
        (error as Error)?.name === 'AbortError'
          ? `取图超时（${IMAGE_FETCH_TIMEOUT_MS}ms）`
          : (error as Error).message || 'Error fetching image';
      console.warn(
        `[image-proxy] 第 ${attempt}/${IMAGE_FETCH_ATTEMPTS} 次取图失败：${imageUrl} —— ${lastError}`
      );
    }
  }

  return NextResponse.json(
    { error: 'Error fetching image', details: lastError },
    { status: 502 }
  );
}
