# 摸鱼计时排行榜 - 部署镜像
FROM node:18-alpine

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
