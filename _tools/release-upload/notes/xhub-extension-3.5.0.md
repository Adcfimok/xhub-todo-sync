# 扩展 3.5.0

跟随安卓端 3.5.0 的元数据同步版，**没有功能改动**。

## 变更

- `manifest.json` 版本号 3.4.0 → 3.5.0。
- 扩展页「下载安卓端」入口改指向 `android-v3.5.0` / `todo-link-3.5.0.apk`，说明链接同步，APK 体积更新为 377,027 字节。
- 文件传输测试用例里模拟设备的 `appVersion` 同步为 3.5.0。

## 兼容性

- 同步协议不变（`PROTO 2`），五个集合与服务端接口和 3.4.0 完全一致；旧版手机端可继续配对使用。
- 手机端新拆出的「手机应用」只存在手机本地，不进 `resources` 集合、不同步到电脑，因此扩展看不到也不会改写这部分数据。

## 验证

```
cd extensions/todo-relay
node tests/files.mjs         # 37 项
node tests/e2e.mjs           # 41 项
node tests/security.mjs      # 28 项
node _tools/pack-extension.mjs --check
```

## 产物

- `com.zhou.todo-relay-3.5.0.zip`，93,068 字节
- SHA-256 `26c8a5e113a833b95c7ff5cbcaea2a38c2080eff6932f96c7b93b5972cc0dc56`
