---
title: 指纹到漏洞的匹配流程
cve: 无
severity: info
cvss: 0
product: 方法论
ports: 任意
keywords: fingerprint, recon, mapping, version
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 1. 先分资产类型（决定后面查哪一类）

| 观测 | 资产类型 | 首查分类 |
|---|---|---|
| 7001 / `WebLogic` | Java 中间件 | `kb-java-deser` |
| `X-Confluence-*` / `X-Jenkins` / `GitLab` | Java Web / CI | `kb-java-web` |
| 8090/8111/8983 且 Java 技术栈 | 同上 | `kb-java-web` |
| `GlobalProtect` / `Citrix Gateway` / `FortiGate` / `BIG-IP` | 边界设备 | `kb-edge-device` |
| `/owa/` `/ecp/` `/autodiscover/` | Exchange | `kb-exchange-ad` |
| 445 + 域控 / 88 开放 | AD | `kb-exchange-ad` |
| `X-Powered-By: PHP` / Drupal / ThinkPHP | PHP 站点 | `kb-web-cms` |
| 低权 shell / 容器内 | 提权 | `kb-linux-priv` |
| 2375 / 6379 / 5432 / 8848 / 6443 / 10250 | 云原生与中间件 | `kb-cloud-container` |

## 2. 取版本（按可靠性排序）

1. 应用自报：`/version`、`/api/v1/version`、`X-Jenkins`、`X-OWA-Version`、`X-FEServer`、`X-Generator`、`Server`。
2. 静态资源指纹：`/static/js/...` 的 hash、`CHANGELOG.txt`、`/core/CHANGELOG.txt`、`/help`、`/login.action` 页脚。
3. 报错差异：非法参数触发的堆栈、`Whitelabel Error Page`、`Ignition` 页面。
4. 端口/协议：`nmap -sV` 的 banner（对自研中间件常常不准，只作参考）。

## 3. 映射到条目

- 用 `name` 里的产品名 + `versions` 区间做核对；区间不覆盖就换条目或记为「未见该组件」。
- 同一资产可能命中多条（如 Exchange 2019 同时有 ProxyLogon / ProxyShell / 0-day 面），按**影响面 × 可验证性**排序。

## 4. 常见误判

- 反代/网关改写响应头 → 版本看起来是网关的。
- 容器镜像版本 ≠ 应用版本（`Server: nginx` 后面可能是 Tomcat）。
- WAF 返回的 403/200 空页被当成"漏洞不存在"；用不同路径/参数再验一次。
- CDN 缓存把 `/version` 缓存成旧值。
