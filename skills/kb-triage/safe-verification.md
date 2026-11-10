---
title: PoC 安全验证与取证规范
cve: 无
severity: info
cvss: 0
product: 方法论
ports: 任意
keywords: verification, evidence, safety, cleanup
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 授权前置（写报告时要点名）

- 目标清单与时间窗，谁批的、批到哪一步（只读 / 验证 / 利用）。
- 影响面：单机、单实例、共享数据库、边界设备（一旦崩影响整条链路）。

## 分级验证动作（从轻到重，能用轻的就不用重的）

| 级别 | 动作 | 例子 |
|---|---|---|
| L1 只读 | 读版本、读配置、未授权 GET | `/actuator/env`、`redis-cli INFO`、`/nacos/v1/auth/users` |
| L2 探测 | 发送无害 payload 看回显/DNS | `${jndi:dns://token}`、`id` 命令、DNSLog |
| L3 利用 | 写文件、反连、加账号 | 写 JSP、加管理员、加载模块 |
| L4 落地 | 持久化、横向 | 计划任务、黄金票据、改配置 |

**默认停在 L2**，除非授权明确到 L3/L4。

## 证据清单（每一条都要留）

- 请求原文（含完整 header 与 body）+ 响应原文（状态码、关键回显）。
- 时间戳与时区、源 IP、目标 IP:端口。
- 版本证据（一条命令 + 输出）。
- L3 及以上：写入文件的路径与内容摘要、进程树、反连记录、清理前后对比。

## 高危动作的自我保护

- 内核 exploit（nf_tables / overlayfs）：先同类实验机跑通，记录 panic 概率；生产上先申请窗口。
- 域控相关（Zerologon / noPac）：**会改机器账号或目录属性**，先准备恢复脚本。
- 边界设备：先确认是否在业务链路上，改策略/删证书类动作最后做。
- 反连一律用一次性监听端口，事后关掉；避免把攻击机暴露在目标网段。

## 清理清单

1. 删除写入的 webshell / 计划任务 / SUID 文件 / 新增账号。
2. 恢复被改的配置（OAB、`params.resource.loader`、`session.auto_start`、`pipeline.first.*`）。
3. 撤销自己创建的 token、临时 ServiceAccount、API Key。
4. 在报告里记录清理动作与时间，便于客户复核。
