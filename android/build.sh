#!/usr/bin/env bash
# 手动构建 APK（不依赖 Gradle）：aapt2 → javac → d8 → zip → zipalign → apksigner
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -W)"
TC="$ROOT/../_toolchain"
BT="$TC/android-14"
PLATFORM="$TC/android-12/android.jar"
JDK="$(ls -d "$TC"/jdk-* | head -1)"
SRC="$ROOT/app/src/main"
OUT="$ROOT/build"
KS="$ROOT/todolink.jks"
KS_PASS="todolink2026"
KS_ALIAS="todolink"

export JAVA_HOME="$JDK"
export PATH="$(cygpath -u "$JDK/bin"):$PATH"

APP_ID="com.zhou.todolink"
VER_NAME="3.8.0"
VER_CODE="33"

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "[1/7] 编译资源"
"$BT/aapt2.exe" compile --dir "$SRC/res" -o "$OUT/res.zip"

echo "[2/7] 链接资源与清单"
"$BT/aapt2.exe" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$SRC/AndroidManifest.xml" \
  -A "$SRC/assets" \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 32 \
  --version-code "$VER_CODE" \
  --version-name "$VER_NAME" \
  --auto-add-overlay \
  "$OUT/res.zip"

echo "[3/7] 编译 Java"
find "$SRC/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -source 8 -target 8 -encoding UTF-8 -nowarn \
  -classpath "$PLATFORM" \
  -d "$OUT/classes" \
  @"$OUT/sources.txt"

echo "[4/7] dex"
"$BT/d8.bat" --release --min-api 24 --lib "$PLATFORM" \
  --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

echo "[5/7] 打包"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
python - "$OUT/unsigned.apk" "$OUT/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY

echo "[6/7] 对齐"
"$BT/zipalign.exe" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[7/7] 签名"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Todo Link, O=zhou, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner.bat" sign --ks "$KS" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$ROOT/todo-link-$VER_NAME.apk" "$OUT/aligned.apk"

"$BT/apksigner.bat" verify --print-certs "$ROOT/todo-link-$VER_NAME.apk" | head -4
ls -la "$ROOT/todo-link-$VER_NAME.apk"
echo "OK → $ROOT/todo-link-$VER_NAME.apk"
