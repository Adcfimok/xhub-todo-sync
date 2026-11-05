# 构建工具链（第三方二进制，未随仓库分发）

`android/build.sh` 用这套工具链手工构建 APK（aapt2 → javac → d8 → zipalign → apksigner，不依赖 Gradle）。
目录约定：

| 路径 | 内容 | 获取方式 |
|---|---|---|
| `jdk-17*` | JDK 17（含 `bin/javac.exe`） | Eclipse Temurin JDK 17 Windows x64 压缩包，解压后目录名保持 `jdk-<版本>` |
| `android-14/` | Android SDK build-tools 34：`aapt2.exe`、`d8.bat`、`zipalign.exe`、`apksigner.bat` 及依赖库 | `sdkmanager "build-tools;34.0.0"`，把内容复制到本目录 |
| `android-12/` | Android SDK platform：`android.jar`、`framework.aidl` 等 | `sdkmanager "platforms;android-31"`，把内容复制到本目录 |

三者合计约 565 MB，其中 `jdk/lib/modules` 单文件 129 MB，超过 GitHub 单文件 100 MB 的硬上限，
且当前网络环境下大文件 HTTPS 通道不可用，因此没有纳入仓库。

补齐后执行：

```bash
cd android && bash build.sh        # 产物：android/todo-link-2.8.0.apk
```

仓库内的 `dist/*.zip` 与 `android/*.apk` 是已构建好的成品，可直接使用，不依赖这套工具链。
签名密钥库 `android/todolink.jks` 已入库（仓库为私有），请勿公开；丢失后新版 APK 无法覆盖安装旧版。
