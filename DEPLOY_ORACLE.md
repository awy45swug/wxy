# 部署到 Oracle Cloud Always Free（永久免费，0 元/月）

> 目标：把「摸鱼计时排行榜 + 你画我猜」搬到 Oracle 永久免费实例，配一个永久域名访问。
> 前端已改为**同源连接**，后端 `server.js` 默认监听 `0.0.0.0`，**代码无需任何改动**。

## 0. 前置条件（先看，避免卡住）
- Oracle 账号：**必须绑定一张外币信用卡（Visa / Mastercard 双币或全币卡）**，注册时会预授权 $1 验证，**不扣费**；纯银联单币卡大概率过不了。
- 一台能 SSH 的电脑（Win / Mac / Linux 均可）。
- 域名（可选）：没有就先用公网 IP 访问；想要好记地址可注册免费永久域名（见第 6 步）。

## 1. 开通 Always Free 实例
1. 打开 https://cloud.oracle.com ，用 Oracle 账号登录。区域选**亚太**（离成都近）：首尔 `icn` / 东京 `nrt` / 大阪 `kix` / 新加坡 `sin`。
2. 左侧「计算 → 实例 → 创建实例」。
3. 镜像：Ubuntu 22.04。
4. 形状：点「更换形状」→ Ampere A1（ARM）→ 选 **2 OCPU / 12 GB**（免费额度内；热门区域抢不到就选 1 OCPU / 6 GB，完全够用）。
5. 添加 SSH 密钥：选「生成密钥对」下载私钥（留好），或粘贴你已有的公钥。
6. 创建，等 1–2 分钟。在「主网络」里记下**公网 IPv4 地址**（固定，不删实例不变）。

> ⚠️ ARM 实例在热门区域经常「容量不足」，多试几次或换区域即可，免费额度不变。

## 2. 安全组放行端口
1. 实例详情 →「主网络」→ 子网 → 安全列表 →「添加入站规则」。
2. 加 4 条（协议 TCP，源 CIDR `0.0.0.0/0`）：
   - `22`  （SSH，运维用）
   - `80`  （HTTP）
   - `443` （HTTPS，进阶用）
   - `3000`（应用端口，server.js 默认）

## 3. SSH 登录 + 装 Node 22
```bash
# Mac/Linux 先改私钥权限
chmod 400 ~/Downloads/xxx.key
ssh -i ~/Downloads/xxx.key ubuntu@<你的公网IP>

# 实例内执行
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # 应显示 v22.x
```

## 4. 拉代码 + 装依赖
```bash
git clone https://github.com/awy45swug/wxy.git moyu
cd moyu
npm install --omit=dev
```

## 5. pm2 守护（开机自启、崩了自动重启）
```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # 复制它输出的命令执行一次，实现开机自启
```
验证：`pm2 logs moyu` 应看到「🐟 摸鱼排行榜已启动」。

> 不想用 ecosystem 文件也行：`pm2 start server.js --name moyu`。

## 6. 域名（永久地址）
- **没有域名**：直接用 `http://<你的公网IP>:3000`，ws 自动同源，照样玩。
- **想要免费永久域名**：
  - pp.ua（如 `moyu.pp.ua`，免费、即时、永久）；
  - 或 eu.org（免费永久，审核稍慢）；
  - 在其 DNS 后台添加 **A 记录**指向 `<你的公网IP>`。
- **自有域名**：A 记录指向 `<你的公网IP>`。
- 访问 `http://你的域名:3000` 即可，前端 ws 自动连同源，无需改代码。

## 7. 进阶：Caddy 反代 + 免费 HTTPS（可选，更稳）
某些网络会拦 http，想要 `https://你的域名` + `wss://`：
```bash
sudo apt install -y caddy
```
`/etc/caddy/Caddyfile` 写：
```
你的域名 {
  reverse_proxy localhost:3000
}
```
```bash
sudo systemctl restart caddy
```
访问 `https://你的域名`，ws 自动升级为 wss。第 2 步已放行 80/443，无需再改。

## 8. 数据与费用
- 排行榜数据存实例块存储 `data.json`，Always Free 实例**不会被回收**，数据永久安全；想保险可定期 `scp` 备份。
- 费用：**0 元/月**。仅超出免费额度（4 OCPU·时/月、24 GB·时/月、10 TB 流量）才收费，正常跑远不到。

## 9. 常见坑
- 连不上：检查安全组 3000 是否放行、`pm2 logs moyu` 有无报错、实例内 `curl localhost:3000` 能否通。
- ARM 售罄：换区域或重试。
- 信用卡被拒：换双币/全币卡，或借家人卡。
- 实例重启后服务没起来：`pm2 startup` 没执行，重跑一次。
