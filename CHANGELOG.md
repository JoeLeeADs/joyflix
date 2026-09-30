# Changelog

本仓库是 [jeffernn/joyflix](https://github.com/jeffernn/joyflix) 的个人优化分支，在其基础上进行安全修复、工程化补强与部署优化。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 其余 15 项待办优化（完整清单见 `.workbuddy/optimization-review.md`），按「需设计改造 → 结构性重构」分两批推进。
  重点包括：Redis / Upstash 后端中的用户密码为明文存储、登录 Cookie 未设置 `httpOnly` / `secure`、
  29 个 API 路由中有 18 个缺少自建鉴权、`/api/image-proxy` 与 `/api/admin/test-proxy` 存在 SSRF、
  以及 `Dockerfile` 依赖 `sed` 改写源码且失配时不报错。

## [0.2.6] - 2026-09-30

### 新增

- **长按画面 3 倍速播放** `src/app/play/page.tsx`

  按住播放画面约 0.4 秒进入 3 倍速快进，画面中央浮现「3x 快进中」提示；松手立即回到用户设定的倍速。

  - 触摸与鼠标通用，桌面端按住左键同样有效；
  - 按压控制栏 / 进度条 / 设置面板 / 音量条等交互区域**不会**触发；
  - 长按结束后浏览器补发的 click 会被拦截一次，避免误触播放 / 暂停；
  - 切集、换源、切换视频时自动清理长按状态，防止倍速"卡"在 3x；
  - 原先 artplayer 内置的 `fastForward` 只在移动端生效、需长按 1 秒，已改为 `false` 并由自研实现接管。

### 优化

- **播放器倍速：文案与状态全链路保持** `src/app/play/page.tsx`

  - 控制栏按钮文案由「倍数」改为「倍速」，选定倍速后直接显示具体数字（如 `1.5x`），
    默认 1 倍速时仍显示「倍速」；
  - 倍速选择结果写入 `localStorage`，**跳转下一集 / 换源 / 重进播放页都会自动保持**，
    控制栏文案同步刷新；
  - 修复原实现的两个缺陷：倍速只在 WebKit 内核（iOS）重建播放器时恢复，其他内核切集后
    会被 `switch` 重置；以及控制栏文案永远停在「倍数」，不随实际倍速变化。

### 修复

- **倍速菜单展开后只剩「2x」一项** `src/app/play/page.tsx`

  同步控制栏倍速文案时误用了 `art.controls.update({ name, html })`。artplayer 的
  `Component.update()` 实现是**先 `remove` 再 `add`**，即销毁控件后重建；而 selector 的每一项
  在首次渲染时已被 `Object.defineProperty`（`configurable: false`）写入
  `$control_option` / `$control_item` / `$control_value` 三个只读属性，重建时对同一批 item
  对象再次定义会抛 `TypeError`，**渲染循环在第 1 项就中断** —— 菜单里只剩「2x」，
  且该异常被 `try/catch` 静默吞掉，页面上没有任何报错线索（靠 MutationObserver 观察
  `.art-selector-list` 的 DOM 变化轨迹才定位到「先渲染 6 项、随即被清空重建为 1 项」）。

  现改为直接更新文案节点 `.art-selector-value` 的 `innerHTML`，并手动维护
  `.art-selector-item.art-current` 高亮，**不再触发控件重建**。

- **长按加速偶发不生效** `src/app/play/page.tsx`

  原先用 `art.playing` 判断「是否正在播放」，而它的实现是
  `!video.paused && video.readyState > 2 && !video.ended` —— 缓冲不足时 `readyState`
  会掉到 `HAVE_FUTURE_DATA` 以下，`playing` 瞬时变 `false`，于是同一个长按动作
  **有时生效、有时毫无反应**（弱网 / 起播缓冲期最明显）。改为只判断「未暂停且未结束」，
  与缓冲状态解耦。

- **切下一集后倍速被重置为 1x** `src/app/play/page.tsx`

  原先监听 `video:ratechange` 把速率变化回写成用户偏好。但切集 / 换源时 artplayer 会重新
  加载媒体，浏览器把 `playbackRate` 重置为 `defaultPlaybackRate`（1.0）并触发 `ratechange`
  —— 这个**程序性重置被当成了用户意图**，把用户设定覆盖成 1x，连 `localStorage` 也一并改写，
  表现为「切集后倍速丢了，重进页面也是 1x」。现移除该自动学习逻辑：用户速率的入口只有
  控制栏选择器与本地恢复，两者均已显式处理。

## [0.2.5] - 2026-09-29

### 修复

- **`/api/image-proxy` 无超时、无重试，封面偶发加载失败**
  `src/app/api/image-proxy/route.ts`

  *现象*：抽样 20 张封面经代理加载，连测三轮分别为 **19/20、20/20、20/20** ——
  存在约 **2% 的偶发失败**（同一张图下一轮又能成功）。而原实现是**裸 fetch，
  既没有超时也没有重试**：一旦豆瓣图床的连接挂住，这个请求会一直悬着，
  前端表现就是"这张封面永远加载不出来"，与首页骨架屏属同一类隐患。

  *修复*：
  - 出栈取图增加 **15s 显式超时**（`AbortController`）；
  - 网络错误 / 5xx 自动**重试 1 次**（偶发失败重试基本都能救回）；
  - 上游 **4xx 属确定性失败**（图不存在或被拒），不做重试，直接透传原状态码；
  - 失败时打印原始 URL 与原因，便于后续定位。

## [0.2.4] - 2026-09-29

本版修的是首页「各板块没有数据、无限骨架屏」的真因：**客户端在 `Promise.all` 里直连了一个
在国内网络被 DNS 污染的域名，而且没有设置任何超时**，导致整个首页的 `loading` 永远为真。

### 修复

- **首页除「继续观看」外全部卡在加载骨架屏**
  `src/app/page.tsx`、`src/lib/bangumi.client.ts`、`src/lib/douban.client.ts`

  *现象*：手机端首页只有「继续观看」（读本地播放记录）有内容，热门电影 / 热门剧集 /
  热门综艺 / 华语电影全部停留在骨架屏并持续"呼吸"，点击无响应，看起来像数据没抓出来。

  *根因*：首页 `fetchRecommendData` 用 `Promise.all` 同时等待 4 个数据源，其中包含
  `GetBangumiCalendarData()` —— 它直接 `fetch('https://api.bgm.tv/calendar')`，
  **没有任何超时**。而 `api.bgm.tv` 在本机网络下被 DNS 污染：默认 DNS / 223.5.5.5 /
  119.29.29.29 / 8.8.8.8 返回 **四个互不相同**的假 IP（108.160.x / 43.226.16.8 /
  199.59.149.202），IPv6 更直接返回 Facebook 地址段，连接会一直挂在 TCP 握手上而不报错。
  于是 `Promise.all` 永不 settle → `setLoading(false)` 永不执行 → `setHotMovies` 等几行
  永远到不了（**豆瓣数据其实早已取回，只是没机会写入 state**）。

  *修复*：
  - `GetBangumiCalendarData` 增加 8s 显式超时，失败/超时**返回空数组且不抛错**；
  - 首页把番剧日历**移出骨架屏判定**，改为独立异步落地；豆瓣四个板块各自 `.catch()` 隔离，
    任一失败只影响自己，不再拖垮整页；
  - `douban.client.ts` 的 `direct` 分支原先同样是**裸 fetch 无超时**，统一改为 15s 超时；
  - bgm.tv 不可达时**整块隐藏**「热门番剧」，不再留一行空白。

  *备注*：bgm.tv 在当前网络不可达是既成事实（服务端同样被污染，无法代理），
  「每日放送」需自备代理才能恢复；其余板块不受影响。

## [0.2.3] - 2026-09-29

本版修的是 0.2.2 部署后才暴露的**更深一层**问题：搜索与收藏刷新成批失败的真因，
既不在标题匹配逻辑、也不在采集源，而在 **Node 的 DNS 解析线程池被 27 路并发打满**。

### 修复

- **搜索/收藏刷新成批失败：libuv DNS 解析线程池饥饿**
  `Dockerfile`、`src/lib/fetchVideoDetail.ts`、`src/lib/downstream.ts`
  *现象*：0.2.2 部署后 `/api/recommendations` 已恢复正常，但 29 个收藏仍只刷出 1–3 个；
  更严重的是**搜索接口连打十几次后，所有采集源一起返回空**，且每次耗时恒定 **8.1 秒**
  （正好是 `searchFromApi` 内部的 8000ms 超时阈值），过几分钟又自行恢复。
  *排查过程（每一步都有对照实验）*：
  1. 失败记录里 54 次是「未在任何可用源中找到匹配的影片」，真正的网络错误只有 4 次 → **不是网络**；
  2. 从**宿主机**直连 27 个源，串行与 27 路并发各连打 3–5 轮，**每轮稳定 19 个源返回数据、零退化**
     → 排除网络、出口 IP 被封、conntrack（实测 126/262144）、本地端口耗尽；
  3. 在**容器内**另起 Node 进程打同样的源：第 1 轮 9 个超时，第 2/3 轮全部正常
     → 典型的 **DNS 冷启动**特征；
  4. 定位根因：`getaddrinfo` 执行在 **libuv 线程池**上，Node 默认只给它 **4 个线程**。
     而本站一次搜索要并发请求 **27 个采集源**，27 路域名解析挤进 4 个槽位排队，
     排队时间超过单源 8 秒超时 → 所有请求一起超时。
     雪上加霜的是 `searchFromApi` 会把异常**静默吞掉**（`catch (error) { return []; }`），
     导致「源访问失败」与「源里没有这部片」在上层完全无法区分，排查时看不见任何真因。
  *修复*：
  - `Dockerfile` 运行时阶段内置 `ENV UV_THREADPOOL_SIZE=16`；
    写在镜像里而不是只写 compose，避免换部署环境时被漏掉（两者同时写，compose 可覆盖）。
  - `fetchVideoDetail` 的跨源搜索改为**限流并发**（同时 10 路），给线程池留出余量。
  - `searchFromApi` 与单源搜索包装器在失败时**打印源名、关键词与错误信息**，不再静默吞异常。
  *实测效果*（同一台服务器、同一批 24 个片名、连续探测）：

  | 指标 | 修复前 | 修复后 |
  |---|---|---|
  | 能搜到同名影片的片名 | **2 / 24** | **17 / 24** |
  | 单次搜索耗时 | 全部卡在 8.1s 超时 | 1.8–11.3s，正常返回 |
  | 第 3 个请求之后 | **全部返回 0 结果** | 稳定返回，部分片名 500+ 条 |

  cron 侧同步见效：`秦时明月1之百步飞剑`（1 → 10 集）、`秦时明月3之诸子百家`（1 → 34 集）、
  `秦时明月5之君临天下`（1 → 27 集）、`秦时明月6之沧海横流`（1 → 21 集）、
  `斗破苍穹 第5季·动态漫`（50 → 6）等原先必然失败的长尾片名开始正常更新集数。
  *仍有少数片名匹配不到*（如 `斗破苍穹 第4季 动态漫画`、`眷思量第一季`），
  复核后确认属**采集源确实没有该条目**（搜到了结果但无同名影片），非程序缺陷；
  这类收藏会被安全跳过，不影响其余收藏，且不会改动收藏键。

## [0.2.2] - 2026-09-29

本版是 0.2.1 部署后的**续修**。0.2.1 修掉了 `/api/recommendations` 的 Upstash 崩溃，
却暴露出被它掩盖的**第二层缺陷**（自调用 URL 为 `undefined`）；收藏刷新的机制虽已打通，
但**标题匹配过严 + 串行搜索无超时**导致多数收藏仍刷不动。两项都只在部署后才可见。

### 修复

- **搜索页推荐接口仍然 500：自调用 URL 为 `undefined`** `src/app/api/recommendations/route.ts`
  *现象*：0.2.1 部署后 `/api/recommendations` 依旧 500、响应体 `{"list":[]}`，日志抛
  `TypeError: Failed to parse URL from undefined/api/douban/categories?...`。
  *根因*：本路由用 `${process.env.NEXT_PUBLIC_BASE_URL}/api/douban/categories?...`
  发起一次**指向自身的 HTTP 请求**，而该变量从未在容器内配置。两个致命点：
  1. `NEXT_PUBLIC_*` 变量由 Next.js 在**构建期内联**，未配置时被固化为 `undefined`，
     拼接后连 `new Request()` 都构造不出来——这是独立于 0.2.0 崩溃、原本被掩盖的缺陷；
  2. `/api/douban/categories` 受 middleware 鉴权保护（`src/middleware.ts:136` 的豁免清单里没有它），
     而本路由恰恰在豁免清单里。内部 fetch 不会带上 Cookie，**即使 URL 修好也只会拿到 401**。
  *修复*：彻底去掉自调用，改为直接调用豆瓣 rexxar 接口（`fetchDoubanData`，与
  `/api/douban/categories` 同源）。本路由自此**不依赖任何环境变量、也不依赖鉴权上下文**。

- **收藏定时刷新刷不动：标题匹配过严 + 无超时 + 串行搜索** `src/lib/fetchVideoDetail.ts`
  *现象*：0.2.1 把 `无效的API来源` 换成了 `未在任何可用源中找到匹配的影片`，但仍有多个收藏刷不出来。
  实测确认**不是源不可用**，而是**同一部片在不同源的命名变体**：
  「秦时明月1之百步飞剑」源站写作「秦时明月之百步飞剑」（少一个数字）；
  「斗破苍穹 第4季 动态漫画」源站写作中文数字；「全职高手 第一季」各源空格写法不一。
  原实现用 `item.title.trim() === title` 严格相等比对，上述变体一律判为不匹配。
  *修复*（三层）：
  1. **标题归一化比对**：中文数字转阿拉伯（第四季 → 第4季）、去掉空白与中英文标点、忽略大小写；
  2. **去数字二次搜索**：第一轮全部未命中、且片名不含「第N季」标记时，去掉数字再搜一次并按
     去数字后的标题比对（正是「秦时明月1之…」的解法）。带季度标记的片名**跳过**该轮，
     避免把第 4 季的元数据刷到第 5 季上；
  3. **搜索并行化 + 15s 超时**：原实现逐源串行搜索且**完全没有超时**，实测有源单次搜索挂死 70 秒、
     另有源直接 `fetch failed`，29 个收藏累积能把一次 cron 拖成十几分钟。现改为 `Promise.all`
     并行（与 `/api/search` 的既有做法一致）并给每个源 15s 上限，单次搜索耗时上限由
     「各源耗时之和」降为「最慢单源」。

### 备注

- cron 任务没有互斥保护：`start.js` 的开机触发与任何手动触发（如运维直接 curl `/api/cron`）
  会**并发执行**。0.2.1 部署当天就观察到两轮并发（开机触发 + 验证脚本手动触发），
  会让采集源负载翻倍。本版缩短单次执行时间后可缓解，但加锁仍是后续待办。
- `start.js` 对 `/api/cron` 的请求设了 30 秒超时，而服务端任务远不止 30 秒，
  因此日志里的 `Cron job timeout` 属**正常现象**，服务端仍在后台继续执行。

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

### 构建

- **新增 `.npmrc`，把 npm 源指向 `registry.npmmirror.com`**
  服务器位于国内，容器内 `pnpm` 原先走默认的 `registry.npmjs.org`。实测一次 Docker 构建中
  `pnpm install --frozen-lockfile` 在最后几个包上**停滞 17 分钟且无任何进展**
  （三条到注册表的 TCP 连接处于 ESTABLISHED 但零字节流动），整个镜像构建表现为假死。
  本地机器因 `~/.npmrc` 早已配置镜像源所以复现不到，而容器构建上下文里没有该文件 ——
  因此必须在仓库内声明，才能保证「本地改代码 → 服务器构建」这条链路稳定。
  改用镜像源后，同一构建的依赖安装阶段由「10 分钟仍未完成」缩短到**约 3 分钟完成**。
  另配 `fetch-retries=5` 与 `fetch-retry-maxtimeout=120000`，容忍镜像源抖动。
  （npmmirror 由阿里巴巴运营；pnpm 会按 lockfile 中的 integrity 校验每个 tarball，
  镜像即使返回被篡改的包也会因校验失败而中止，安全性有保障。）
- **`Dockerfile` deps 阶段同步复制 `.npmrc`**（`COPY package.json pnpm-lock.yaml .npmrc ./`）。
  这一步不可省略：deps 阶段原先只复制两个依赖清单文件，`.npmrc` 要到后面的 builder 阶段
  才随 `COPY . .` 进入镜像，**那时依赖已经装完** —— 只加 `.npmrc` 而不改这一行是无效的。

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
