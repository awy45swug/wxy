# 摸鱼计时排行榜 · 国内云长期部署手册（从零版）

目标：拿到一个**固定域名、永不断线**的公网地址，任何人都能访问，多人实时同步。

整体路径分两段：
1. **把代码推到 GitHub**（平台要从 Git 仓库拉代码）
2. **部署到国内云**（腾讯云 CloudBase 云托管，免费额度 + 固定子域名 + 原生支持 WebSocket）

---

## 第一段：GitHub 从零（不会也能照做）

### 1. 注册 GitHub
打开 https://github.com ，点 Sign up，用邮箱注册一个账号。

### 2. 新建一个空仓库
1. 登录后点右上角 `+` → `New repository`。
2. Repository name 填 `moyu-timer`（随便起，英文）。
3. 选 **Public**（公开，平台才能拉取；免费）。
4. **不要**勾 "Add a README file"，保持空仓库。
5. 点 `Create repository`。
6. 创建后会看到一个地址，形如：
   ```
   https://github.com/你的用户名/moyu-timer.git
   ```
   复制下来，后面要用。

### 3. 生成一个「访问令牌」用来推代码（一次性）
GitHub 现在不支持用账号密码推代码，需要用 Token：
1. 右上角头像 → `Settings` → 左侧最底部 `Developer settings`。
2. `Personal access tokens` → `Tokens (classic)` → `Generate new token (classic)`。
3. Note 随便填（如 `moyu-push`）。
4. Expiration 选 `7 days`（推完就撤销，安全）。
5. 勾选 **repo**（整行打勾即可）。
6. 拉到底点 `Generate token`。
7. 生成的字符串 `ghp_xxx...` **只显示这一次**，立刻复制保存。

### 4. 把代码推上去（在 WorkBuddy 的终端里执行）
把下面命令里的 `你的TOKEN` 和 `你的用户名` 换成你自己的，整段粘贴运行：

```bash
cd /c/Users/12419/WorkBuddy/2026-07-28-17-15-19

# 关联远程仓库（TOKEN 临时嵌在地址里，仅本机 .git/config 可见，不会进代码）
git remote add origin https://你的TOKEN@github.com/你的用户名/moyu-timer.git

# 推送到 master 分支
git push -u origin master
```

看到 `master -> master` 就成功了。

> 安全收尾（可选）：推完后把令牌从地址里去掉，避免以后误用。
> ```bash
> git remote set-url origin https://github.com/你的用户名/moyu-timer.git
> ```
> 然后去 GitHub → Settings → Developer settings 把那个 token 撤销（Revoke）。

---

## 第二段：部署到腾讯云 CloudBase（固定域名 + 支持 WebSocket）

> 为什么选它：国内访问快、有免费额度、给固定子域名（不用备案就能直接用）、云托管是容器服务、原生支持 WebSocket 长连接——正好匹配本应用。

### 1. 开通 CloudBase
1. 打开 https://cloud.tencent.com/product/tcb ，登录（用微信/QQ 扫码，需实名）。
2. 进入「云开发 CloudBase 控制台」→ 新建环境。
3. 计费方式选「按量计费」（有免费额度，小应用基本不花钱），记下**环境 ID**。

### 2. 用云托管部署（关键步骤）
1. 进入你的环境 → 左侧「云托管」→ `新建服务`。
2. 服务名称随便填（如 `moyu`），来源选 **代码仓库**。
3. 点「授权」关联 GitHub（跳转到 GitHub 登录授权，允许 CloudBase 读取你的仓库）。
4. 关联后选择：
   - 仓库：`你的用户名/moyu-timer`
   - 分支：`master`
   - 构建方式：平台会自动检测到 `Dockerfile`，无需额外配置。
5. 点击「部署 / 新建版本」。
6. 等 1~3 分钟，状态变「正常」即部署成功。

### 3. 拿到固定公网地址
部署完成后，云托管会分配一个默认域名，形如：
```
https://moyu-xxx.ap-shanghai.run.tcloudbase.com
```
这个地址**固定不变、永不断线**，直接发给同事就能多人一起摸鱼了 🐟。

> 想用自己买的域名？在云托管服务里点「绑定自定义域名」，按提示加一条 CNAME 解析即可（自有域名需先完成 ICP 备案，腾讯云有引导）。

---

## 方案二（推荐，无需 GitHub）：直接上传代码包部署

> 适用：你 GitHub 打不开。本应用已打包成 `moyu-deploy.zip`（含 `server.js` + 前端 + `Dockerfile`），直接上传到 CloudBase 云托管即可，**全程不用碰 GitHub**。

### 1. 开通 CloudBase（同方案一的 1.）
打开 https://cloud.tencent.com/product/tcb ，登录（微信/QQ 扫码，需实名）→ 新建环境 → 计费选「按量计费」（有免费额度）→ 记下**环境 ID**。

### 2. 上传 zip 部署（关键）
1. 下载对话里的 **`moyu-deploy.zip`**。
2. 进你的环境 → 左侧「云托管」→ **`新建服务`**。
3. 服务名称填 `moyu`，**来源选「代码包」**（不是「代码仓库」）。
4. 上传 `moyu-deploy.zip`。
5. 构建配置：
   - **构建方式**：选 **Docker 构建**（目录里已有 `Dockerfile`，会自动识别）。
   - **监听端口**：填 `3000`（应用读 `process.env.PORT`，CloudBase 会注入）。
   - 运行命令留空（`Dockerfile` 的 `CMD npm start` 已写好）。
6. 点「部署 / 新建版本」，等 1~3 分钟，状态变「正常」即成功。

### 3. 拿到固定公网地址
部署完成后给固定域名，形如：
```
https://moyu-xxx.ap-shanghai.run.tcloudbase.com
```
**电脑、手机同时打开这个地址，排行榜实时同步**（WebSocket 后端生效）。固定不变、永不断线，直接发同事 🐟。

> 卡在某步？把控制台截图发我，我帮你看。

---

## 备选：阿里云（如果你更熟阿里系）

- **函数计算 FC（Custom Runtime / 容器镜像）**：支持 WebSocket，但从 GitHub 拉代码 + 配 HTTP 触发器对新手略复杂。
- **轻量应用服务器 / ECS + Docker**：最稳最可控，装好 Docker 后一条命令跑起来：
  ```bash
  docker build -t moyu . && docker run -d -p 3000:3000 --name moyu moyu
  ```
  再在控制台把 3000 端口放开、绑定域名即可。需付费（轻量应用服务器约 60 元/年起）。

---

## 上线后要注意

- **数据持久化**：当前全员记录写在容器内的 `data.json`，容器重启/重新部署会清空（摸鱼榜每天清零本来也合理）。想永久保留记录，可在云托管里挂一个「对象存储/文件存储卷」映射到 `/app/data.json`。
- **更新代码**：改完本地代码后 `git push`，回 CloudBase 云托管点「重新部署」即可。
- **费用**：CloudBase 按量计费有免费额度，长时间无人访问会自动缩容到 0，基本零成本。

---

## 最短路径（懒人版，无需 GitHub）

1. 下载对话里的 **`moyu-deploy.zip`**。
2. 腾讯云开通 CloudBase（微信扫码，2 分钟）→ 新建环境。
3. 云托管 → 新建服务 → 来源「代码包」→ 上传 zip → 构建方式「Docker 构建」、端口 `3000` → 部署。
4. 部署完成拿到固定域名 `https://moyu-xxx.ap-shanghai.run.tcloudbase.com`，电脑手机同开即实时同步。

全程不用 GitHub、不用命令行。卡在哪步把截图发我。
