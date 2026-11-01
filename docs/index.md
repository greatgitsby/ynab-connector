---
title: YNAB Connector
---

# YNAB Connector

A remote MCP server that lets your AI assistant read and edit your YNAB
(You Need A Budget) data. It can categorize and approve imported
transactions, split a receipt across categories, move money between
categories, and report on spending, income, and net worth over time.

It works with any MCP client that supports remote servers with OAuth. Add
this URL as a remote MCP server (some clients call it a custom connector):

```
https://ynab.mcp.moen.ai/mcp
```

Your client then walks you through authorizing the connector against your YNAB
account.

On Claude.ai, you can [add it in one click](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=YNAB&connectorUrl=https%3A%2F%2Fynab.mcp.moen.ai%2Fmcp)

- Source: <https://github.com/greatgitsby/ynab-connector>
- [Privacy policy](./privacy-policy)

## Disclaimer

We are not affiliated, associated, or in any way officially connected with
YNAB or any of its subsidiaries or affiliates. The official YNAB website is
<https://www.ynab.com>. The names YNAB and You Need A
Budget, as well as related names, tradenames, marks, trademarks, emblems,
and images are registered trademarks of YNAB.
