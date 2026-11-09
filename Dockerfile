# 说明：Debian 版 chromium 由发行版编译，**可能移除了 H.264 专有编解码**。
# 如果你的课程含视频，请先跑 `docker compose run --rm ocs node scripts/diagnose.js`，
# 若提示 H.264 不可用，请改用手动挂载宿主机带 H.264 的 Chrome：
#   volumes:
#     - /usr/bin/google-chrome:/usr/bin/google-chrome:ro
#   environment:
#     - CHROME_PATH=/usr/bin/google-chrome
# 或者直接改用裸机部署（见 README）。

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    OCS_PORT=8899 \
    OCS_DATA_DIR=/data \
    CHROME_PATH=/usr/bin/chromium \
    TZ=Asia/Shanghai

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      tini \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      fonts-freefont-ttf \
      ca-certificates \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --silent && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY userscript ./userscript

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 8899

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
