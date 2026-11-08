# 扩展 3.1.0

新增文件传输自定义保存位置。

## 新增

- **文件保存位置**：文件面板新增「保存到」设置，可指定自定义目录，手机发来的文件落到该目录；也可一键恢复默认收件箱。
- 服务端 `/api/local/files/savedir`（GET/POST），保存目录持久化在 `.data/files/save-dir.txt`。

## 兼容性

- 扩展 `3.0.0 → 3.1.0`，同步协议不变（`PROTO 2`）。
- 未设置时默认收件箱，与旧版行为完全一致。

## 验证

```
cd extensions/todo-relay
node tests/files.mjs         # 37 项
node tests/e2e.mjs           # 41 项
node tests/security.mjs      # 28 项
```

## 产物

- `com.zhou.todo-relay-3.1.0.zip`，93,067 字节
- SHA-256 `9038a1c406c042ad376c1b82a1d97bf1d11f10dade283b620bfe08844ab5bcc7`
