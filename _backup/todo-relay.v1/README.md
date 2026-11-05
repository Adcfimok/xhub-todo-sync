# 待办同步（todo-relay）

把 x-hub 工作台的待办同步到安卓手机：局域网直连、离线可改、恢复后自动合并。

- 扩展 id：`com.zhou.todo-relay`
- 运行时：`service`（Node 后端）
- 形态：`module`（工作台卡片）+ `view`（管理页）
- 监听：`0.0.0.0:47821`

## 结构

```
manifest.json
icon.svg
module/index.html        工作台卡片（紧凑 / 标准两种形态，纯容器查询自适应）
view/index.html          管理页：配对、设备、待办、冲突
view/app.js              页面逻辑 + 宿主桥接（ingest / outbound）
view/view.css
view/vendor/qrcode.js    二维码生成（MIT，Kazuhiko Arase）
service/index.js         HTTP 路由、SSE、鉴权
service/store.js         状态、持久化、LWW 合并、宿主镜像
service/hlc.js           混合逻辑时钟
tests/e2e.mjs            28 项端到端断言（spawn 真实进程）
```

## 安装

1. x-hub → 扩展中心 →「我的扩展」→ 添加本目录（须含 `manifest.json`）。
2. 授权 `data:read` / `data:write` / `network` / `notify`。
3. 打开扩展整页，记下地址与 6 位配对码。

> 后端改了代码要**重启后端**才生效（常驻实例右键图标 →「重启后端」）。

## 数据放哪

- 中枢状态：`.data/hub.json`（原子写入，400ms 防抖）
- 后端日志：`<数据根>/logs/service/com.zhou.todo-relay.log`

## 关键设计

| 决定 | 理由 |
|---|---|
| 中枢持有权威变更日志 | 手机与 PC 都是对等客户端，冲突判定只有一处 |
| HLC 而不是服务器时间 | 离线期间的多次编辑必须能定序 |
| 记录级 LWW | 宿主 `update` 全量覆盖 + 无历史版本，字段级合并不成立 |
| 墓碑保 30 天 | 防「删了又复活」，同时限制体积 |
| SSE 而不是 WebSocket | 单向推送够用，手写帧解析没有必要 |

## 自检

```bash
node tests/e2e.mjs
```
