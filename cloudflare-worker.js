/**
 * Cloudflare Worker — A股行情 API 代理
 *
 * 部署方式：https://dash.cloudflare.com → Workers & Pages → 创建 Worker
 * 复制本文件全部内容粘贴即可，无需任何配置。
 *
 * 部署后得到 URL 如：https://stock-proxy.xxx.workers.dev
 */

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname + url.search

    // 转发到腾讯股票 API
    const target = `https://qt.gtimg.cn${path}`

    try {
      const resp = await fetch(target)
      const text = await resp.text()

      return new Response(text, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain; charset=gbk',
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    }
  },
}
