# 摸鱼计时排行榜 - 部署镜像
# 备注：如遇 CloudBase 构建层缓存校验失败 (invalid checksum digest format)，
# 可临时把基础镜像切到 node:20-alpine 触发全新 layer 下载绕过。
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用 Docker 层缓存，改代码不重装）
COPY package*.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

# 云平台会注入 PORT 环境变量（Render / Railway / Koyeb / Fly 等都支持）
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
