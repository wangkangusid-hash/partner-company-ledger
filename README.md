# 合伙公司记账

一个可在线同步的轻量记账软件。网页和同步接口由同一个 `server.js` 提供，所有设备访问同一个服务器地址时，会读写同一份账本数据。

## 本机启动

```bash
cd /Users/wangkang/Documents/Codex/2026-05-18/new-chat
LEDGER_PASSWORD=你的访问密码 node server.js
```

启动后电脑打开：

```text
http://127.0.0.1:5173
```

手机和电脑连接同一个 Wi-Fi 后，先查电脑局域网 IP：

```bash
ipconfig getifaddr en0
```

假设输出是 `192.168.1.23`，手机打开：

```text
http://192.168.1.23:5173
```

## 公网部署

把整个文件夹上传到支持 Node.js 的服务器或平台，启动命令：

```bash
node server.js
```

建议设置环境变量：

```text
LEDGER_PASSWORD=你的访问密码
PORT=平台提供的端口
```

重要：账本保存在服务器的 `data/ledger.json`。如果部署平台的文件系统会在重启或重新部署后清空，请选择带持久磁盘的服务，或部署在自己的 VPS 上。

### Render 快速部署

1. 把本文件夹上传到一个 GitHub 仓库。
2. 打开 Render，选择 New Web Service。
3. 连接这个 GitHub 仓库。
4. Render 会读取 `render.yaml`。
5. 部署完成后，在 Render 的 Environment 页面查看自动生成的 `LEDGER_PASSWORD`。

注意：Render 免费 Web Service 的本地文件不适合作为长期唯一数据源。正式长期使用时，建议换成持久数据库或带持久磁盘的服务。

## 数据备份

页面右上角可以导出 JSON 备份，也可以导入 JSON 覆盖同步账本。图片凭证会一起包含在导出的文件里。
