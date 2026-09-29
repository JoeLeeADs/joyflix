# ---- 第 1 阶段：安装依赖 ----
FROM node:20-alpine AS deps

# 启用 corepack 并激活 pnpm（Node20 默认提供 corepack）
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 仅复制依赖清单与 npm 源配置，提高构建缓存利用率
# 注意：.npmrc 必须在这一层一起复制，否则 pnpm 会回退到默认的 registry.npmjs.org；
# 国内网络下该源极不稳定，实测会让依赖安装停滞十几分钟。放在这里也会让「改源」正确失效缓存。
COPY package.json pnpm-lock.yaml .npmrc ./

# 安装所有依赖（含 devDependencies，后续会裁剪）
RUN pnpm install --frozen-lockfile

# ---- 第 2 阶段：构建项目 ----
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
# 复制全部源代码
COPY . .

# 在构建阶段也显式设置 DOCKER_ENV，
# 确保 Next.js 在编译时即选择 Node Runtime 而不是 Edge Runtime
RUN find ./src -type f -name "route.ts" -print0 \
  | xargs -0 sed -i "s/export const runtime = 'edge';/export const runtime = 'nodejs';/g"
ENV DOCKER_ENV=true

# For Docker builds, force dynamic rendering to read runtime environment variables.
RUN sed -i "/const inter = Inter({ subsets: \['latin'] });/a export const dynamic = 'force-dynamic';" src/app/layout.tsx

# 生成生产构建
RUN pnpm run build

# ---- 第 3 阶段：生成运行时镜像 ----
FROM node:20-alpine AS runner

# 镜像版本号，构建时可用 --build-arg APP_VERSION=x.y.z 覆盖
ARG APP_VERSION=0.2.3

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

LABEL org.opencontainers.image.title="joyflix" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/JoeLeeADs/joyflix" \
      org.opencontainers.image.description="JoyFlix - 基于 jeffernn/joyflix 的个人优化分支"

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DOCKER_ENV=true
# 关键：放大 libuv 线程池。Node 的 DNS 解析（getaddrinfo）跑在 libuv 线程池上，
# 默认只有 4 个线程。本站搜索要同时对 27 个采集源发起请求，27 个域名解析会被排进
# 只有 4 个槽位的队列；排队时间一旦超过 searchFromApi 的 8 秒超时，就会表现为
# 「所有源同时失灵」——搜索返回 0 结果、定时任务收藏刷新成批失败。
# 实测（同一台服务器）：默认 4 线程时 24 个片名里只有 2 个能搜到；设为 16 后提升到 17 个。
# 放在镜像里而不是只写在 compose 里，避免换部署环境时被漏掉。
ENV UV_THREADPOOL_SIZE=16

# 从构建器中复制 standalone 输出
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# 从构建器中复制 scripts 目录
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# 从构建器中复制 start.js
COPY --from=builder --chown=nextjs:nodejs /app/start.js ./start.js
# 从构建器中复制 public 和 .next/static 目录
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/config.json ./config.json

# 切换到非特权用户
USER nextjs

EXPOSE 3000

# 使用自定义启动脚本，先预加载配置再启动服务器
CMD ["node", "start.js"] 