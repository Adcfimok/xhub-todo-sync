# 待办同步（todo-relay）

x-hub 的 LAN 同步中枢：把桌面端的待办 / 笔记 / 便签 / 速达 / 提示词同步到安卓，
并给手机端提供扩展宿主与 AI 中转。

- 扩展 id：`com.zhou.todo-relay`
- 运行时：`service`（Node 后端）　形态：`module` + `view`
- 监听：`0.0.0.0:47821`　协议：`proto 2`

## 结构

```
manifest.json
icon.svg
module/index.html        工作台卡片（紧凑 / 标准，纯容器查询自适应）
view/index.html          管理页：配对、设备、五类内容、冲突
view/app.js              页面逻辑 + 宿主桥接（五类 ingest / outbound）+ 扩展桥代答
view/view.css
view/vendor/qrcode.js    二维码生成（MIT）
service/index.js         HTTP 路由、SSE、鉴权、扩展宿主、AI 中转
service/store.js         多集合状态、持久化、LWW 合并、宿主镜像
service/hlc.js           混合逻辑时钟
tests/e2e.mjs            39 项端到端断言
```

## 接口

| 路径 | 用途 |
|---|---|
| `/api/v1/ping` | 连通性、协议版本、集合列表 |
| `/api/v1/pair` | 6 位码换令牌 |
| `/api/v1/snapshot?cols=` | 全量（可按集合过滤） |
| `/api/v1/sync` | 推 + 拉一轮 |
| `/api/v1/stream` | SSE 变更通知 |
| `/api/local/ingest` | 本机页面推宿主快照（`{col, records, full}`） |
| `/api/local/outbound` · `/ack` | 远端改动回写宿主 |
| `/api/local/bridge/*` | 扩展 `data.*` 桥接信箱（页面轮询代答） |
| `/api/ai/chat` | AI 转发（SSE 透传） |
| `/ext/list` · `/ext/r/<token>/<id>/…` | 扩展宿主（静态资源 + 桥垫片） |

## 数据放哪

- 中枢状态：`.data/hub.json`（原子写入、400ms 防抖）
- 扩展 KV：`.data/kv.json`
- 后端日志：`<数据根>/logs/service/com.zhou.todo-relay.log`

## 自检

```bash
node tests/e2e.mjs
```
