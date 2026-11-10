---
title: 接口越权 / BOLA（读他人订单、流水、提现）
cve: 无（业务逻辑）
severity: high
cvss: 8.1
product: 自研 API（博彩/代理/跑分平台高发）
versions: 任意
ports: 80, 443
keywords: idor, bola, 越权, 水平越权, orderNo, uid, 代理后台
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

接口形如（抓包即可见）：

```
/api/user/info?uid=10086        /api/order/detail?orderNo=20241105001
/api/wallet/bill?userId=...     /api/agent/member/list?agentId=...
/api/withdraw/detail?id=...     /api/bet/record?memberId=...
```

响应体里带自增 id、手机号、余额、流水号 —— 这些字段本身就是"别人的数据"的入口。这类站点的权限判断常写在前端（菜单隐藏/按钮禁用），后端只校验"登录了没"。

## 前置条件

- **两个**普通账号（A、B；这类站点注册门槛低，常有试玩/体验号）——只用一个账号无法证明越权，见下方"两账号对照"。
- 能抓到自己的请求（App 用抓包代理 + 证书，H5 直接看）。

## PoC

```http
# 账号 A 的 token，请求账号 B 的资源
GET /api/order/detail?orderNo=20241105001234 HTTP/1.1
Host: target
Authorization: Bearer <A 的 token>
```

判定三档：返回他人完整数据（成立）→ 返回 200 但字段被裁剪（部分成立）→ 403/404（不成立）。**两账号对照**是唯一可靠的证据。

## 利用步骤

1. 用 A、B 两个账号各下一单，抓两条请求，确认参数差异只在 id。
2. A 的 token + B 的 id → 看是否读出 B 的手机号/余额/流水；成立后换高危接口：提现审核、佣金比例、代理层级。
3. 枚举：`orderNo` 常是"日期+自增"或 6-10 位纯数字，用低速率脚本抽样（这类站有设备指纹 + IP 频控，别用并发）。
4. 垂直越权：拿普通账号 token 打 `/api/admin/*`、`/api/agent/*`，很多站只在前端隐藏菜单。
5. 证据：两账号各自的请求+响应、时间戳；不要批量导出会员数据。

## 修复与缓解（加固）

- 服务端以 session/JWT 里的 `uid` 为准，忽略请求里的 `uid`；资源级鉴权（owner check）。
- 订单号用 UUID/带签名的不透明 ID，禁止顺序可枚举。
- 未授权访问统一返回 404/403，避免"200 + 空对象"暴露存在性。
- 代理层级在服务端做"上级链校验"，不接受客户端传 `agentId`。

## 参考

- OWASP API Security Top 10：API1 BOLA、API5 BFLA。
