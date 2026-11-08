# 扩展 3.3.0

跟随安卓端 3.3.0 的元数据同步版，**没有功能改动**。

## 变更

- `manifest.json` 版本号 3.2.0 → 3.3.0。
- 扩展页「下载安卓端」入口改指向 `android-v3.3.0` / `todo-link-3.3.0.apk`，说明链接同步，APK 体积更新为 286,768 字节。
- 文件传输测试用例里模拟设备的 `appVersion` 同步为 3.3.0。

## 兼容性

- 同步协议不变（`PROTO 2`），服务端接口与 3.2.0 完全一致；旧版手机端可继续配对使用。
- AI 历史对话只存在手机本地，不经过扩展、不同步到电脑。

## 验证

```
cd extensions/todo-relay
node tests/files.mjs         # 37 项
node tests/e2e.mjs           # 41 项
node tests/security.mjs      # 28 项
node _tools/pack-extension.mjs --check
```

## 产物

- `com.zhou.todo-relay-3.3.0.zip`，93,068 字节
- SHA-256 `9531c67e3a3ef27c980e7826fbc813c96f9fbb458c92fa6c229e864fd47dc1b2`
