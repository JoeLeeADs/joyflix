# Changelog

本仓库是 [jeffernn/joyflix](https://github.com/jeffernn/joyflix) 的个人优化分支，在其基础上进行安全修复、工程化补强与部署优化。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 其余 15 项待办优化（完整清单见 `.workbuddy/optimization-review.md`），按「需设计改造 → 结构性重构」分两批推进。
  重点包括：Redis / Upstash 后端中的用户密码为明文存储、登录 Cookie 未设置 `httpOnly` / `secure`、
  29 个 API 路由中有 18 个缺少自建鉴权、`/api/image-proxy` 与 `/api/admin/test-proxy` 存在 SSRF、
  以及 `Dockerfile` 依赖 `sed` 改写源码且失配时不报错。

## [0.2.16] - 2026-10-08

**iPhone 画中画最终修复：真机诊断推翻假设，标准 API 直接可用**

- **真机诊断**（`/pip-test.html`，iPhone iOS 18.7 Safari）：标准 `requestPictureInPicture()`
  对 hls.js(MMS) 与原生 HLS **两条管线全部成功**弹出悬浮窗——此前「iPhone 不支持」的
  判断被推翻（WebKit #303885 的问题是 iOS 26 + standalone 容器特有）。
- **自伤定位**：v0.2.13 的 `pictureInPictureEnabled` 影子化让 v0.2.14 分档逻辑的标准 API
  档被整段跳过，永远落到「进全屏」兜底——这正是「点画中画 = 进全屏」的原因。
- **修复**：撤销影子化；分档重排为 标准 API 优先（含 `InvalidStateError` 时提示
  「视频尚未加载完成」而非误导性降级）→ webkit presentation mode → 原生全屏兜底。

## [0.2.15] - 2026-10-08

**新增画中画真机自诊断页 `/pip-test.html`**：同一剧集分别以 hls.js(MMS) 与原生 HLS
两条管线加载，逐项实测 `webkitSupportsPresentationMode` 函数探测、
`requestPictureInPicture()` 实调（含错误原文）、`webkitSetPresentationMode` 实切，
用于定位 iPhone 画中画不可用的决定性因素。`public/hls.light.min.js` 一并入库。

## [0.2.14] - 2026-10-08

**修复 iPhone 上画中画按钮「点了没反应」**（0.2.13 真机反馈：不再报错，但也弹不出悬浮窗）：

- **根因**（WebKit Bugzilla #303885 + Apple 官方文档确认）：iPhone 上
  `webkitSetPresentationMode('picture-in-picture')` 是**静默无效**的 ——
  `'picture-in-picture'` presentation mode 在 iPhone 上不被支持（iPad/Mac 才有），
  唯一准确的探测是按函数调用 `video.webkitSupportsPresentationMode('picture-in-picture')`，
  而 artplayer 的 webkit 分支只判断了「方法是否存在」。
- **修复**：接管 pip 按钮点击（容器捕获阶段拦截，绕开 artplayer 全部内部分支），按真实能力分档：
  ① 已在画中画 → 退出；② WebKit presentation mode 探测通过（iPad/Mac Safari）→ 走 Apple 官方路径；
  ③ 标准 API 可用（桌面 Chromium）→ `requestPictureInPicture()`；
  ④ 都不行（iPhone）→ 进入系统原生全屏播放器并提示，用户在原生控件里点画中画图标
  （iPhone 上唯一可靠的编程入口；离开 Safari 时系统也会自动画中画）。
- 保留 0.2.13 的 iOS `pictureInPictureEnabled` 影子化（兜住其他内部调用路径）。

## [0.2.13] - 2026-10-03

**修复 iOS 上画中画（PiP）按钮报错**：

- **根因**：iPhone/iPad Safari 的 `document.pictureInPictureEnabled` 返回 `true`（iOS 13.4 起），
  artplayer 的 pip 模块据此走「标准 `requestPictureInPicture()`」分支；但 iPhone 上该 API
  受平台限制会以 `NotSupportedError` 失败，点击画中画按钮即报错。
- **修复**：仅在 iOS 设备上把 `document.pictureInPictureEnabled` 影子化为 `false`
  （`document` 实例同名自有属性遮蔽原型 getter），artplayer 便自动改走
  `webkitSetPresentationMode` 分支 —— 即 Apple 官方文档推荐的 iOS 路径。
  桌面端（Chromium / macOS Safari）标准 API 可用，行为不变。
- **补充**：监听 `webkitpresentationmodechanged`，用户在系统画中画浮窗点「关闭」后
  同步播放器按钮状态（artplayer 的 webkit 分支自身不监听该事件，会卡在旧文案）。
- 附带 `diagnose-pip.js` 诊断脚本（能力探测 + 手势点击 + 无手势对照 + 状态复位）。

## [0.2.12] - 2026-09-30

**长按倍速改为用户可配置项**（真机确认 0.2.11 的音调与流畅度问题已解决）：

- 播放页「设置」面板新增「长按倍速」选择器（1.5x / 2x / 2.5x / 3x），**不离开播放页即可修改**
- 按**登录用户全局生效**（不区分剧集、跨设备跨会话）：新增用户全局设置存储
  `u:{用户}:setting:{key}`（redis / upstash 双后端）与 `/api/usersettings` 接口（键白名单 + 值校验）
- 客户端 `getUserSetting` / `setUserSetting`（localStorage 模式同样支持）
- 长按浮层文案、手势层倍率随设置实时变化；接口返回晚于播放器创建时由 DOM 补丁兜底修正 tooltip

## [0.2.11] - 2026-09-30

真机反馈（iOS Safari）跟进 0.2.9 / 0.2.10 的长按加速：**放大镜已消除** ✅，
但暴露两个新问题 —— **长按后声音变尖锐（有时要再按一次才恢复）**、**长按期间画面仍不丝滑**。
本版修掉这两个问题，并把长按倍率从 3 倍降为 2 倍。

### 修复

- **长按后声音变尖锐，有时要再长按一次才恢复正常** `src/app/play/page.tsx`
  *现象*：长按加速结束后音调持续偏高（听感"声音变尖"），重新长按一次又恢复正常。
  *原因*：0.2.9 在长按触发时设了 `video.preservesPitch = false`（当时的理由是
  "3 倍速下音频时间拉伸吃 CPU"）。但 `preservesPitch` 是**挂在 `<video>` 元素上的持久状态**，
  而恢复它的路径有多条：正常松手走 `stopLongPressRace()`、切集走 `resetLongPressRaceState()`、
  播放器重载走手势 effect 的清理。其中 `resetLongPressRaceState()` **只重置标志位，
  既不恢复 `preservesPitch` 也不恢复 `playbackRate`**；手势 effect 的清理同样只改 ref。
  于是只要有一条路径被跳过（指针被 `pointercancel` 掐断、播放器重载使 effect 重绑后
  `g.pointerId` 已对不上、`pointerUp` 被提前 return），`preservesPitch` 就会**残留为 false**，
  此后一直变调 —— 直到下一次长按正常松手，才被 `stopLongPressRace()` 里的
  `preservesPitch = true` "顺带"修好。这就是"再按一下就好了"的机制。
  *修复*：**彻底不再改动 `preservesPitch`**，保持浏览器默认（`true`，音调不随倍速变化）——
  与 artplayer 官方 `fastForward` 的做法一致（其源码中完全没有 pitch 处理）。
  另在指针按下时做一次幂等的 `preservesPitch = true` 自愈，兜住任何潜在残留。

- **长按期间画面仍不丝滑** `src/app/play/page.tsx`
  *原因一*：3 倍速对移动端的解码 + 音频时间拉伸压力偏高。
  *原因二*：长按提示浮层用了 `backdrop-blur-sm`（即 `backdrop-filter: blur()`）——
  它会强制浏览器**每帧对下层正在播放的视频重新做一次模糊合成**，移动端 GPU 开销很大，
  浮层一出现画面就明显发涩。
  *修复*：长按倍率 `3 → 2`（与 YouTube 等主流播放器一致；长按是"临时代偿"，无需 3 倍那么激进）；
  长按提示浮层与滑动时间提示浮层**去掉 `backdrop-blur`**，改用高不透明度纯色背景（`bg-black/85`），
  观感几乎一致但消除了逐帧合成开销。

- **切集/换源瞬间可能停留在长按倍速** `src/app/play/page.tsx`
  `resetLongPressRaceState()` 在重置标志位后**立即把 `playbackRate` 还给用户设定值**。
  此前该函数只重置标志位，把"恢复倍速"全押在 `canplay` 兜底上，而那段兜底恰好要求
  `longPressRateActiveRef` 已为 false —— 隐含依赖了本处赋值，顺序脆弱。现在改为显式恢复。

### 说明

- 关于"换成成熟的长按方案"：artplayer 内置 `fastForward` 的倍率与延迟**其实是可配的**
  （`Artplayer.FAST_FORWARD_VALUE` 默认 3、`FAST_FORWARD_TIME` 默认 1000），但源码显示它
  ① 把 `touchstart` 绑在 `<video>` 上（而本项目已让 `<video>` 让出指针事件以规避 iOS 放大镜）→ 收不到事件；
  ② 取消条件是 document 上**任意** `touchmove`，**没有死区** → 长按时手指抖动会立刻取消加速；
  ③ 只处理 touch、仅移动端生效。故仍保留自定义手势层，细节见代码注释。

## [0.2.10] - 2026-09-30

0.2.9 上线后，用真浏览器专项诊断（`diagnose-click-forward.js`）复测"轻点画面"链路时，
发现 click 转发实现有一个**自触发循环**——属于 0.2.9 引入的缺陷，本版修掉。

### 修复

- **click 转发重入：一次轻点会在 `<video>` 上派发 43 个 click** `src/app/play/page.tsx`
  *现象*：验证脚本 ㊿「轻点画面仍能切换播放/暂停」失败；专项诊断实测
  **一次轻点 → `<video>` 收到 43 个 click**（文档层 44 个，多出的 1 个是真实点击）。
  *原因*：0.2.9 让 `<video>` 让出指针事件（`pointer-events: none`）后，click 改由手势层
  **转发**：`video.dispatchEvent(new MouseEvent('click', { bubbles: true, ... }))`。
  但派发的是**会冒泡**的合成事件——它从 `<video>` 冒泡回同一个容器，监听器再次收到、
  再转发一次，形成递归（被运行时的事件分派深度上限截断在 43 层）。
  后果是 artplayer 的 300ms 单击/双击判定被瞬间灌满：单击分支与双击分支交替命中，
  单击/双击行为整体错乱（表现为"轻点没反应"、双击乱触发），desktop 下还会连带触发双击全屏。
  *修复*：加**重入标志** `forwardingClick`，`dispatchEvent` 前后置位/复位，
  把自己派发的合成 click（冒泡回来时）整段忽略。`dispatchEvent` 是同步的，
  因此重入发生在标志为 true 的窗口内，可被稳定识别。
  *验证*：修复后重跑诊断，一次轻点 → `<video>` 仅收到 **1** 个 click。

## [0.2.9] - 2026-09-30

本版修掉移动端长按画面的三个联动问题：**仍会弹放大镜**、**长按与左右滑动快进快退互相打架**、
以及**长按期间画面冻住、松手才突然跳到后面**。前两个是同一个根因，第三个是它的后果。

### 修复

- **长按加速与「横向滑动调进度」互相冲突，且长按期间画面卡死** `src/app/play/page.tsx`
  *现象*：手机端按住画面加速时，画面长时间固定不动，松手一瞬间突然跳到很后面的位置；
  按住时还会和左右滑动快进快退互相干扰。
  *原因*：artplayer 内置的 `gesture`（**默认开启**，本项目此前从未关闭）实现了「横向滑动调进度」，
  公式是 `进度 = 起点时间 + duration × 水平位移比例 × TOUCH_MOVE_RATIO(0.5)` ——
  **滑满一个屏宽就要跳掉总时长的一半，而且完全没有死区**。
  长按加速只要求「按住不动」，但人手按住时必然有 1~5px 抖动，两套逻辑于是同时生效：
  手指每抖一下都触发一次 `seek`，而**每次 seek 都会清空解码缓冲**，
  画面因此长时间停滞，松手后缓冲补齐才跳到新位置 —— 这就是"不丝滑"的成因。
  *修复*：关闭内置 `gesture`，改为自研手势层（指针状态机 + 死区）：
  - 引入 **12px 死区**：按下后位移小于死区不算滑动；
  - 按下 400ms 内未越过死区 → 判定长按 → 固定 3 倍速，**此后忽略一切滑动**；
  - 位移先越过死区且横向占优 → 判定滑动 → **取消长按**，进入进度调节
    （进度按 `duration × 位移比例 × 0.5` 计算并扣掉死区，避免刚越过阈值就跳一大截）；
  - 纵向占优 → 整段放弃手势，把事件让给页面滚动；
  - 滑动期间显示 `mm:ss / mm:ss` 时间提示浮层；
  - 长按期间关闭 `video.preservesPitch`（3 倍速下的音频时间拉伸很吃 CPU，移动端会掉帧）。
  - 指针用 `setPointerCapture` 捕获，手指移出播放器范围也不再丢事件。

- **iOS 长按画面仍然弹出圆形放大镜 + 文字选择手柄** `src/app/globals.css`、`src/app/play/page.tsx`
  *现象*：v0.2.8 已在样式层对播放器全部后代禁用选择，真机（iOS Safari）长按依旧会弹放大镜与选字手柄。
  *原因*：真浏览器实测证明**样式并没有漏** —— 长按命中点的 `video`、`.art-video-player`、
  `.jf-player` 三层计算值都已经是 `user-select: none`。问题出在 **iOS 对 `<video>` 元素有 UA 层面的
  原生长按行为**，`user-select` 压制不住它；而 `-webkit-touch-callout` 本身也只对 `<a>` / `<img>` 生效，
  对 `<video>` 同样无效。所以「继续补 CSS」这条路走不通。
  *修复*：让 `<video>` **让出指针事件**（`pointer-events: none`），事件落到外层的
  `.art-video-player`（普通 div，样式层能完全控制），iOS 便不再把它当作「可选中的媒体」。
  为保持交互不变，手势层把 `click` **原样转发**回 `<video>` —— artplayer 的单击 / 双击判定
  完全基于 `<video>` 上的 click 时间戳（`DBCLICK_TIME = 300ms` 计数），因此播放/暂停、
  双击全屏等行为不受影响。该方案同样**没有**动 `touchstart` 的默认行为，
  因此不会引入 v0.2.8 注释里担心的「点画面无法暂停」回归。

- **横向滑动调进度会被浏览器当成页面滚动而中断** `src/app/globals.css`
  *现象*：手指横向滑动调进度时，进度只跳了一小段就中断，时间提示浮层随之消失。
  *原因*：artplayer 给 `.art-video-player` 设的是 `touch-action: manipulation`，
  它**允许横向 pan** —— 浏览器于是认为用户在滚动页面，抢走手势并派发 `pointercancel`，
  把手势层里正在进行的状态整个复位。
  *修复*：把播放器区域的 `touch-action` 收紧为 `pan-y`。纵向仍交给浏览器滚页面
  （竖屏时播放器只有 300px 高，用户需要能在它上面上下滑动翻页），横向不再被接管。
  *验证*：真浏览器滑动期间 `pointercancel` 计数为 0，时间提示浮层可见。

## [0.2.8] - 2026-09-30

本版按需求做两件事：把**播放倍速**从「全局本地存储」改为「按登录用户 + 剧集存进数据库」，
与已有的「跳过片头片尾」同构；以及**消除移动端长按画面时的选字 / 放大镜 / 系统长按菜单**。

### 新增

- **播放倍速按「用户 + 剧集」维度持久化** `src/lib/{types,db,redis.db,upstash.db}.ts`、
  `src/app/api/rateconfigs/route.ts`、`src/lib/db.client.ts`、`src/app/play/page.tsx`
  *背景*：v0.2.6 的倍速只存在 localStorage 的单个键里，属于**全局**状态——换一部剧会沿用上一部剧
  的倍速。需求是像「跳过片头片尾」一样，按登录者 + 剧集各存一份。
  *实现*：
  - 存储键 `u:{用户}:rate:{source}+{id}`，与 skip 配置的 `u:{用户}:skip:{source}+{id}` 同构；
    Redis / Upstash 双后端各自实现读写，并纳入 `deleteUser` 的清理范围（否则删号会残留垃圾键）。
  - 新增 `/api/rateconfigs`（GET / POST / DELETE），鉴权、封禁校验、key 解析方式与
    `/api/skipconfigs` 对齐；服务端校验倍速必须落在 `0.25 ~ 4`，越界返回 400，避免写入脏值。
  - 前端 `db.client.ts` 增加倍速配置的混合缓存（缓存优先 + 后台同步）与乐观更新读写，
    `refreshAllCache` / `getCacheStatus` 一并纳入。
  - 播放页在 `[currentSource, currentId]` 变化时读回**该剧自己**的倍速；**没有记录时回到 1x**，
    不再是上一部剧的值。同一部剧跳集 / 重进页面 / 退出重进都保持；换线路时与 skip 配置一样，
    把当前倍速迁移到新线路对应的键上。
  - 旧的全局 `localStorage.joyflix_playback_rate` 不再使用，**也不做迁移**：若把旧值搬到新剧上，
    就正好复现了"换剧沿用了别的剧的倍速"这个问题。

### 修复

- **移动端长按画面会弹出选字手柄 / 放大镜 / 系统长按菜单** `src/app/globals.css`、`src/app/play/page.tsx`
  *现象*：手机端长按画面触发 3 倍速的同时，会弹出文本选择框（带放大镜、可拖动）或系统长按菜单。
  *原因*：artplayer 自带样式只写了**无前缀**的 `user-select: none`（实测包内 `-webkit-user-select`
  出现 0 次），且完全没有 `-webkit-touch-callout`；而 `-webkit-touch-callout`、`-webkit-user-drag`
  在多个内核里**并不是继承属性**，只声明在播放器容器上覆盖不到内部的 `<video>` 与各层；
  另外部分国产内核浏览器会自己弹长按菜单，与 CSS 无关。
  *修复*：`globals.css` 用 `.jf-player, .jf-player *` 对**全部后代**强制
  `-webkit-user-select` / `user-select` / `-webkit-touch-callout` / `-webkit-user-drag` /
  `-webkit-tap-highlight-color`，并把选中高亮改成透明；播放器容器加上 `jf-player` 类。
  再在容器上拦截 `contextmenu` / `selectstart` / `dragstart` 做兜底。
  **刻意不拦截 `touchstart`**：artplayer 的单击播放 / 暂停挂在 `<video>` 的 `click` 事件上，
  而 iOS 上被 `preventDefault` 的 touchstart 之后不会再生成 `click`，
  那样会引入"点画面无法暂停"这种比原问题更严重的回归。

## [0.2.7] - 2026-09-30

本版处理 0.2.2 起挂账的**定时任务并发问题**：`/api/cron` 全量刷新可能被并发触发，
让采集源负载翻倍。同时补上该路由**唯一的访问保护**，并修正每次调度都会打出的误导性超时日志。

### 修复

- **定时任务没有互斥保护，开机触发与手动触发会并发** `src/app/api/cron/route.ts`、
  `src/lib/cronLock.ts`、`src/lib/{types,db,redis.db,upstash.db}.ts`
  *现象*：`start.js` 在服务起来后立即触发一次刷新、之后每小时一次；同时 `/api/cron`
  在 middleware 的鉴权豁免名单内，任何能访问站点的人都能手动触发。两条路径没有互斥，
  实测同一天出现过并发（开机触发 + 手工验证触发），会让 27 个采集源负载翻倍。
  *修复*：引入存储层的原子锁（`SET key token NX EX ttl`，释放走 Lua 的 compare-and-del，
  只有持有者能解），锁的 TTL 取 30 分钟——远大于单次任务实测的 2~4 分钟，
  又小于 1 小时的调度周期，进程被 kill 时最多影响一次调度而不会永久卡死。
  未抢到锁的请求**不执行刷新**，直接返回 `{ success: true, skipped: true }`（HTTP 200，
  不记为失败，避免调度侧误报）。
  - `src/lib/redis.db.ts` / `src/lib/upstash.db.ts` 各自实现 `acquireLock` / `releaseLock`，
    经 `DbManager` 透出；`localstorage` 模式没有后端，视为无条件放行（该模式下刷新本身是空操作）。
  - 锁后端异常时 **fail-open**（不加锁继续执行），避免因为锁本身让定时任务彻底停摆，但会打印明确日志。

- **`/api/cron` 无任何访问保护** `src/app/api/cron/route.ts`、`start.js`、`.env.example`
  *现象*：该路由被 middleware 豁免鉴权，又不带任何自建校验，等于把一个耗时数分钟、
  会打满采集源的重活暴露给所有能访问该站点的人（含 Cloudflare Tunnel 的公开域名）。
  *修复*：新增可选环境变量 `CRON_TOKEN`。配置后必须带 `x-cron-token` 请求头或
  `?token=` 查询参数才执行，否则返回 401；**未配置则保持原行为**（向后兼容）。
  容器内的 `start.js` 会自动携带该头，手动触发改为
  `curl "http://<站点>/api/cron?token=<CRON_TOKEN>"`。

- **每次调度都会打出误导性的 `Cron job timeout` / `socket hang up`** `start.js`
  *现象*：客户端对 `/api/cron` 的超时写死 30 秒，而服务端任务实测 2~4 分钟，
  于是每小时日志里必然出现「Cron job timeout → ECONNRESET」，看起来像故障，
  实际服务端仍在后台跑完（宿主机 `docker logs` 可确认任务正常结束）。
  *修复*：客户端超时改为 10 分钟，`end` 分支得以真正拿到执行结果并打印耗时。

### 优化

- **`start.js` 调度改为「上一轮结束后再排下一轮」** `start.js`
  由固定 `setInterval` 改为自排程 `setTimeout` 链，并加进程内互斥标志：
  单次任务一旦超过调度周期也不会叠加堆积；同一进程内绝不并发。
  这层与上面的分布式锁是**双保险**（前者防同进程，后者防多实例 / 手动触发）。

### 备注

- **手动触发请用容器内直连，不要走公网入口**。站点经 Cloudflare Tunnel 暴露，
  Cloudflare 对代理请求的等待上限约 100 秒，而一次完整刷新要 2~4 分钟，
  因此从公网 `curl https://<域名>/api/cron?token=...` 会在约 138 秒后收到
  **HTTP 524**（Cloudflare 的错误页），但**服务端任务仍在正常执行并跑完**。
  容器内 `start.js` 走的是 `http://0.0.0.0:3000`，不受该限制，能正常拿到结果。
  需要手动触发时请用容器内直连——**注意必须写 `127.0.0.1`**：
  `docker exec joyflix-core wget -qO- --header="x-cron-token: $CRON_TOKEN" http://127.0.0.1:3000/api/cron`。
  写成 `localhost` 会 `Connection refused`：容器内 `/etc/hosts` 里 `localhost` 解析为 IPv6 `::1`，
  而 Next.js 只监听 IPv4。容器内没有 `curl`，用 `wget`（已实测 401 / 200 两种返回均正常）。
- 锁的键名是 `joyflix:cron:lock`（冒号，不是下划线），排查时用
  `docker exec joyflix-redis redis-cli GET "joyflix:cron:lock"` 查看，
  `TTL` 可看出已运行多久（初始 1800 秒）。

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
