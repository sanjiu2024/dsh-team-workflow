---
name: ai-search
description: "Use when 需要查最新资料、外部事实、论文或某个库的现状，而 web_search / web_fetch 不可用时。走 dsh-team search 调远程 AI 搜索，拿到带引用的答案。"
---

# AI 搜索

`web_search` / `web_fetch` 在本机经常挂（代理拒连）。需要查外部事实时用这个。

## 用法

```bash
node bin/dsh-team.mjs search "SearXNG 是什么" --limit 5
node bin/dsh-team.mjs search "RAG 的最新进展" --limit 6 --json
```

需要两个环境变量（**不进仓库**，那台服务器是私人的）：

```bash
DSH_SEARCH_URL=http://127.0.0.1:8200     # 搜索服务地址
DSH_SEARCH_TOKEN=<令牌>                   # 服务端没配 Token 时可省略
```

## 输出

```
（带 [1] [2] [3] 标注的中文答案）

来源：
[1] 标题
    https://...
```

**引用编号直接对应「来源」列表的顺序**——写进你的回答时保留 `[n]`，别改编号，也别引用列表里没有的编号。

## 底层是什么

- 检索：Tavily 免 key（主力，稳）+ SearXNG（`cn.bing.com` 直连 + arxiv / crossref / openalex / pubmed 学术引擎）
- 生成：OpenCode Go `deepseek-v4.1-flash`（走 `oc-proxy` 补 session 头）
- 一次调用约 10–20 秒、16000 token 量级

## 什么时候别用

- **本机文件、仓库内代码** → 用 `grep` / `glob` / `read`，别浪费一次搜索
- **连续追问同一个话题** → 一次搜够就用，不要每问一句搜一次
- **答案你已经确定** → 直接答，搜索是为了拿到你不知道或会过期的外部事实

## 出问题怎么排查

```bash
curl -s $DSH_SEARCH_URL/health          # {"ok":true,...}
dsh-team search "test" --json           # 看原始返回，error 字段会说明是检索还是生成挂了
```

- `连不上搜索服务` → 服务没起，或隧道断了
- `搜索服务返回 401` → 令牌不对
- `没有生成答案` → 检索到了但模型没输出，通常是把 max_tokens 耗在思考上，重试一次即可
