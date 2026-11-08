# 扩展 3.4.0

跟随安卓端 3.4.0 的元数据同步版，**没有功能改动**。

## 变更

- `manifest.json` 版本号 3.3.0 → 3.4.0。
- 扩展页「下载安卓端」入口改指向 `android-v3.4.0` / `todo-link-3.4.0.apk`，说明链接同步，APK 体积更新为 368,759 字节。
- 文件传输测试用例里模拟设备的 `appVersion` 同步为 3.4.0。

## 兼容性

- 同步协议不变（`PROTO 2`），服务端接口与 3.3.0 完全一致；旧版手机端可继续配对使用。
- 学校列表只内置在安卓端，扩展不加载、不分发这份数据。

## 验证

```
cd extensions/todo-relay
node tests/files.mjs         # 37 项
node tests/e2e.mjs           # 41 项
node tests/security.mjs      # 28 项
node _tools/pack-extension.mjs --check
```

## 产物

- `com.zhou.todo-relay-3.4.0.zip`，93,068 字节
- SHA-256 `8995aa155753d8bb029ebd83eabcfff11f171ac802df92baa97b01ce2e915972`
