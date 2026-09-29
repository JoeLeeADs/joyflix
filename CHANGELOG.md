# Changelog

本仓库是 [jeffernn/joyflix](https://github.com/jeffernn/joyflix) 的个人优化分支，在其基础上进行安全修复、工程化补强与部署优化。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 其余 15 项待办优化（完整清单见 `.workbuddy/optimization-review.md`），按「需设计改造 → 结构性重构」分两批推进。
  重点包括：Redis / Upstash 后端中的用户密码为明文存储、登录 Cookie 未设置 `httpOnly` / `secure`、
  29 个 API 路由中有 18 个缺少自建鉴权、`/api/image-proxy` 与 `/api/admin/test-proxy` 存在 SSRF、
  以及 `Dockerfile` 依赖 `sed` 改写源码且失配时不报错。

## [0.2.1] - 2026-09-29

本版聚焦**用户可感知的功能故障**：首页豆瓣封面全部裂图、收藏定时刷新全部失败、搜索推荐接口必然 500。
三项均为静默失效——不报错、不告警，只在界面上表现为「图片空白」或「数量对不上」。

### 修复

- **首页豆瓣封面全部裂图（主要）** `src/app/layout.tsx`、`src/lib/config.ts`、`.env.example`
  *现象*：首页「继续观看」封面正常，但下方「热门电影 / 热门剧集 / 热门综艺 / 热门番剧 / 更多热门」全部只剩灰色骨架。
  *根因*：豆瓣图床 `imgN.doubanio.com` 按 Referer 白名单拦截。服务器实测同一张海报：
  无 Referer → **418**，`https://movie.douban.com/` → **200**，站点自身域名 → **403**（img1 / img3 均 403）。
  而 `src/components/VideoCard.tsx:389` 写死了 `referrerPolicy='no-referrer'`，
  叠加默认图片代理方式 `img3`——它在 `src/lib/utils.ts:44` **只改写域名**为 `img3.doubanio.com`，
  **仍由浏览器直连豆瓣**——于是所有豆瓣封面被统一 418 拒绝。
  「继续观看」之所以正常，是因为它的封面来自播放记录里的采集站图床（非 doubanio 域名），
  `processImageUrl` 在 `utils.ts:36` 直接原样放行；两条行用的是**同一个 VideoCard 组件**，
  差异仅在海报 URL 的宿主域名。
  *修复*：默认值 `img3` → `server`（`src/app/layout.tsx:59` 及 `src/lib/config.ts` 181 / 227 / 282 / 415 共 5 处），
  让豆瓣图片改走 `/api/image-proxy`，由服务端带上 `Referer: https://movie.douban.com/`
  （`src/app/api/image-proxy/route.ts:17`）。`.env.example` 中「海报异常可改为 direct」的提示是错的，
  已更正并说明 `direct` / `img3` 同样会 418。
  *部署注意*：存量部署的 `SiteConfig.DoubanImageProxyType` 存放在 Redis `admin:config`，
  且**优先于**环境变量与代码默认值（`src/lib/config.ts:96` 走保留分支）；
  改完必须**重启容器**才生效（`src/lib/config.ts:52` 的 `initConfig()` 有 `if (cachedConfig) return;` 进程内缓存）。

- **搜索页推荐接口必然 500** `src/app/api/recommendations/route.ts`
  `getUpstashRedisClient()` 原本在 `try` **之外**调用。未配置 `UPSTASH_URL` / `UPSTASH_TOKEN` 时
  （即 redis / localstorage 模式）它直接抛异常，异常绕过本路由自身的错误处理，
  返回未经捕获的 500。现改为 **Upstash 客户端可选**：创建失败则跳过缓存层、实时拉取并正常返回 200；
  客户端可用时缓存行为完全不变。
  顺带修复同文件 `typeof lastUpdatedStr === 'number'` 恒为假的问题（Redis 返回字符串），
  该判断使 7 天缓存窗口实际从未生效、每次请求都触发刷新；改为 `Number(lastUpdatedStr) || 0`。

- **定时任务收藏刷新全部失败** `src/lib/fetchVideoDetail.ts`
  *现象*：`收藏处理完成: 0/29`，日志中 `无效的API来源` 累计 87 次（3 次 cron × 29 个收藏）。
  *根因*：详情页收藏时来源被写成**合成来源** `title_based`（`src/app/detail/page.tsx:441`），
  收藏键形如 `title_based+<片名>`，而它不属于任何真实 API 源。
  `fetchVideoDetail` 仅用 `source` 在可用源列表中查找，找不到即抛 `无效的API来源`，
  **在到达「按标题搜索」的回退路径之前就已失败**。
  *修复*：当 `source` 不是真实 API 源但提供了 `fallbackTitle` 时，改为在所有可用源中逐个按标题精确匹配
  （命中即返回，单源失败/超时不影响其它源）；全部未命中才抛 `未在任何可用源中找到匹配的影片`。
  未提供 `fallbackTitle` 时保持原契约抛 `无效的API来源`。
  *不改动数据*：cron 回写使用同一 `source`/`id`（`src/app/api/cron/route.ts:158`），`title_based+片名` 键被完整保留，无需迁移。
  *附带说明*：自托管下 cron 由 `start.js` 的 `setInterval` **每小时**触发一次，
  `vercel.json` 里的 `0 1 * * *` 仅在 Vercel 生效。

### 验证

- `pnpm typecheck`（`tsc --noEmit --incremental false`）：EXIT=0
- `pnpm run build`（Next.js 14.2.30）：EXIT=0，`joyflix@0.2.1`
- 全仓库已无 `|| 'img3'` 回退残留

## [0.2.0] - 2026-09-29

首个优化版本。核心是**修复鉴权中间件完全失效**这一严重安全问题，并补齐此前完全缺失的工程基建。

### 修复

- **鉴权中间件从未生效（严重）** `src/middleware.ts`
  matcher 正则多了一个右括号，Next.js 把它编译成字面量 `)`，导致所有真实路径都不匹配。
  中间件自部署起从未执行，需要登录的页面与 API 实际处于无保护状态。该问题不报错、不告警，属静默失效。
  修复为删除多余括号使正则括号配平（2/2）。
  *验证方式*：用真实 `next build` 产物 `.next/server/middleware-manifest.json` 确认生成的正则中不再含字面量 `\)`。
  *行为变更*：修复后鉴权才真正生效——未登录访问会跳转登录页；未配置 `PASSWORD` 会跳 `/warning`。

- **定时任务丢失异常与完成状态** `src/app/api/cron/route.ts`
  调用刷新函数时缺少 `await`，接口在任务实际完成前就返回成功，任务内部抛出的异常也会被静默吞掉。

- **监听器永久泄漏** `src/components/CustomSelect.tsx`
  注销监听器时事件名写成 `mousedown`，而注册时用的是 `click`，清理函数成为空操作。
  该泄漏在生产环境同样存在，长期使用会持续累积。

- **严格模式下菜单项重复插入** `src/components/Sidebar.tsx`、`src/components/MobileBottomNav.tsx`
  追加「更多」入口时未做去重，React 严格模式下 effect 双跑会插入两条相同的菜单项。

- **改写父组件传入的 props** `src/components/EpisodeSelector.tsx`
  直接对父组件传入的数组就地 `sort()`，改为先复制再排序，避免跨组件的意外副作用。

### 新增

- **`.gitignore`** 此前仓库完全没有此文件，`git add .` 会把 `node_modules/`、`.next/`、`.env*` 一并提交。
  覆盖依赖、构建产物、环境变量，以及构建时生成的 `src/lib/runtime.ts`、`public/manifest.json`、`public/sw.js`。
- **`.env.example`** 环境变量清单从源码实际抽取。顶部注明 **`NEXT_PUBLIC_*` 是构建期内联**：
  已实测注入唯一标记后构建，该标记出现在 `.next/server/app/api/recommendations/route.js` 中，
  因此 Docker 运行时通过 `-e NEXT_PUBLIC_XXX=...` 传入**不生效**，站点级配置需走 `config.json` 或管理后台。
- **`.dockerignore`** 排除 `node_modules` 等，避免宿主机（macOS / arm64）的依赖被 `COPY . .` 覆盖进 Linux 镜像。
- **`deploy/docker-compose.example.yml`** 服务器部署编排模板，纳入版本管理。

### 变更

- **`next.config.js`** 打开 `reactStrictMode`（此前为 `false`）。
- **`Dockerfile`** 补充 OCI 镜像标签（`org.opencontainers.image.version` 等），支持通过构建参数覆盖版本号。

### 验证

- `pnpm typecheck`：EXIT=0
- `pnpm run build`：EXIT=0，41 个路由全部产出（Next.js 14.2.30）

### 部署注意

- **必须配置 `PASSWORD`**，否则修复后的鉴权会把所有访问导向 `/warning`。
- 因 `NEXT_PUBLIC_*` 为构建期内联，变更存储后端等此类变量需要**重新构建镜像**，仅改运行时环境变量无效。
- Redis 后端已启用持久化（RDB + AOF 双开），详见 `deploy/docker-compose.example.yml` 注释。

## [0.1.0]

- 初始版本，与上游 `jeffernn/joyflix` 保持一致。
