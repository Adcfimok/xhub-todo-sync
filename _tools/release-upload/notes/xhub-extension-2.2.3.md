# 扩展 2.2.3

只做一件事：让待办的「提醒提前量」能跨设备同步。

## 改动

- `service/store.js` 的 `todos` 归一化新增 `remindLead`：`-1` 关闭、`0` 准时、正数 = 提前分钟；`>525600`（一年）按一年钳制。
- 同一处 `fromHostRow` 增加 `remindLead` / `remind_lead` 的读取，PC 端行导入不会把它丢掉。
- `remindAt`（绝对时刻）沿用 2.2.2 的字段，两字段配合：预设走 `remindLead`，自定义时刻走 `remindAt`。

## 为什么不能只存在手机本地

提醒设置属于用户数据，重装或换机后要能恢复；只在本地存 `remindLead`，一旦重新配对就会被服务端归一化掉，用户会看到「提醒设置莫名消失」。

## 兼容性

- 老版本扩展不认这个字段会丢弃它，但不会报错；手机端仍按本地记录提醒。
- 反向兼容：没有 `remindLead` 的老记录，手机端继续按「提前 15 分钟」处理。

## 验证

```
cd extensions/todo-relay
node tests/e2e.mjs        # 41 项
node tests/security.mjs   # 28 项
node --experimental-default-type=module --test android/tests/remind.test.mjs   # 含服务端字段保留断言
```

## 产物

- `com.zhou.todo-relay-2.2.3.zip`，73,175 字节，14 个文件
- SHA-256 `8e4cb176b0668ebd98f59384dc2fa3a1160dc3a59b1fd36d8342a3b9eda9428d`
