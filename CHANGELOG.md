# Changelog

本仓库是 [jeffernn/joyflix](https://github.com/jeffernn/joyflix) 的个人优化分支，在其基础上进行安全修复、工程化补强与部署优化。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 其余 15 项待办优化（完整清单见 `.workbuddy/optimization-review.md`），按「需设计改造 → 结构性重构」分两批推进。
  重点包括：Redis / Upstash 后端中的用户密码为明文存储、登录 Cookie 未设置 `httpOnly` / `secure`、
  29 个 API 路由中有 18 个缺少自建鉴权、`/api/image-proxy` 与 `/api/admin/test-proxy` 存在 SSRF、
  以及 `Dockerfile` 依赖 `sed` 改写源码且失配时不报错。

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
