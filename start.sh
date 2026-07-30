#!/usr/bin/env bash
# 一键部署到 Oracle Ubuntu 22.04（Always Free）
# 用法：本地 ssh 登录实例后，执行： bash <(curl -fsSL https://raw.githubusercontent.com/awy45swug/wxy/main/start.sh)
set -e

echo "== 更新系统 =="
sudo apt-get update
sudo apt-get install -y git curl

echo "== 安装 Node 22 =="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "== 拉取代码 =="
rm -rf ~/moyu
git clone https://github.com/awy45swug/wxy.git ~/moyu
cd ~/moyu
npm install --omit=dev

echo "== pm2 守护 =="
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup || true

echo "== 完成 =="
echo "访问 http://<你的公网IP>:3000 即可（域名 A 记录指向该 IP）"
echo "查看日志： pm2 logs moyu"
