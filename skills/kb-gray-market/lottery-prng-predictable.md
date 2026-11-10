---
title: 开奖结果可预测（弱 PRNG / 客户端算法 / 固定种子）
cve: 无（实现缺陷）
severity: critical
cvss: 9.1
product: 自营彩票 / 快三 / 28 类玩法
versions: 任意
ports: 80, 443
keywords: lottery, prng, 开奖, 可预测, 种子, 快三, 时时彩
entry: 历史期号统计 + 前端 JS 算法复现
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

- 接口：`/api/lottery/history?issue=`、`/api/lottery/next`、`/api/bet/result`；
- 前端 bundle 里有开奖计算（`Math.random`、`Math.floor(...*10)`、自研洗牌）；
- 服务端下期接口返回 `seed`/`hash` 或 `openTime` 可推算。

## 前置条件

- 授权环境；历史期号通常公开可拉（无需登录），**至少 100 期**。

## PoC

```bash
# 1) 拉历史，做分布与相邻期相关性
curl -s 'https://target/api/lottery/history?pageSize=200' > hist.json
python3 - <<'PY'
import json
from math import comb
d=json.load(open("hist.json"))["data"]
nums=[x["result"] for x in d]; n=len(nums)
K=2      # 值域按玩法定：押大小 K=2；快三和值 K=14；押单号 K=10。别用样本 distinct 当 K（会低估 K、抬高基线）
M=int(input("事前登记的命中期数 M = ")); N=int(input("登记的预测总期数 N = "))
p0=1/K
p=sum(comb(N,i)*p0**i*(1-p0)**(N-i) for i in range(M, N+1))
print(f"n={n} K={K} M/N={M}/{N} baseline={p0:.3f} p={p:.6f} -> " + ("显著" if p<0.01 else "不显著"))
PY

# 2) 找前端算法
npx source-map-explorer app.js.map 2>/dev/null | head
grep -o 'Math\.random[^;]*' app.js | head
```

## 利用步骤

1. 拿 ≥100 期历史做基础统计：取值域 `k`、相邻期相同数、与 `openTime` 的相关性。
2. **随机基线**：均匀独立时单期命中概率 ≈ `1/k`；把"预测命中率"与 `1/k` 比，`n≥100` 且二项检验 `p<0.01` 才算显著，别用"看着像"下结论。
3. 前端 JS/sourcemap 找算法；若用 `Date.now()`、固定 `seed`、或"下期 seed = md5(上期 + 时间)"，抓两期即可推导。
4. **时序要求**：把预测**登记在开奖之前**（截图/文本 + 时间戳 + 期号），再对开奖结果；事后拟合不算证据。
5. 判定两档：
   - ① 前端算法与开奖结果逐期完全一致（可硬判 `N/N`）；
   - ② 事前登记预测，命中 `M/N` 显著高于 `1/k`（`p<0.01`）。
6. 只在授权环境小额验证；报告写"可预测 ⇒ 资金面无上限"，不真下注套利。

## 修复与缓解（加固）

- 服务端 CSPRNG（`crypto.randomInt`）+ 第三方可信开奖源；
- commit-reveal：开奖前公布 `hash(seed)`，开奖后公布 `seed`，可验证不可预测；
- 算法与种子不下发前端；期号与结果分离审计。

## 参考

- OWASP Top 10 A02 Cryptographic Failures；可证明公平（provably fair）实现范式。
