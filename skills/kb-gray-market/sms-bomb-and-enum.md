---
title: 短信轰炸与账号枚举（验证码面）
cve: 无（业务逻辑）
severity: medium
cvss: 5.3
product: 自研注册/登录/找回接口
versions: 任意
ports: 80, 443
keywords: sms, 轰炸, 枚举, 验证码爆破, 频控, user enumeration
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

- `/api/sms/send`、`/api/user/register`、`/api/user/findpwd`、`/api/login`（图形/短信验证码）；
- 返回文案差异：`该手机号已注册` / `用户不存在` / `验证码已发送`。

## 前置条件

- 无需账号（发送接口通常匿名可调）。

## PoC

```http
### 1) 频控测试：同一号码连发
POST /api/sms/send HTTP/1.1
Content-Type: application/json

{"phone":"13800138000","type":"register"}

### 2) 绕频控（常见三种）
- 换 X-Forwarded-For / X-Real-IP（服务端按 IP 计数时有效）
- 手机号变形：+86、空格、前导 0、Unicode 数字
- 换 type：register / login / findpwd / bind 各自独立计数

### 3) 枚举：注册接口的文案差异
POST /api/user/register {"phone":"13800138000"}  → "已注册"
POST /api/user/register {"phone":"13800138001"}  → "可注册"

### 4) 验证码爆破：4 位、无次数限制、无过期
POST /api/login {"phone":"...","code":"0000"}  → 循环至 9999
```

## 利用步骤

1. 测频控三维：同号码间隔、同 IP 总量、同设备（有 `deviceId` 更好）。
2. 测验证码：位数、有效期、错误次数上限、是否与手机号绑定（拿 A 的 code 打 B）。
3. 枚举：拿文案/状态码差异批量判定号码存在性（限速 + 去重，只抽样即可证明）。
4. 组合：枚举出已注册号码 → 弱口令/撞库（这类站点常有 6 位纯数字密码）→ 验证码爆破兜底。
5. 证据只留 2-3 条请求；报告里别贴号码库。

## 修复与缓解（加固）

- 图形/行为验证（滑块）前置；按"手机号 + IP + 设备 + 类型"四维频控，超限静默丢弃。
- 验证码 6 位、5 分钟、5 次上限、一次性；绑定手机号与会话。
- 注册/找回/登录统一文案（"若号码存在将发送验证码"），不泄露存在性。
- 短信通道侧限速与费用告警（轰炸的直接损失是短信费）。

## 参考

- OWASP WSTG-IDNT-04（账号枚举）；OWASP Authentication Cheat Sheet。
