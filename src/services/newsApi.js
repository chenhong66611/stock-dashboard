/**
 * 新闻模块
 * 数据源：东财搜索接口 search-api-web.eastmoney.com（JSONP格式，无需CORS）
 * 功能：按关键词拉取最新新闻 + 利好/利空自动标签（标签逻辑在 analysisCore.js 共用）
 */

import { tagNews, cleanTitle } from './analysisCore.js'

export { tagNews, cleanTitle }

/**
 * JSONP 拉取新闻（东财接口无CORS头，用script标签绕过）
 * @param {string} keyword 关键词
 * @param {number} pageSize 条数
 */
export function fetchNewsJsonp(keyword, pageSize = 5, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cbName = 'emcb_' + Math.random().toString(36).slice(2)
    const param = JSON.stringify({
      uid: '',
      keyword,
      type: ['cmsArticleWebOld'],
      client: 'web',
      clientType: 'web',
      clientVersion: 'curr',
      param: {
        cmsArticleWebOld: {
          searchScope: 'default',
          sort: 'default',
          pageIndex: 1,
          pageSize,
          preTag: '<em>',
          postTag: '</em>',
        },
      },
    })
    const script = document.createElement('script')
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); reject(new Error('新闻请求超时')) }
    }, timeout)

    function cleanup() {
      try { delete window[cbName] } catch { window[cbName] = undefined }
      script.remove()
      clearTimeout(timer)
    }

    window[cbName] = (data) => {
      if (done) return
      done = true
      cleanup()
      resolve(data)
    }
    script.onerror = () => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('新闻请求失败'))
    }
    script.src = `https://search-api-web.eastmoney.com/search/jsonp?cb=${cbName}&param=${encodeURIComponent(param)}`
    document.head.appendChild(script)
  })
}

/**
 * 拉取并处理新闻列表
 * @returns [{title, date, source, tag, url}]
 */
export async function fetchNews(keyword, pageSize = 5) {
  const data = await fetchNewsJsonp(keyword, pageSize)
  const articles = data?.result?.cmsArticleWebOld || []
  return articles.map(a => ({
    title: cleanTitle(a.title),
    date: (a.date || '').slice(5, 16), // MM-DD HH:mm
    source: a.mediaName || '',
    tag: tagNews(a.title),
    url: a.url || '',
  }))
}

/**
 * 批量拉新闻：大盘（A股）+ 重点标的
 * @param {string[]} keywords ['A股', '科创50', ...]
 */
export async function fetchNewsAll(keywords) {
  const tasks = keywords.map(async kw => {
    try {
      const list = await fetchNews(kw, 3)
      return { keyword: kw, list }
    } catch (e) {
      return { keyword: kw, list: [] }
    }
  })
  const results = await Promise.all(tasks)
  // 挑重点：只保留有内容的，按关键词顺序
  return results.filter(r => r.list.length)
}
