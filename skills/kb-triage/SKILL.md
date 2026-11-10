---
name: kb-triage
description: 取数之后怎么分诊：认资产 → 指纹 → 版本 → 匹配 → 最小验证 → 利用 → 取证 → 清理，含报告模板。
verified: false
sources: 公开资料整理（CVE 公告 / 公开分析 / 业务逻辑类；出处见各条参考）
---

# 工作方法（3 条）
> 条目为公开资料整理（出处见文末「参考」），`利用步骤` 属待验证假设；出报告前按目标版本自验并把 `verified` 置为 true。

先用这一页定流程，再按目标类型翻具体分类。顺序：**认资产 → 指纹 → 版本 → 匹配 → 最小验证 → 利用 → 取证 → 清理**。

## 条目

| 文件 | 漏洞 | 严重度 | 入口 |
|---|---|---|---|
| `fingerprint-workflow.md` | 指纹到漏洞的匹配流程 | info | - |
| `report-template.md` | 漏洞报告模板 | info | - |
| `safe-verification.md` | PoC 安全验证与取证规范 | info | - |

## 三条铁律

1. **版本对不上就不下结论**：PoC 打过去没反应，可能是补丁、可能是 WAF、可能是版本不在区间——三者要分开写。
2. **先只读后写入**：未授权判定优先用 `GET /version`、`INFO`、`/actuator`、配置读取；写入型 PoC（写马、改配置）放到有授权的第二步。
3. **每条结论都要有可复现的最小证据**：一条命令 + 一段原始响应（截图不算，要文本）。

## 严重度 / CVSS 分档规则（本库统一口径）

| 情况 | severity | cvss 参考 |
|---|---|---|
| 无鉴权 RCE / 域或设备接管 / 资金面（可影响余额或资金状态） | critical | 9.0-10.0 |
| 需低权 RCE / 任意文件读 / 越权读敏感数据 / 凭据泄露 | high | 7.0-8.9 |
| 需特定条件的信息泄露 / 枚举 / 低频滥用 | medium | 4.0-6.9 |

- **资金面一律 critical**（哪怕 CVSS 算出来 8.x），并在条目里写明"可影响资金状态"。
- CVSS 只是参考值，条目里的 severity 以本表口径为准；两者冲突时以本表为准并改 cvss。

## 看到什么翻哪一类

| 目标特征 | 翻这个技能 |
| --- | --- |
| `Server: nginx` + PHP/WordPress/ThinkPHP 指纹 | `kb-web-cms` |
| Spring / Actuator / Shiro / Tomcat / Weblogic / 若依 | `kb-java-web` |
| 反序列化回显、`rememberMe=`、`Content-Type: application/x-java-serialized-object` | `kb-java-deser` |
| Docker 2375 / Redis / Mongo / Nexus / vCenter / ESXi / runc | `kb-cloud-container` |
| Fortinet / F5 / Citrix / Pulse / Ivanti / VPN 网关 | `kb-edge-device` |
| Exchange / 域内 / Kerberos / AD CS / DCSync | `kb-exchange-ad` |
| 拿到低权 shell（`www-data`/容器内 root） | `kb-linux-priv` |
| 博彩/跑分/发卡站，资金与后台接口，无 CVE 可套 | `kb-gray-market` |

对不上任何一类，就先当"未知"，回到指纹步骤再取一轮 banner，别硬套。

## 每轮走完这四步（不许停在单阶段）

1. **指纹**：`curl -I`、banner、`/actuator/env`、favicon 哈希 —— 拿到能定位版本的东西；
2. **选条目**：打开对应 `kb-*` 的 SKILL.md，在「条目」表里挑一条（版本区间对得上、优先 critical）；
3. **验证**：`read` 那条文件的「判定 / 利用」段，先做只读验证；命中再往前走；
4. **记账**：命令 + 原始响应写进下面说的落点，然后回第 1 步。

一次只推一格。**没有第 3 步的验证，就别写 `verified: true`** —— 写了自己也会被三个月后的自己当成事实。

## 报告落到哪

- **装了 redteam 模块**（`redteam_vuln_add` / `redteam_asset_add` / `redteam_score_report` 可用）→ 直接写库，
  报告用 `redteam_score_report` 生成，原始请求用 `redteam_http_evidence_add` 存；
- **没装** → 落 `docs/redteam/<日期>.md`，结构照 `report-template.md`；
- 两种情况都遵守：证据只放最小必要片段（脱敏），别把凭据、证件、身份证号贴进去。

## 两个真实踩过的坑

- **版本别硬套**：同一 CVE 在 2.4.49 与 2.4.50 上是两回事，差一个小版本就可能只有一半利用面。
- **写 JSON 文件用 UTF-8**：Windows 的 PowerShell 默认按 GBK 落盘，中文会变成 `?`；`Invoke-RestMethod` /
  写文件时显式传 `[Text.Encoding]::UTF8.GetBytes(...)`，或干脆用 node/bash 写。
