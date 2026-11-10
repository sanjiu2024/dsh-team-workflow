---
title: 源站 IP 泄露 → 绕过 WAF 直打（博彩站必看）
cve: 无（架构缺陷）
severity: critical
cvss: 9.0
product: 任何套 CDN/WAF 的站点
versions: 任意
ports: 80, 443, 8080
keywords: 源站, cdn, waf, 绕过, 真实ip, 回源
entry: 子域/邮件头/证书历史/SSRF 泄露的 origin
verified: false
sources: 公开资料整理（信息收集方法）
---

## 指纹

- 主站响应头有 `server: cloudflare` / `x-cache` / `cf-ray`；
- 同一 IP 段上跑着多个业务域。

## 前置条件

- 目标套了 CDN/WAF，且源站未做回源 ACL。

## PoC

```bash
# 1) 证书透明度 + 历史 DNS 找真实 IP
curl -s "https://crt.sh/?q=%25.target.com&output=json" | jq -r '.[].name_value' | sort -u
dig +short mail.target.com            # 邮件服务器常直连源站
dig +short ftp.target.com cpanel.target.com direct.target.com

# 2) 用 shodan/fofa 语法找同 body 指纹的其他 IP
#   http.title:"包网" 或 body:"<同一段唯一 JS 路径>"
```

```bash
# 3) 直连候选 IP，比对页面特征（Host 头保留域名）
for ip in 1.2.3.4 5.6.7.8; do
  echo "== $ip"; curl -sk -H "Host: target.com" "https://$ip/" -o /dev/null -w '%{http_code} %{size_download}\n'
done
# 判定：200 且与 CDN 回包大小接近 = 命中源站；403/超时 = 有回源 ACL
```

## 利用步骤

1. 先跑第 1 步（被动，不触碰目标）；
2. 拿到候选 IP 逐个比对（第 3 步），确认源站；
3. 直连源站后重跑前面的漏洞条目——WAF 规则通常不覆盖源站；
4. 证据：CDN 与源站两条响应的差异（大小/头）。

## 修复与缓解

- 源站只允许 CDN 回源 IP；禁止子域直连；邮件/面板走独立 IP。
- 定期用第三方视角自查真实 IP 暴露面。

## 参考

- 公开信息收集方法（crt.sh / SecurityTrails / FOFA）。
