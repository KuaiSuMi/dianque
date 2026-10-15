# Ubuntu 24.04 部署

架构：浏览器 → Caddy（80/443、HTTPS、WebSocket）→ Node.js（127.0.0.1:3000）→ SQLite。单进程运行，不要启动多个实例共用同一个数据库。

## 首次安装

服务器使用 Node.js 24 LTS、Caddy、git 和 sqlite3。Node.js 按 [NodeSource 说明](https://github.com/nodesource/distributions) 安装 24.x，Caddy 按[官方 Ubuntu 安装说明](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装，再运行 `apt-get install -y git sqlite3`。

先将代码提交并推送到 GitHub `main`。服务器运行 `git clone --branch main --single-branch https://github.com/KuaiSuMi/dianque.git /opt/dianque`，进入该目录执行 `npm ci`、`npm test`、`npm run build`。不要上传 Windows 的 node_modules、私钥、本地数据库或环境文件。

服务器以 root 执行：

```sh
useradd --system --home /var/lib/dianque --shell /usr/sbin/nologin dianque
cd /opt/dianque
npm ci --omit=dev --no-fund --no-audit
install -d -m 700 /var/backups/dianque
install -m 600 deploy/dianque.env.example /etc/dianque.env
install -m 644 deploy/dianque.service deploy/dianque-backup.service deploy/dianque-backup.timer /etc/systemd/system/
```

编辑 `/etc/dianque.env`，将 `PUBLIC_ORIGIN` 改成实际完整网址，不含末尾斜杠；例如 `https://mj.example.com`。它用于校验跨站操作和签发 Secure Cookie，必须与浏览器地址栏一致。首次启动创建空数据库，不导入旧平台数据。

```sh
systemctl daemon-reload
systemctl enable --now dianque dianque-backup.timer
curl -fsS http://127.0.0.1:3000/api/health
```

## 域名与 HTTPS

中国内地 ECS 对外提供网站服务需完成备案并接入阿里云，见[阿里云说明](https://help.aliyun.com/zh/icp-filing/what-scenarios-need-to-be-filed-in-aliyun)。上线前确认域名后缀和注册商支持备案；尚未备案时通过 SSH 隧道做内部测试。

1. 在域名 DNS 控制台添加 A 记录，根域名使用主机记录 `@`，记录值为 ECS 公网 IPv4；删除冲突的旧 A/AAAA/CNAME 记录前先确认用途。
2. ECS 安全组放行 TCP 80 和 443；应用端口 3000 无须对外开放。22 端口仅向管理者来源开放。
3. 将 `deploy/Caddyfile` 中的域名改成实际域名，保存到 `/etc/caddy/Caddyfile`。
4. 执行下面命令。Caddy 会申请和续期证书，DNS 和公网端口必须已生效。

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
curl -fsS https://mj.example.com/api/health
```

内部测试可从本机运行 `ssh -N -L 3000:127.0.0.1:3000 root@服务器IP`，并将测试期间的 `PUBLIC_ORIGIN` 设为 `http://localhost:3000`，重启应用后访问本机 `http://localhost:3000`。正式上线改回 HTTPS 域名。HTTP 测试不要使用与其他网站相同的密码。

## 使用公网 IP

IP 入口使用 `deploy/Caddyfile.ip`，当前地址为 `47.94.42.14`；换服务器时同时修改配置中的两处 IP。它通过 Let's Encrypt 的 `shortlived` profile 申请 IP 证书，Caddy 自动续期，浏览器无须安装自签名证书。参见 [Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)。

先在 ECS 安全组放行 TCP 80、443，授权对象为 `0.0.0.0/0`。将 `/etc/dianque.env` 中的 `PUBLIC_ORIGIN` 设置为 `https://47.94.42.14`，将上述 Caddyfile 安装到 `/etc/caddy/Caddyfile`，校验配置后重启应用、重载 Caddy。证书自动签发成功后，通过 `https://47.94.42.14` 访问；HTTP 自动跳转 HTTPS，应用端口 3000 保持回环监听。

中国内地服务器的备案要求也适用于 IP 网站访问，见[阿里云说明](https://help.aliyun.com/zh/ecs/support/what-do-i-do-if-i-cannot-access-a-website-hosted-on-an-instance)。

## 管理员

先在网站注册自己的账号，再在服务器查询 ID：

```sh
sqlite3 /var/lib/dianque/dianque.sqlite 'SELECT id,nickname FROM users;'
```

将目标 ID 填入 `/etc/dianque.env` 的 `ADMIN_USER_ID`，执行 `systemctl restart dianque`。管理员权限不取决于昵称，不要将真实 ID 或凭据写入仓库。

## 更新与排查

在本机仓库目录提交、推送后部署：

```sh
git add <本次修改的文件>
git commit -m "说明本次修改"
git push origin main
npm run deploy
```

需要本机已配置服务器 SSH 密钥，以及 Node.js、npm、git、ssh（当前 Windows 已具备）；服务器需要能访问 GitHub 和 npm。脚本先要求工作区干净、当前提交与 GitHub `main` 一致，未提交或未推送的内容会阻止部署。若代码由其他电脑推送，先保存本机修改，再 `git pull --ff-only` 后部署。

部署脚本也从 GitHub 获取，服务器在新目录拉取同一个完整提交 ID，安装锁定依赖、运行测试和构建，移除开发依赖；以应用用户启动内存数据库检查页面和接口，再备份数据库并切换版本。准备期间旧服务继续运行，任何准备失败都会停止发布。切换只需短暂重启，正在打开的页面会重新连接；部署时尽量避开对局操作。

账号和对局保存在 `/var/lib/dianque/`，环境配置、管理员、域名和 HTTPS 配置保存在 `/etc/`，更新程序不会覆盖它们。上一版程序保留在 `/opt/dianque.previous`，上线健康检查失败时自动恢复上一版程序；数据库不会自动倒回旧备份。涉及数据库结构或数据语义的改动需单独安排发布和恢复。

当前部署目标为 `root@47.94.42.14`，公网检查地址为 `https://47.94.42.14`，均在 `deploy/deploy.mjs` 顶部。以后切换域名或服务器时同步修改对应值。

部署输出会显示完整提交 ID；在服务器执行 `git -C /opt/dianque rev-parse HEAD` 可查看线上版本。GitHub 推送本身不会触发部署，推送后执行 `npm run deploy`。

查看日志：`journalctl -u dianque -u caddy -n 100 --no-pager`。此命令更新应用代码；若修改了 systemd 单元或 Caddy 配置，需按前文安装相应配置、校验并重载服务。前端由同一应用提供，API 和 WebSocket 不需要额外域名或跨域配置。

## 备份与恢复

`dianque-backup.timer` 每天服务器时间 04:00 附近运行一次，SQLite 在线备份保存在 `/var/backups/dianque/`，校验通过后清理超过 14 天的备份。`systemctl list-timers dianque-backup.timer` 查看下一次时间。

备份与原数据库在同一块磁盘，不能防止整机或磁盘丢失；定期下载备份到另一台设备。不要直接复制运行中的 `.sqlite` 文件，以免遗漏 WAL 中的数据。

恢复会覆盖当前数据，先确认备份文件和停服时间，然后运行：

```sh
systemctl stop dianque
sqlite3 /var/lib/dianque/dianque.sqlite ".restore '/var/backups/dianque/所选备份.sqlite'"
chown dianque:dianque /var/lib/dianque/dianque.sqlite*
systemctl start dianque
curl -fsS http://127.0.0.1:3000/api/health
```
